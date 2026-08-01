import type { APIContext } from 'astro';
import {
  buildSessionCookie,
  createOAuthProvider,
  createSession,
  upsertOAuthUser,
  type OAuthProviderName,
} from '@taproot/core';

import { apiError, mapError } from '../../_shared.js';
import { getTaproot } from '../../../runtime/guards.js';

const PROVIDERS = new Set<OAuthProviderName>(['google', 'github', 'microsoft']);

/**
 * Complete an OAuth flow.
 *
 * The `state` returned by the provider must match the one stashed when the flow started; a
 * mismatch means the request did not originate from this site's login page and is rejected.
 */
export async function GET(context: APIContext): Promise<Response> {
  try {
    const taproot = getTaproot(context.locals);
    const name = context.params.provider as OAuthProviderName;

    if (!PROVIDERS.has(name)) {
      return apiError(404, `Unknown authentication provider "${String(name)}".`);
    }

    const url = new URL(context.request.url);
    const providerError = url.searchParams.get('error');
    if (providerError) {
      return failLogin(context, `${name} sign-in was cancelled or denied (${providerError}).`);
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const expectedState = context.cookies.get(`taproot_oauth_state_${name}`)?.value;
    const codeVerifier = context.cookies.get(`taproot_oauth_verifier_${name}`)?.value;

    // Clear the one-shot cookies immediately so a replay cannot reuse them.
    context.cookies.delete(`taproot_oauth_state_${name}`, { path: '/' });
    context.cookies.delete(`taproot_oauth_verifier_${name}`, { path: '/' });

    if (!code || !state || !expectedState || state !== expectedState) {
      return failLogin(context, 'Sign-in could not be verified. Please try again.');
    }

    const provider = createOAuthProvider(taproot.auth, name);
    if (!provider) return apiError(404, `${name} sign-in is not configured.`);

    const profile = await provider.fetchProfile(code, codeVerifier);
    if (!profile.email) {
      return failLogin(context, `${name} did not provide an email address for this account.`);
    }

    // A first OAuth user on an empty install becomes the admin — otherwise a fresh deployment has
    // no way to grant anyone access. Subsequent users start as viewers and are promoted by an admin.
    const isFirstUser =
      Number(
        (
          await taproot.db.db
            .selectFrom('users')
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .executeTakeFirst()
        )?.count ?? 0,
      ) === 0;

    const user = await upsertOAuthUser(taproot.db.db, {
      provider: name,
      providerUserId: profile.providerUserId,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      defaultRole: isFirstUser ? 'admin' : 'viewer',
    });

    if (!user.is_active) {
      return failLogin(context, 'This account has been deactivated.');
    }

    const { token, expiresAt } = await createSession(taproot.db.db, user.id);
    const response = context.redirect('/admin', 303);
    response.headers.append(
      'set-cookie',
      buildSessionCookie(token, expiresAt, { secure: taproot.auth.secureCookies }),
    );
    return response;
  } catch (error) {
    return mapError(error);
  }
}

function failLogin(context: APIContext, message: string): Response {
  return context.redirect(`/admin/login?error=${encodeURIComponent(message)}`, 303);
}
