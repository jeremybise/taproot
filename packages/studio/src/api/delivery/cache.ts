/**
 * ETags and cache headers for delivery responses.
 *
 * The embedded route caches with a blind `s-maxage=60` — a deliberate interim, recorded in SCOPE as
 * something that could not be improved until there was a cache boundary to improve it *against*.
 * There is one now: the consumer fetches over HTTP, so a validator saves a payload rather than a
 * database query.
 *
 * The tag is built from the item's id, its `updated_at`, **and a stamp for the reusable-block
 * library**. The first two cover every path that changes what a page renders through its own row —
 * an edit, a publish, a status change, a cascading move, a release applying a staged version — all
 * of which go through `updateItem`, which stamps it.
 *
 * The third closes the one hole, and the hole was not what this file used to claim. It read: a
 * library edit "changes the page's rendered content without touching the page's row, so a client
 * holding a validator would keep the old copy until `s-maxage` lapsed. Sixty seconds is the bound
 * on that staleness."
 *
 * **There was no such bound.** When a cached copy's TTL lapses a shared cache *revalidates* rather
 * than refetching: it sends `if-none-match`, this file answers 304 because `updated_at` has not
 * moved, and RFC 9111 §4.3.4 says a 304 refreshes the stored response's freshness. So the copy is
 * served for another full TTL, and another — a validator that cannot change is not stale for sixty
 * seconds, it is stale forever. Confirmed against a live deployment, which answered
 * `304` to a tag whose page had been changed by a library edit.
 *
 * The old text was right that hashing the resolved payload is not the answer: that would mean
 * resolving the payload before answering a conditional request, which is the work the validator
 * exists to avoid. `reusableBlockLibraryVersion` is one aggregate over a small table instead, and
 * it is deliberately global rather than per page — see its own doc comment.
 */

import {
  SITE_TAG,
  cacheTagHeader,
  listContentTypes,
  normalizeCacheTags,
  typeTag,
  type Database,
} from '@taprootcms/core';
import type { Kysely } from 'kysely';

export interface DeliveryCache {
  etag: string;
  headers: Record<string, string>;
}

/**
 * Seconds a shared cache may serve a delivery response without revalidating.
 *
 * **A day, and the TTL is now the backstop rather than the mechanism.** It was sixty seconds for
 * as long as purging was incomplete — every write path either failed to invalidate or invalidated a
 * tag nothing carried, so the clock was doing all the correctness work and a site paid a re-render
 * on every page every minute to cover a handful of edits a day. With the tags repaired and a purge
 * that is retried rather than dropped, a lapse means "nothing has changed here for a day", which is
 * the ordinary case for most of a site.
 *
 * **No `stale-while-revalidate`, and that is not an oversight.** Cloudflare disables stale-serving
 * outright in the presence of `s-maxage`: "If your response includes any of `s-maxage`,
 * `must-revalidate`, or `proxy-revalidate`, the stale-serving behavior is disabled." Getting SWR
 * means using `max-age` as the freshness window instead — which would let a *browser* hold the
 * response for a day, and a purge cannot reach a browser. A rare blocking revalidation is strictly
 * better than a copy nothing can correct. Adding `stale-while-revalidate` beside `s-maxage` would
 * be inert, which is the worst of the three options because it looks like it works.
 */
export const SHARED_MAX_AGE = 86_400;

/**
 * The one spelling of the delivery cache header.
 *
 * Every listing route hardcoded this string while `SHARED_MAX_AGE` sat here governing only the
 * `resolve` route, so the constant described one endpoint and five others merely agreed with it by
 * hand. Raising the number would have moved one of them.
 */
export const DELIVERY_CACHE_CONTROL = `public, max-age=0, s-maxage=${SHARED_MAX_AGE}`;

