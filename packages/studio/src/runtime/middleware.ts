import { defineMiddleware } from 'astro:middleware';
import {
  SESSION_COOKIE_NAME,
  bearerToken,
  buildSessionCookie,
  touchApiKey,
  validateSession,
  verifyApiKey,
} from '@taprootcms/core';

import { createContext, readRuntimeEnv } from './context.js';
import { apiKeyPrincipal, userPrincipal } from './guards.js';

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
      taproot.principal = userPrincipal(session.user);
      taproot.sessionToken = token;

      if (session.refreshed) {
        refreshedCookie = buildSessionCookie(token, session.expiresAt, {
          secure: taproot.auth.secureCookies,
        });
      }
    }
  }

  /**
   * An API key, only when no session resolved.
   *
   * Session first, and never both. A request carrying a valid cookie *and* a bearer token is
   * somebody's browser hitting an API route while signed in, and the person is the more specific
   * answer to "who is asking" — letting the key win would attribute their action to a machine in
   * the audit log. `taproot.user` stays undefined for a key, which is what makes every existing
   * role guard fail closed without knowing keys exist.
   */
  if (!taproot.principal) {
    const presented = bearerToken(context.request.headers.get('authorization'));
    if (presented) {
      const key = await verifyApiKey(taproot.db.db, presented);
      if (key) {
        taproot.principal = apiKeyPrincipal(key);
        // Not awaited into the critical path any more than it has to be; `touchApiKey` writes at
        // most once a minute and never throws.
        await touchApiKey(taproot.db.db, key);
      }
    }
  }

  (context.locals as { taproot: typeof taproot }).taproot = taproot;

  const response = await next();
  if (refreshedCookie) {
    response.headers.append('set-cookie', refreshedCookie);
  }

  /**
   * Purge after the response, which is after the write committed.
   *
   * The ordering is the correctness property, and it is the same one `batchWrite` enforces for
   * reads: purging inside a write path would clear the cache while the old row was still the
   * committed one, so a request arriving in between would repopulate the cache with exactly the
   * content the purge was meant to remove. There is no lock to take here — only an order.
   */
  await purgeInvalidated(context, taproot.invalidated);

  return response;
});

/**
 * Clear cached responses carrying any of these tags.
 *
 * **Never throws, and never fails the request** — the same rule `recordAuditEntry` follows, and for
 * the same reason: the write this describes has already happened and already been reported as
 * successful. Turning a cache-maintenance problem into a 500 would tell an editor their save failed
 * when it did not, and they would do it again. A purge that does not land costs staleness bounded by
 * `s-maxage`, which is exactly the behaviour every deployment had before tags existed.
 *
 * The API lives on the request's `ExecutionContext` and exists only under Workers Caching. Under
 * `npm run dev` there is no Cloudflare cache to purge and nothing here runs, which is correct rather
 * than degraded: nothing cached the response either.
 */
async function purgeInvalidated(
  context: { locals: unknown },
  tags: Set<string>,
): Promise<void> {
  if (tags.size === 0) return;

  const cache = (
    context.locals as {
      runtime?: { ctx?: { cache?: { purge?: (options: { tags: string[] }) => Promise<unknown> } } };
    }
  ).runtime?.ctx?.cache;

  if (!cache?.purge) return;

  try {
    await cache.purge({ tags: [...tags] });
  } catch (error) {
    console.error('[taproot] failed to purge cache tags', error);
  }
}
