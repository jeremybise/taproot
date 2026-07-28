import { defineMiddleware } from 'astro:middleware';
import {
  SESSION_COOKIE_NAME,
  buildSessionCookie,
  validateSession,
} from '@taproot/core';

import { createContext, readRuntimeEnv } from './context.js';

/**
 * Builds the Taproot context for every request and resolves the session.
 *
 * Running as middleware rather than per-page means an admin page's frontmatter can do a plain
 * `if (!user) return redirect(...)` — the auth check happens before any HTML is produced, which is
 * the main reason the admin is server-rendered Astro pages rather than a client-side SPA.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const { env, bindings } = await readRuntimeEnv();

  const taproot = await createContext(env, bindings);
  const token = context.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (token) {
    const session = await validateSession(taproot.db.db, token);
    if (session) {
      taproot.user = session.user;
      taproot.sessionToken = token;

      // Sliding expiry: re-issue the cookie when the session was extended so an active user is
      // never signed out mid-task.
      if (session.refreshed) {
        context.response?.headers?.append?.(
          'set-cookie',
          buildSessionCookie(token, session.expiresAt, { secure: taproot.auth.secureCookies }),
        );
      }
    }
  }

  (context.locals as { taproot: typeof taproot }).taproot = taproot;

  return next();
});
