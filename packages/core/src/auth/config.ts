/**
 * Auth configuration, resolved once at startup.
 *
 * The scope doc asks for two things that pull against each other: OAuth-only authentication, and
 * `npm run dev` working with no setup beyond `npm install`. OAuth needs real provider credentials,
 * which a fresh clone does not have.
 *
 * The resolution is a dev-only email/password provider that **cannot** be switched on in
 * production. `resolveAuthConfig` throws at boot rather than silently degrading, because a
 * password backdoor that is meant to be off and quietly is not is precisely the kind of bug that
 * survives to production.
 */

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  /** Entra only. */
  tenant?: string;
}

export interface AuthConfig {
  /** Absolute origin used to build OAuth redirect URIs, e.g. `https://cms.example.edu`. */
  origin: string;
  /** True only in local development with `TAPROOT_DEV_AUTH=1`. */
  devCredentialsEnabled: boolean;
  /** `Secure` is dropped for local HTTP, where the browser would otherwise discard the cookie. */
  secureCookies: boolean;
  providers: {
    google?: OAuthProviderConfig;
    github?: OAuthProviderConfig;
    microsoft?: OAuthProviderConfig;
  };
}

export interface AuthEnv {
  NODE_ENV?: string;
  TAPROOT_DEV_AUTH?: string;
  TAPROOT_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_TENANT?: string;
}

export class AuthConfigError extends Error {
  override name = 'AuthConfigError';
}

export function resolveAuthConfig(env: AuthEnv): AuthConfig {
  const isDevelopment = (env.NODE_ENV ?? 'development') === 'development';
  const devAuthRequested = env.TAPROOT_DEV_AUTH === '1';

  // The guard that matters: refuse to start rather than run a password backdoor in production.
  if (devAuthRequested && !isDevelopment) {
    throw new AuthConfigError(
      'TAPROOT_DEV_AUTH=1 is set but NODE_ENV is not "development". The development credential ' +
        'provider is a local-only convenience and must never be enabled in a deployed ' +
        'environment. Unset TAPROOT_DEV_AUTH and configure an OAuth provider instead.',
    );
  }

  const devCredentialsEnabled = isDevelopment && devAuthRequested;

  const providers: AuthConfig['providers'] = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    };
  }
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
    providers.microsoft = {
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      tenant: env.MICROSOFT_TENANT ?? 'common',
    };
  }

  // A deployed instance with no way in at all is a configuration error worth catching at boot.
  if (!devCredentialsEnabled && Object.keys(providers).length === 0 && !isDevelopment) {
    throw new AuthConfigError(
      'No authentication method is configured. Set at least one OAuth provider ' +
        '(GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET, or MICROSOFT_CLIENT_ID/SECRET). ' +
        'See DEPLOYMENT.md.',
    );
  }

  return {
    origin: env.TAPROOT_ORIGIN ?? 'http://localhost:4321',
    devCredentialsEnabled,
    secureCookies: !isDevelopment,
    providers,
  };
}
