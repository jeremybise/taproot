/**
 * ETags and cache headers for delivery responses.
 *
 * The embedded route caches with a blind `s-maxage=60` — a deliberate interim, recorded in SCOPE as
 * something that could not be improved until there was a cache boundary to improve it *against*.
 * There is one now: the consumer fetches over HTTP, so a validator saves a payload rather than a
 * database query.
 *
 * The tag is built from the item's `updated_at` and its id. That is enough because every path that
 * changes what a page renders touches `updated_at`: an edit, a publish, a status change, a
 * cascading move, and a release applying a staged version — all of them go through `updateItem`,
 * which stamps it.
 *
 * The one thing it deliberately does **not** cover is a reusable block edited in the library. That
 * changes the page's rendered content without touching the page's row, so a client holding a
 * validator would keep the old copy until `s-maxage` lapsed. Sixty seconds is the bound on that
 * staleness, which is the same bound the embedded route already lived with — and hashing the whole
 * resolved payload to fix it would mean resolving the whole payload before answering a conditional
 * request, which is the work the validator exists to avoid.
 */

import { cacheTagHeader } from '@taprootcms/core';

export interface DeliveryCache {
  etag: string;
  headers: Record<string, string>;
}

/** Seconds a shared cache may serve a delivery response without revalidating. */
const SHARED_MAX_AGE = 60;

export function deliveryCache(updatedAt: string, id: string, tags?: string[]): DeliveryCache {
  /**
   * A weak validator, and correctly so.
   *
   * `W/` states that two responses are semantically equivalent rather than byte-identical, which is
   * what this is claiming: the same item at the same version, serialised by whatever build is
   * running. A strong tag would be a promise about bytes that a formatting change quietly breaks.
   */
  const etag = `W/"${id}-${Date.parse(updatedAt) || 0}"`;

  /**
   * The tags this response can be purged by, when the payload supplied any.
   *
   * This is what turns the TTL from the *only* correctness mechanism into a backstop. Sixty seconds
   * was chosen as the bound on how long a reusable block edit could go unnoticed, precisely because
   * an `updated_at` validator cannot see one; a `block:` tag can, and so can the `type:` tag that a
   * listing needs when a *different* item is published. The TTL stays as the answer for anything the
   * tags miss and for a purge that never arrives.
   */
  const cacheTag = tags ? cacheTagHeader(tags) : undefined;

  return {
    etag,
    headers: {
      etag,
      // `max-age=0` so a browser always revalidates, `s-maxage` so a shared cache absorbs the load.
      'cache-control': `public, max-age=0, s-maxage=${SHARED_MAX_AGE}`,
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
      'cache-control': `public, max-age=0, s-maxage=${SHARED_MAX_AGE}`,
      vary: 'authorization',
    },
  });
}
