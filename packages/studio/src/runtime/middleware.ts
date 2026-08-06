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
import { purgeSite, sitePurgeConfig } from './sitePurge.js';
import { purgeInvalidated } from './purge.js';
import { applyDefaultCacheControl } from './responseCache.js';

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

  /**
   * Stamped before anything else touches the response, and before the session cookie below.
   *
   * A refreshed session cookie riding on a response a shared cache is willing to store is the worst
   * version of this bug — the leak stops being "somebody reads the admin" and becomes "somebody is
   * handed a live session". Going first means there is no ordering in which a `set-cookie` exists on
   * a response that has not already been marked unstorable.
   *
   * The return value is load-bearing: an immutable-headers response comes back rebuilt, and the
   * `append` below would have thrown on the original.
   */
  const response = applyDefaultCacheControl(await next());

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
  await purgeInvalidated(context.locals, taproot.invalidated, { db: taproot.db.db });

  /**
   * And the consumer's cache, which this deployment cannot reach any other way.
   *
   * `ctx.cache.purge()` above clears the CMS's own cached JSON; the site holds HTML rendered *from*
   * that JSON in a cache Cloudflare scopes to the site's own Worker. Without this call a published
   * page reaches visitors only when the site's `s-maxage` lapses.
   *
   * Handed to `waitUntil` where the runtime offers one. An editor pressing Save must not wait on an
   * HTTP round trip to another origin, and the response is already built — but the request must
   * still outlive the response, which is exactly what `waitUntil` is for. Where it is absent
   * (`npm run dev`) it is awaited, which is fine: there is no consumer configured there either.
   */
  /**
   * `env` from `readRuntimeEnv`, **never `process.env`**.
   *
   * `readRuntimeEnv` reads the `cloudflare:workers` env first and folds `process.env` in only as a
   * Node fallback, so it is correct on both runtimes by construction. `process.env` happens to work
   * on Workers too — `nodejs_compat` populates it from the bindings — but that is a compatibility
   * behaviour rather than this project's contract, and every other runtime read here already goes
   * through `readRuntimeEnv`. One source, so a deployment cannot be configured in a way only half
   * the code can see.
   */
  const site = sitePurgeConfig(env);
  if (site && taproot.invalidated.size > 0) {
    const sending = purgeSite(site, taproot.invalidated, { db: taproot.db.db });
    const ctx = (context.locals as { cfContext?: { waitUntil?: (p: Promise<unknown>) => void } })
      .cfContext;

    if (ctx?.waitUntil) ctx.waitUntil(sending);
    else await sending;
  }

  return response;
});
