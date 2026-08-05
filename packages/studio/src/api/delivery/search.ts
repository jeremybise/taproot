import {
  getContentTypeByApiId,
  isItemSort,
  ITEM_SORTS,
  listItemSummaries,
  loadSearchExcerpts,
  type ContentStatus,
  type ItemSort,
} from '@taprootcms/core';

import { apiError, handleScoped, json } from '../_shared.js';

/** Results per page, and the ceiling a caller may raise it to. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Search across a site's content — the read a consumer cannot build for itself.
 *
 * Everything else on the delivery API answers a question the caller already knows the shape of: this
 * path, this type, this term. Search is the one that needs the item's *prose*, which lives as HTML
 * inside a JSON blob and often several levels down inside a block — so a consumer could only
 * implement it by fetching every item and matching in memory, which is the N+1 the delivery API
 * exists to prevent, one level up.
 *
 * The matching and the ranking are both `listItemSummaries`, the same function the admin's own
 * cross-type search calls. That is deliberate and load-bearing: a separate query here would be a
 * search that finds pages the CMS cannot, or misses ones it can, and neither is discoverable from
 * either screen.
 */
export const GET = handleScoped(
  async ({ context, taproot }) => {
    const params = new URL(context.request.url).searchParams;
    const db = taproot.db.db;

    const term = (params.get('q') ?? '').trim();

    /**
     * A blank term answers nothing, rather than everything or an error.
     *
     * Everything is what "match all" would mean and is the dangerous reading — a site's own empty
     * search box would dump its entire content on submit. An error is defensible and worse in
     * practice: submitting an empty form is an ordinary thing a visitor does, and it would surface
     * as the site's error page rather than as "no results".
     */
    if (!term) return json({ results: [], total: 0, query: '' }, { headers: cacheHeaders() });

    const typeApiId = params.get('type');
    let contentTypeId: string | undefined;

    if (typeApiId) {
      const contentType = await getContentTypeByApiId(db, typeApiId);
      if (!contentType) return apiError(404, `No content type with api_id "${typeApiId}".`);
      if (contentType.kind === 'block') {
        return apiError(422, `"${typeApiId}" is a block type and has no items of its own.`);
      }
      contentTypeId = contentType.id;
    }

    /**
     * An unrecognised `sort` is refused, as it is on the listing endpoint.
     *
     * The fallbacks elsewhere in Taproot are for **stored rules** that outlive what they name — a
     * saved query whose date field was deleted weeks later must not break a live page. A request
     * parameter is not that: it is written by a developer, once, and a silent fallback to relevance
     * is a sort that looks implemented and never was.
     */
    const requested = params.get('sort');
    if (requested && !isItemSort(requested)) {
      return apiError(400, `Unknown sort "${requested}". Accepted: ${ITEM_SORTS.join(', ')}.`);
    }
    const sort = (requested as ItemSort | null) ?? undefined;

    const limit = Math.min(Number(params.get('limit') ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(Number(params.get('offset') ?? 0) || 0, 0);

    const { items, total } = await listItemSummaries(db, {
      contentTypeId,
      search: term,
      visibleOnly: true,
      // Kinds with a public URL, exactly as the listing endpoint takes them: a singleton's path is
      // the synthetic `/__singleton/{api_id}`, and a search result is a link or it is nothing.
      contentTypeKinds: ['page', 'collection'],
      sort,
      limit,
      offset,
    });

    /**
     * One query for the page's excerpts rather than one per result.
     *
     * Kept out of `listItemSummaries` on purpose: that function is shared with the admin's list, the
     * menu editor's candidates and the delivery listing, none of which want an item's whole
     * flattened body over the wire to render a link.
     */
    const excerpts = await loadSearchExcerpts(
      db,
      items.map((item) => item.id),
      term,
    );

    return json(
      {
        results: items.map((item) => ({
          id: item.id,
          title: item.title,
          slug: item.slug,
          path: item.path,
          status: item.status as ContentStatus,
          publishedAt: item.published_at,
          updatedAt: item.updated_at,
          /**
           * Empty when the item has never been indexed, which is what every item looks like on a
           * database that has not run `npm run db:reindex` since the migration. The result still
           * carries its title and path, so a site degrades to a list of links rather than to
           * nothing.
           */
          excerpt: excerpts.get(item.id) ?? '',
        })),
        total,
        // Echoed so a consumer rendering "12 results for X" reads the term the server actually
        // searched for — which is trimmed, and may not be the raw string it sent.
        query: term,
      },
      { headers: cacheHeaders() },
    );
  },
  { scope: 'content:read' },
);

/**
 * The listing endpoint's headers, and no `Cache-Tag` for the reason it has none either.
 *
 * A search spans every content type, so the only tag that would be honest is one naming all of them
 * — which is a purge nobody wants to issue and which would clear the whole edge cache on any save.
 * `s-maxage` bounds the staleness instead, which is what a listing has always lived with.
 */
function cacheHeaders(): Record<string, string> {
  return { 'cache-control': 'public, max-age=0, s-maxage=60', vary: 'authorization' };
}