/**
 * The tags a *listing* depends on, for `/items`, `/search` and the taxonomy terms endpoint.
 *
 * All three shipped with no `cache-tag` at all, which made them purgeable by nothing — invisible at
 * a sixty-second TTL and ruinous at a long one, because the site's own HTML being flushed just
 * makes it re-render against a listing the CMS is still caching. A newly published event would be
 * missing from the events index for as long as the TTL allowed.
 *
 * **`type:` rather than `item:`.** An item write purges both (`itemWriteTags`), and `type:` is the
 * one that covers an item this listing has never seen — which is the entire problem a listing has.
 * `itemWriteTags` already says so: "`type:` covers every page that listed the type without naming
 * this item, which is the only way a newly published item can appear in 'the six soonest events':
 * the cached copy of that listing names the six it had." The listing endpoints simply never emitted
 * the other half of that contract. Tagging each returned item instead would also be bounded by page
 * size rather than by how many types exist, and would still miss the newly published one.
 *
 * **Recorded even when nothing matched**, for the reason a `query` field records it: an empty
 * listing is the case most in need of invalidation and the one with no results to derive a tag
 * from.
 *
 * With no type filter a listing spans every type, so every type is named. That is one extra query
 * on a response that is cached by construction, and `listContentTypes` excludes blocks — which a
 * listing can never return anyway.
 */
export async function listingCacheTagHeader(
  db: Kysely<Database>,
  typeApiId?: string | null,
): Promise<string> {
  const apiIds = typeApiId
    ? [typeApiId]
    : (await listContentTypes(db)).map((contentType) => contentType.api_id);

  /**
   * Never empty, so the header is never absent: `SITE_TAG` is unconditional, which is what makes
   * the return a plain string rather than something every call site has to test before spreading.
   */
  return cacheTagHeader(normalizeCacheTags([SITE_TAG, ...apiIds.map(typeTag)])) ?? SITE_TAG;
}

export function deliveryCache(
  updatedAt: string,
  id: string,
  tags?: string[],
  /**
   * `reusableBlockLibraryVersion`, and **the same value on both paths or nothing works**.
   *
   * `resolve.ts` answers a conditional request from a cheap indexed lookup before resolving the
   * page, and builds the full response afterwards. Those two build a validator independently, so a
   * stamp read at different moments — or on one path and not the other — makes every conditional
   * request miss and answer 200. Resolve it once per request and hand the same number to both.
   */
  libraryVersion = 0,
): DeliveryCache {
  /**
   * A weak validator, and correctly so.
   *
   * `W/` states that two responses are semantically equivalent rather than byte-identical, which is
   * what this is claiming: the same item at the same version, serialised by whatever build is
   * running. A strong tag would be a promise about bytes that a formatting change quietly breaks.
   */
  const etag = `W/"${id}-${Date.parse(updatedAt) || 0}-${libraryVersion}"`;

  /**
   * The tags this response can be purged by, when the payload supplied any.
   *
   * This is what turns the TTL from the *only* correctness mechanism into a backstop, and the two
   * mechanisms cover different things. A `block:` tag makes a library edit visible *immediately*;
   * the library stamp in the validator above is what bounds it when a purge never arrives. Before
   * either existed a library edit had no bound at all. `type:` is the same story for a listing that
   * a *different* item's publish should change.
   */
  const cacheTag = tags ? cacheTagHeader(tags) : undefined;

  return {
    etag,
    headers: {
      etag,
      // `max-age=0` so a browser always revalidates, `s-maxage` so a shared cache absorbs the load.
      'cache-control': DELIVERY_CACHE_CONTROL,
      // The response varies by who is asking — a key with a different scope could see differently.
      vary: 'authorization',
      ...(cacheTag ? { 'cache-tag': cacheTag } : {}),
    },
  };
}

/**
 * A 304 when the client already holds this version, or `undefined` to send the body.
 *
 * `if-none-match` may carry several tags and a `W/` prefix that some intermediaries strip, so the
 * comparison is on the tag's contents rather than the raw header. Matching strictly would answer
 * 200 to a client that genuinely had the right version, which costs a payload and looks like the
 * cache not working.
 */
export function notModified(request: Request, etag: string): Response | undefined {
  const presented = request.headers.get('if-none-match');
  if (!presented) return undefined;

  const normalise = (value: string) => value.trim().replace(/^W\//, '');
  const matches = presented
    .split(',')
    .map(normalise)
    .some((candidate) => candidate === normalise(etag) || candidate === '*');

  if (!matches) return undefined;

  // A 304 carries no body and must repeat the validator, or the next request has nothing to send.
  return new Response(null, {
    status: 304,
    headers: {
      etag,
      'cache-control': DELIVERY_CACHE_CONTROL,
      vary: 'authorization',
    },
  });
}
