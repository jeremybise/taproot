import {
  deliverItems,
  getContentTypeByApiId,
  getTaxonomyByApiId,
  isItemSort,
  ITEM_SORTS,
  termIdsForBranch,
  type DeliveryTermRef,
  type ItemSort,
} from '@taprootcms/core';

import { apiError, handleScoped, json } from '../_shared.js';

/**
 * A filtered list of visible items — index pages, term archives, "latest news", a staff directory.
 *
 * Returns **summaries by default**: id, title, slug, path, status, and the two timestamps. A listing
 * that renders a title and a link should not pay for every field of fifty items, and the menu
 * picker asking for two hundred candidates by name is the caller that would suffer most.
 *
 * `include=data` is the opt-in for the other case. A card grid needs the photo, the position and the
 * department, and without it the only way to get them is N calls to `resolve` — the round trips this
 * endpoint exists to avoid. What comes back is a `DeliveryItemRef` with `data` populated, exactly as
 * a `query` field's results arrive on `resolve`, so one card component renders either without a
 * branch. See `deliverItems` for what that costs.
 */
export const GET = handleScoped(
  async ({ context, taproot }) => {
    const params = new URL(context.request.url).searchParams;
    const db = taproot.db.db;

    /**
     * `include` is a comma list, and an unknown entry is refused rather than ignored.
     *
     * Silently dropping one is how a consumer ships `include=fields`, sees summaries, and concludes
     * the feature does not work. The list form is here so a second thing can be included later
     * without a second parameter.
     */
    const include = (params.get('include') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    const unknown = include.filter((entry) => entry !== 'data');
    if (unknown.length > 0) {
      return apiError(400, `Unknown include: ${unknown.join(', ')}. Accepted: data.`);
    }

    const typeApiId = params.get('type');
    let contentTypeId: string | undefined;

    if (typeApiId) {
      const contentType = await getContentTypeByApiId(db, typeApiId);
      if (!contentType) return apiError(404, `No content type with api_id "${typeApiId}".`);
      // A block type has no addressable items, so a listing of them could not be linked to.
      // Refused rather than answered with an empty list, which would read as "none yet".
      if (contentType.kind === 'block') {
        return apiError(422, `"${typeApiId}" is a block type and has no items of its own.`);
      }
      contentTypeId = contentType.id;
    }

    /**
     * `sort` names one of the orders or is refused.
     *
     * It used to be read by nothing at all, so a directory asking for alphabetical order got site
     * order and nothing said why. Refused rather than quietly falling back, because this is a
     * *request parameter* written by a developer: the fallbacks elsewhere in Taproot are for stored
     * rules that outlive the field they name, where a live page must not break for a configuration
     * mistake made weeks earlier. A typo in a fetch is not that.
     */
    const requestedSort = params.get('sort');
    if (requestedSort && !isItemSort(requestedSort)) {
      return apiError(400, `Unknown sort "${requestedSort}". Accepted: ${ITEM_SORTS.join(', ')}.`);
    }
    const sort = (requestedSort as ItemSort | null) ?? undefined;

    /**
     * `term` takes an id, **or** a slug when `taxonomy` names which vocabulary it belongs to.
     *
     * The slug form is what a term archive actually needs: a URL like `/department/student-services`
     * carries a slug, and making the consumer translate it first would mean a second round trip —
     * on the endpoint that exists to avoid extra round trips. Ids are unique, so the two forms
     * cannot collide.
     *
     * **Several are accepted**, repeated or comma-separated, and they mean **OR**: an item carrying
     * any of them matches. That is what a facet with checkboxes does — ticking two departments
     * widens the list rather than narrowing it to people in both — and it is also what
     * `ItemFilters.termIds` has always meant, so this route stopped narrowing it to one rather than
     * inventing anything. Each is expanded to its whole branch first, so ticking "Sciences" finds
     * what is filed under "Biology".
     */
    const termParams = params
      .getAll('term')
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter(Boolean);
    const taxonomyApiId = params.get('taxonomy');

    let termIds: string[] | undefined;
    /**
     * Echoed only when exactly one term was named by slug — which is the term-archive case, where a
     * page needs the term's real name for its heading.
     *
     * Deliberately not generalised into a list. A multi-select facet already holds the names: it got
     * them from `/delivery/taxonomy/{apiId}/terms`, which is where "what terms exist" is answered.
     * Sending them twice would be a second spelling of one fact, free to disagree.
     */
    let term: DeliveryTermRef | undefined;

    if (termParams.length > 0) {
      let resolved = termParams;

      if (taxonomyApiId) {
        const taxonomy = await getTaxonomyByApiId(db, taxonomyApiId);
        if (!taxonomy) return apiError(404, `No taxonomy with api_id "${taxonomyApiId}".`);

        // One lookup for every slug rather than one each: ticking six departments is one question.
        const rows = await db
          .selectFrom('terms')
          .select(['id', 'name', 'slug'])
          .where('taxonomy_id', '=', taxonomy.id)
          .where('slug', 'in', termParams)
          .execute();

        const bySlug = new Map(rows.map((row) => [row.slug, row]));
        const missing = termParams.filter((slug) => !bySlug.has(slug));
        // Refused rather than dropped, so a mistyped slug is a 404 instead of an archive that
        // silently lists the wrong thing — or everything.
        if (missing.length > 0) {
          return apiError(404, `No term "${missing[0]}" in "${taxonomyApiId}".`);
        }

        resolved = termParams.map((slug) => bySlug.get(slug)!.id);

        /**
         * Returned so an archive page can render the term's real name.
         *
         * The alternative is un-slugifying, which turns "Student Services" into "student services"
         * and throws away the capitalisation an editor chose — and gets a term like "PhD" wrong in
         * a way no rule can recover.
         */
        if (termParams.length === 1) {
          const only = bySlug.get(termParams[0]!)!;
          term = { id: only.id, name: only.name, slug: only.slug, taxonomyApiId };
        }
      }

      // Unioned, because two branches can overlap and asking `in (…)` with a repeated id is the
      // same question twice.
      const branches = await Promise.all(resolved.map((id) => termIdsForBranch(db, id)));
      termIds = [...new Set(branches.flat())];
    }

    const limit = Math.min(Number(params.get('limit') ?? 50) || 50, 200);
    const offset = Math.max(Number(params.get('offset') ?? 0) || 0, 0);

    const list = await deliverItems(db, {
      origin: new URL(context.request.url).origin,
      storage: taproot.storage,
      contentTypeId,
      termIds,
      search: params.get('q') ?? undefined,
      sort,
      limit,
      offset,
      includeData: include.includes('data'),
    });

    return json(
      {
        items: list.items,
        total: list.total,
        // Present only when the items carry data, because a summary holds no ids to resolve.
        ...(list.media ? { media: list.media } : {}),
        ...(list.references ? { references: list.references } : {}),
        ...(list.terms ? { terms: list.terms } : {}),
        // Present only when a slug was resolved, so a consumer can tell "no such term" from
        // "a term with nothing in it" — which are a 404 and an empty archive respectively.
        ...(term ? { term } : {}),
      },
      { headers: { 'cache-control': 'public, max-age=0, s-maxage=60', vary: 'authorization' } },
    );
  },
  { scope: 'content:read' },
);
