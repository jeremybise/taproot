import { GitHub, Google, MicrosoftEntraId, generateCodeVerifier, generateState } from 'arctic';

import type { AuthConfig } from './config.js';

/**
 * A uniform façade over Arctic's providers.
 *
 * Arctic's provider classes have deliberately different signatures — Google and Entra take a PKCE
 * verifier, GitHub does not; Entra's constructor takes a tenant first. Normalising here means the
 * route handlers have one code path instead of a switch, and adding a provider later touches only
 * this file.
 */

export type OAuthProviderName = 'google' | 'github' | 'microsoft';

export interface OAuthProfile {
  providerUserId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface AuthorizationRequest {
  url: URL;
  state: string;
  /** Absent for providers that do not use PKCE (GitHub). */
  codeVerifier?: string;
}

export interface OAuthProvider {
  name: OAuthProviderName;
  createAuthorization(): AuthorizationRequest;
  fetchProfile(code: string, codeVerifier?: string): Promise<OAuthProfile>;
}

export function getConfiguredProviders(config: AuthConfig): OAuthProviderName[] {
  return (['google', 'github', 'microsoft'] as const).filter((name) => config.providers[name]);
}

export function createOAuthProvider(
  config: AuthConfig,
  name: OAuthProviderName,
): OAuthProvider | undefined {
  const settings = config.providers[name];
  if (!settings) return undefined;

  const redirectUri = `${config.origin.replace(/\/$/, '')}/api/taproot/auth/callback/${name}`;

  switch (name) {
    case 'google': {
      const client = new Google(settings.clientId, settings.clientSecret, redirectUri);
      return {
        name,
        createAuthorization() {
          const state = generateState();
          const codeVerifier = generateCodeVerifier();
          return {
            url: client.createAuthorizationURL(state, codeVerifier, ['openid', 'profile', 'email']),
            state,
            codeVerifier,
          };
        },
        async fetchProfile(code, codeVerifier) {
          const tokens = await client.validateAuthorizationCode(code, codeVerifier ?? '');
          const claims = decodeJwtPayload(tokens.idToken());
          return {
            providerUserId: String(claims.sub),
            email: String(claims.email ?? ''),
            name: String(claims.name ?? claims.email ?? 'Unknown'),
            avatarUrl: claims.picture ? String(claims.picture) : null,
          };
        },
      };
    }

    case 'github': {
      const client = new GitHub(settings.clientId, settings.clientSecret, redirectUri);
      return {
        name,
        createAuthorization() {
          const state = generateState();
          return { url: client.createAuthorizationURL(state, ['read:user', 'user:email']), state };
        },
        async fetchProfile(code) {
          const tokens = await client.validateAuthorizationCode(code);
          const accessToken = tokens.accessToken();
          const headers = {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'taproot-cms',
          };

          const profile = (await fetchJson('https://api.github.com/user', headers)) as {
            id: number;
            login: string;
            name: string | null;
            email: string | null;
            avatar_url: string | null;
          };

          // GitHub omits the email from /user unless it is public, so ask for the verified primary.
          let email = profile.email;
          if (!email) {
            const emails = (await fetchJson('https://api.github.com/user/emails', headers)) as {
              email: string;
              primary: boolean;
              verified: boolean;
            }[];
            email = emails.find((e) => e.primary && e.verified)?.email ?? null;
          }

          if (!email) {
            throw new OAuthProfileError(
              'GitHub did not return a verified email address. Add and verify an email on your ' +
                'GitHub account, or sign in with a different provider.',
            );
          }

          return {
            providerUserId: String(profile.id),
            email,
            name: profile.name ?? profile.login,
            avatarUrl: profile.avatar_url,
          };
        },
      };
    }

    case 'microsoft': {
      const client = new MicrosoftEntraId(
        settings.tenant ?? 'common',
        settings.clientId,
        settings.clientSecret,
        redirectUri,
      );
      return {
        name,
        createAuthorization() {
          const state = generateState();
          const codeVerifier = generateCodeVerifier();
          return {
            url: client.createAuthorizationURL(state, codeVerifier, ['openid', 'profile', 'email']),
            state,
            codeVerifier,
          };
        },
        async fetchProfile(code, codeVerifier) {
          const tokens = await client.validateAuthorizationCode(code, codeVerifier ?? '');
          const claims = decodeJwtPayload(tokens.idToken());
          const email = String(claims.email ?? claims.preferred_username ?? '');
          return {
            providerUserId: String(claims.sub ?? claims.oid),
            email,
            name: String(claims.name ?? email ?? 'Unknown'),
            avatarUrl: null,
          };
        },
      };
    }

    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown OAuth provider: ${String(exhaustive)}`);
    }
  }
}

export class OAuthProfileError extends Error {
  override name = 'OAuthProfileError';
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new OAuthProfileError(`Request to ${url} failed with ${response.status}.`);
  }
  return response.json();
}

/**
 * Read the claims out of an ID token.
 *
 * The signature is intentionally not verified here: the token came directly from the provider's
 * token endpoint over TLS in response to our own client-authenticated request, so it has not
 * passed through the user. Tokens arriving by any other route must not be decoded with this.
 */
function decodeJwtPayload(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1];
  if (!payload) throw new OAuthProfileError('Malformed ID token.');

  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');

  try {
    return JSON.parse(new TextDecoder().decode(base64ToBytes(padded))) as Record<string, unknown>;
  } catch {
    throw new OAuthProfileError('Could not decode the ID token payload.');
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
