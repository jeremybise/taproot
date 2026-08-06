/**
 * This site's cache headers, in one place.
 *
 * Four routes set the same header and each held its own copy of the string, which is exactly how a
 * caching policy drifts: the pages added later kept the number and quietly dropped the `no-store`
 * branch that protects previews. One constant and one helper is the whole fix.
 *
 * The numbers are the site's to choose — Taproot has no say in how long a consumer caches HTML it
 * rendered. What makes a long TTL safe here is the purge callback at `/taproot/purge`: the CMS
 * clears this cache when content changes, so the TTL is a backstop for a purge that never arrived
 * rather than the mechanism that keeps the site fresh.
 */

/**
 * A day, matching the delivery API's own `s-maxage`.
 *
 * **No `stale-while-revalidate`.** Cloudflare disables stale-serving whenever `s-maxage` is present,
 * so adding it here would be inert — and the alternative, using `max-age` as the freshness window
 * to get it, would let a *visitor's browser* hold a page for a day. A purge cannot reach a browser.
 */
export const PAGE_CACHE_CONTROL = 'public, max-age=0, s-maxage=86400';

/**
 * Short, because a 404 is the answer most likely to stop being true.
 *
 * It becomes a real page the moment somebody publishes at that path. A purge covers that too, but
 * the cheap bound costs nothing and this is the one wrong answer a visitor is most likely to meet.
 */
export const NOT_FOUND_CACHE_CONTROL = 'public, max-age=0, s-maxage=30';

/**
 * What a response carrying a preview token must say, whatever else the route decides.
 *
 * A preview renders unpublished content, and a shared cache holding it would serve a draft to
 * somebody with no token at all. The CMS already answers `no-store` on the delivery response; this
 * is the *site's* own HTML, on a different origin, and nothing upstream can set a header on it.
 */
export const PREVIEW_CACHE_CONTROL = 'no-store';

/** The header for a rendered page, which is `no-store` whenever a preview token is in play. */
export function pageCacheControl(previewToken: string | null | undefined): string {
  return previewToken ? PREVIEW_CACHE_CONTROL : PAGE_CACHE_CONTROL;
}
