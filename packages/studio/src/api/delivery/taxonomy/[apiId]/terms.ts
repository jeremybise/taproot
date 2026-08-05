import { deliverTaxonomyTerms, getContentTypeByApiId } from '@taprootcms/core';

import { apiError, handleScoped, json } from '../../../_shared.js';

/**
 * A taxonomy's terms, for a consumer building a facet.
 *
 * The question nothing else here could answer: *what departments exist*. Without it a filter UI has
 * to hard-code the list, and then goes stale the moment an editor adds one — silently, because a
 * missing checkbox looks exactly like a department nobody has filed anything under.
 *
 * Terms come back flat with `parentId`, depth-first so parents precede their children. Flat is what
 * both renderings want: an indented `<select>` reads it in order, a checkbox tree nests it by
 * parent, and nesting it here would make the first one flatten somebody else's shape.
 *
 * `counts=1` adds `itemCount` per term. Opt-in because it is a second query over every visible
 * assignment in the taxonomy, and a menu that only needs names should not pay for it. Pass `type`
 * alongside it whenever the grid beside the facet is narrowed to one — "Biology (12)" must not count
 * twelve news stories when clicking it returns people.
 */
export const GET = handleScoped(
  async ({ context, taproot }) => {
    const apiId = context.params.apiId;
    if (!apiId) return apiError(400, 'A taxonomy api_id is required.');

    const search = new URL(context.request.url).searchParams;
    const db = taproot.db.db;

    let contentTypeId: string | undefined;
    const typeApiId = search.get('type');

    if (typeApiId) {
      const contentType = await getContentTypeByApiId(db, typeApiId);
      if (!contentType) return apiError(404, `No content type with api_id "${typeApiId}".`);
      if (contentType.kind === 'block') {
        return apiError(422, `"${typeApiId}" is a block type and has no items of its own.`);
      }
      contentTypeId = contentType.id;
    }

    /**
     * `counts` is only read as a request to count when it says so.
     *
     * `counts=0` reading as true is the classic version of this bug, and it costs a query on every
     * request from a consumer that thought it had switched the feature off.
     */
    const counts = ['1', 'true', 'yes'].includes((search.get('counts') ?? '').toLowerCase());

    const taxonomy = await deliverTaxonomyTerms(db, apiId, { counts, contentTypeId });

    /**
     * 404 rather than an empty list for a taxonomy that does not exist.
     *
     * An empty list reads as "no terms yet", which is a real and ordinary state — so answering one
     * for a misspelled `api_id` would hide the mistake for as long as nobody happened to add a term.
     */
    if (!taxonomy) return apiError(404, `No taxonomy with api_id "${apiId}".`);

    return json(taxonomy, {
      headers: { 'cache-control': 'public, max-age=0, s-maxage=60', vary: 'authorization' },
    });
  },
  { scope: 'content:read' },
);
