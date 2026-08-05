import {
  getContentTypeByApiId,
  getTaxonomyByApiId,
  listItemSummaries,
  termIdsForBranch,
  type ContentStatus,
  type DeliveryTermRef,
} from '@taprootcms/core';

import { apiError, handleScoped, json } from '../_shared.js';

/**
 * A filtered list of visible items — index pages, term archives, "latest news".
 *
 * Returns summaries rather than whole items on purpose. A listing renders a title, a path, and
 * perhaps a date; sending every field's data for fifty items so a template can use three of them
 * would make the endpoint that exists to avoid N round trips expensive in a different way. A
 * consumer needing an item's content asks `resolve` for it.
 *
 * Visibility is applied in SQL through `ItemFilters.visibleOnly`, not by filtering the results.
 * Filtering afterwards would make `total` count rows the caller never sees and put a different
 * number of items on each page depending on how many drafts happened to fall in it.
 */
export const GET = handleScoped(
  async ({ context, taproot }) => {
    const params = new URL(context.request.url).searchParams;
    const db = taproot.db.db;

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
     * A term filter means the whole branch, exactly as it does in the admin.
     *
     * Filing something under Biology has to find it when a visitor browses Sciences. The expansion
     * belongs here rather than in the consumer, which would otherwise need the whole term tree
     * before it could ask the question.
     */
    /**
     * `term` takes an id, **or** a slug when `taxonomy` names which vocabulary it belongs to.
     *
     * The slug form is what a term archive actually needs: a URL like `/department/student-services`
     * carries a slug, and making the consumer translate it first would mean a second round trip —
     * on the endpoint that exists to avoid extra round trips. Ids are unique, so the two forms
     * cannot collide.
     */
    const termParam = params.get('term');
    const taxonomyApiId = params.get('taxonomy');

    let termIds: string[] | undefined;
    let term: DeliveryTermRef | undefined;

    if (termParam) {
      let resolvedId = termParam;

      if (taxonomyApiId) {
        const taxonomy = await getTaxonomyByApiId(db, taxonomyApiId);
        if (!taxonomy) return apiError(404, `No taxonomy with api_id "${taxonomyApiId}".`);

        const row = await db
          .selectFrom('terms')
          .select(['id', 'name', 'slug'])
          .where('taxonomy_id', '=', taxonomy.id)
          .where('slug', '=', termParam)
          .executeTakeFirst();

        if (!row) return apiError(404, `No term "${termParam}" in "${taxonomyApiId}".`);

        resolvedId = row.id;
        /**
         * Returned so an archive page can render the term's real name.
         *
         * The alternative is un-slugifying, which turns "Student Services" into "student services"
         * and throws away the capitalisation an editor chose — and gets a term like "PhD" wrong in
         * a way no rule can recover.
         */
        term = { id: row.id, name: row.name, slug: row.slug, taxonomyApiId };
      }

      termIds = await termIdsForBranch(db, resolvedId);
    }

    const limit = Math.min(Number(params.get('limit') ?? 50) || 50, 200);
    const offset = Math.max(Number(params.get('offset') ?? 0) || 0, 0);

    const { items, total } = await listItemSummaries(db, {
      contentTypeId,
      termIds,
      visibleOnly: true,
      /**
       * Only kinds that have a public URL.
       *
       * A singleton's `path` is the synthetic `/__singleton/{api_id}`, which nothing serves — so
       * including one in a listing hands a consumer a link that 404s. A singleton's content is
       * still reachable through `resolve` with that path, which is the deliberate way to ask for it.
       */
      contentTypeKinds: ['page', 'collection'],
      search: params.get('q') ?? undefined,
      limit,
      offset,
    });

    return json(
      {
        items: items.map((item) => ({
          id: item.id,
          title: item.title,
          slug: item.slug,
          path: item.path,
          status: item.status as ContentStatus,
          publishedAt: item.published_at,
          updatedAt: item.updated_at,
        })),
        total,
        // Present only when a slug was resolved, so a consumer can tell "no such term" from
        // "a term with nothing in it" — which are a 404 and an empty archive respectively.
        ...(term ? { term } : {}),
      },
      { headers: { 'cache-control': 'public, max-age=0, s-maxage=60', vary: 'authorization' } },
    );
  },
  { scope: 'content:read' },
);
