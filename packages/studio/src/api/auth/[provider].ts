import type { APIContext } from 'astro';
import { createOAuthProvider, type OAuthProviderName } from '@taproot/core';

import { apiError, mapError } from '../_shared.js';
import { getTaproot } from '../../runtime/guards.js';

const PROVIDERS = new Set<OAuthProviderName>(['google', 'github', 'microsoft']);

/**
 * Start an OAuth flow.
 *
 * The `state` and PKCE verifier are stashed in short-lived HttpOnly cookies and checked on the way
 * back. `state` is what makes the callback resistant to CSRF — without it, an attacker could feed
 * a victim's browser their own authorization code and link the wrong account.
 */
export async function GET(context: APIContext): Promise<Response> {
  try {
    const taproot = getTaproot(context.locals);
    const name = context.params.provider as OAuthProviderName;

    if (!PROVIDERS.has(name)) {
      return apiError(404, `Unknown authentication provider "${String(name)}".`);
    }

    const provider = createOAuthProvider(taproot.auth, name);
    if (!provider) {
      return apiError(
        404,
        `${name} sign-in is not configured. Set the client id and secret for it — see DEPLOYMENT.md.`,
      );
    }

    const { url, state, codeVerifier } = provider.createAuthorization();
    const secure = taproot.auth.secureCookies;

    context.cookies.set(`taproot_oauth_state_${name}`, state, {
      path: '/',
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: 60 * 10,
    });

    if (codeVerifier) {
      context.cookies.set(`taproot_oauth_verifier_${name}`, codeVerifier, {
        path: '/',
        httpOnly: true,
        secure,
        sameSite: 'lax',
        maxAge: 60 * 10,
      });
    }

    return context.redirect(url.toString(), 302);
  } catch (error) {
    return mapError(error);
  }
}
