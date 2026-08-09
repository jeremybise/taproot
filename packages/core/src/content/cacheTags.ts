/**
 * Cache tags: the names a cached response can later be invalidated by.
 *
 * A delivery response says which tags it depends on, and both caches in the system use the same
 * list — the studio tags its own cached JSON, and a consumer tags the HTML it renders from that
 * JSON. That is why the tags travel *in the payload* rather than only in a header: the site has to
 * tag a document it assembled itself, and it cannot work out what went into the answer without
 * re-deriving how the answer was built. One list, computed where the page is resolved.
 *
 * The vocabulary lives here, importless and free of Kysely, so `pure.ts` can re-export it to a
 * consumer that must never see the data layer — the same reason `queryKey` and `PREVIEW_MESSAGE`
 * live where they do. A tag spelled differently on the two sides fails silently and in one
 * direction: the purge succeeds, reports success, and clears nothing.
 *
 * Why tags rather than purging URLs: a page's content is not a function of its own row. It changes
 * when an ancestor is renamed, when a child is published, when a reusable block is edited in the
 * library, and — for a listing — when some *other* item of a type it lists goes live. Nothing
 * writing any of those knows which URLs to purge, and every one of them knows its own id.
 */

/**
 * Cloudflare's ceiling is 1000 tags per response; this is far below it deliberately.
 *
 * The lists a page can carry — children, breadcrumbs, query results, relations — are each already
 * bounded, so hitting this means something unusual. Truncating rather than failing is the right
 * behaviour for a cache hint: a page that keeps a stale reference for the shared TTL is a much
 * smaller problem than a response rejected for an oversized header.
 */
export const MAX_CACHE_TAGS = 200;

/** The item itself, an ancestor in its breadcrumbs, a child, a relation target, a query match. */
export function itemTag(id: string): string {
  return `item:${id}`;
}

/**
 * A content type, which is what makes a listing invalidate correctly.
 *
 * An item tag cannot do this job. Publishing a seventh event has to purge the page listing "the six
 * soonest events" — and that page's cached copy names the six it *had*, which is precisely the set
 * not containing the new one. The page depends on the type, not only on the members it happened to
 * match.
 */
export function typeTag(apiId: string): string {
  return `type:${apiId}`;
}

/**
 * A reusable block library entry.
 *
 * This closes the one gap `deliveryCache`'s ETag documents and accepts: editing a shared block
 * changes what every referencing page renders without touching any of their rows, so no validator
 * built from `updated_at` can notice. A tag can, because the pages say they used it.
 */
export function blockTag(id: string): string {
  return `block:${id}`;
}

/** A menu, whose response is fetched once per page view and changes rarely. */
export function menuTag(apiId: string): string {
  return `menu:${apiId}`;
}

/**
 * A reusable text snippet, keyed by the `api_id` its tokens name.
 *
 * The same gap `blockTag` closes, one size down: editing a snippet changes what every page using it
 * renders without touching any of their rows, so no validator built from `updated_at` can notice.
 * A tag can, because the pages say they used it.
 *
 * Precise rather than `SITE_TAG`, and the precision is affordable *because* the pages say so — a
 * page collects the snippets it refers to while resolving them, so tagging costs nothing extra. The
 * coarse alternative would give every tuition edit a cold cache for the whole site.
 */
export function snippetTag(apiId: string): string {
  return `snippet:${apiId}`;
}

/**
 * Everything under one deployment, for the rare change that invalidates the lot.
 *
 * Renaming a content type's `api_id`, editing site branding, changing a global setting. Coarse by
 * design and expected to be used rarely — a purge of this is a cold cache for the whole site.
 */
export const SITE_TAG = 'site';

/**
 * What writing one content item invalidates.
 *
 * Two tags, and the second is the one that is easy to leave out. `item:` covers every page that
 * *named* this one — its own URL, its parent's child list, a relation card, a breadcrumb, a menu
 * entry — because each of those responses said it depended on this id. `type:` covers every page
 * that listed the type without naming this item, which is the only way a newly published item can
 * appear in "the six soonest events": the cached copy of that listing names the six it had.
 *
 * Descendants of a renamed page are deliberately not enumerated. Their content did not change, only
 * their addresses did — and a cache entry under an address nobody will request again costs nothing,
 * while the new address is a miss that resolves fresh. Walking the subtree here would mean loading
 * it a second time purely to purge URLs that are already unreachable.
 */
export function itemWriteTags(id: string, contentTypeApiId: string): string[] {
  return [itemTag(id), typeTag(contentTypeApiId)];
}

/**
 * Normalise and bound a tag list.
 *
 * Cloudflare requires printable ASCII and matches case-insensitively on purge, so anything that
 * could arrive from user-authored text — a content type's `api_id` — is lowercased and stripped
 * here rather than at each call site. Ids are uuids and unaffected; `api_id` is already constrained
 * by validation, so this is a belt on top of a brace rather than the only check.
 */
export function normalizeCacheTags(tags: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    const cleaned = tag.toLowerCase().replace(/[^a-z0-9:_-]/g, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= MAX_CACHE_TAGS) break;
  }

  return out;
}

/**
 * The `Cache-Tag` header value, or undefined when there is nothing to say.
 *
 * Undefined rather than an empty string: an empty `Cache-Tag` is a header asserting a dependency on
 * nothing, and it is better for a response to carry no tag at all than one that cannot be purged
 * but looks as though it can.
 */
export function cacheTagHeader(tags: string[]): string | undefined {
  const normalized = normalizeCacheTags(tags);
  return normalized.length > 0 ? normalized.join(',') : undefined;
}
