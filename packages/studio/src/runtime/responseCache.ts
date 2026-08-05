/**
 * The default `cache-control` for anything that did not ask for one.
 *
 * Its own module for the reason `purge.ts` is: `middleware.ts` imports `astro:middleware`, which
 * does not resolve under vitest, and this is a security boundary that has to be testable.
 */

/**
 * Caching is opt-in, and the default is "never store this".
 *
 * **A shared cache keyed on the URL cannot be allowed near a session-rendered page.** Every admin
 * screen is server-rendered *after* an auth check, so its HTML is the signed-in view — item titles,
 * ids, paths, user lists, the audit log. Sending no `cache-control` left that decision to
 * Cloudflare, and with `"cache": { "enabled": true }` in `wrangler.jsonc` the edge stored a
 * signed-in admin's 200 and served it to anonymous requests: measured as `CF-Cache-Status: HIT`,
 * `Age: 437`, on a request carrying no cookie at all. The origin was never wrong — it 302s an
 * unauthenticated request to the login screen, and still does. The cache in front of it was
 * answering before the origin was consulted.
 *
 * So the rule is inverted from where it was. A response that says nothing about caching is the one
 * most likely never to have thought about it, which makes "no header" the wrong thing to treat as
 * permission. This mirrors the split `handle()` and `handleScoped()` already draw for API keys: a
 * route that says nothing about a capability does not get it.
 *
 * **A route that genuinely is cacheable sets its own header and this leaves it alone** — the
 * delivery API (`public, max-age=0, s-maxage=…` plus its own `vary`), and
 * `/api/taproot/media/file/[...key]` (`immutable`). Both are deliberate and both are unauthenticated
 * or key-scoped by design.
 *
 * `no-store` rather than `private`: `private` still permits a *browser* to keep the page, which on a
 * shared machine is the same leak one step down. `private` is kept alongside it because an
 * intermediary that ignores `no-store` may still honour `private`, and neither costs anything.
 *
 * Static assets never reach here — `@astrojs/cloudflare`'s handler answers `matchStaticAsset` before
 * the Astro app renders, so hashed `/_astro/*` files keep their own long-lived caching and this
 * cannot regress them.
 */
export const DEFAULT_CACHE_CONTROL = 'private, no-store';

/**
 * Stamp the default onto a response that expressed no preference.
 *
 * Deliberately checks `has` rather than overwriting: the point is to close the gap left by silence,
 * not to override a route that made a decision. Overwriting would break delivery caching, which is
 * the one thing here that is *supposed* to be stored.
 *
 * **Returns a response rather than mutating in place, because some responses cannot be mutated.**
 * `Response.redirect()` builds its headers with the spec's *immutable* guard and `headers.set`
 * throws `TypeError: immutable` on one — and Astro uses it for configured redirects
 * (`core/redirects/render.js`). Letting that throw would fail the request from middleware, which is
 * the exact shape of the `runtime.ctx` bug this release also fixes; skipping silently would leave
 * the redirect unmarked, which is failing open on a security control. Rebuilding does neither.
 *
 * The caller must use the return value. That is also what makes appending a refreshed session
 * cookie safe on a redirect, which mutating in place never was.
 */
export function applyDefaultCacheControl(response: Response): Response {
  if (response.headers.has('cache-control')) return response;

  try {
    response.headers.set('cache-control', DEFAULT_CACHE_CONTROL);
    return response;
  } catch {
    // Immutable headers. Rebuild with a mutable copy rather than give up on the header.
  }

  try {
    const headers = new Headers(response.headers);
    headers.set('cache-control', DEFAULT_CACHE_CONTROL);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    /**
     * Nothing known reaches here — a null-body status carrying a body would, and no such response
     * exists in this codebase. It is logged rather than thrown for the reason `purgeInvalidated`
     * states: a middleware that throws turns a header problem into a failed request, and the
     * request itself was fine. Loud, because failing open on this one is worth knowing about.
     */
    console.error('[taproot] could not apply the default cache-control', error);
    return response;
  }
}
