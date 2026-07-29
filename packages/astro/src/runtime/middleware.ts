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

  // Sliding expiry: when `validateSession` extends the stored expiry it has only updated the row,
  // so the cookie has to be re-issued or the browser still drops it at the original 30-day mark
  // and an active user is signed out mid-task. There is no response to write to until `next()`
  // has run, hence deferring the header rather than setting it here.
  let refreshedCookie: string | null = null;

  if (token) {
    const session = await validateSession(taproot.db.db, token);
    if (session) {
      taproot.user = session.user;
      taproot.sessionToken = token;

      if (session.refreshed) {
        refreshedCookie = buildSessionCookie(token, session.expiresAt, {
          secure: taproot.auth.secureCookies,
        });
      }
    }
  }

  (context.locals as { taproot: typeof taproot }).taproot = taproot;

  const response = await next();
  if (refreshedCookie) {
    response.headers.append('set-cookie', refreshedCookie);
  }
  return response;
});
