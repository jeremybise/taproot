import {
  getContentTypeByApiId,
  listItems,
  termIdsForBranch,
  type ContentStatus,
} from '@taproot/core';

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
    const termId = params.get('term');
    const termIds = termId ? await termIdsForBranch(db, termId) : undefined;

    const limit = Math.min(Number(params.get('limit') ?? 50) || 50, 200);
    const offset = Math.max(Number(params.get('offset') ?? 0) || 0, 0);

    const { items, total } = await listItems(db, {
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
      },
      { headers: { 'cache-control': 'public, max-age=0, s-maxage=60', vary: 'authorization' } },
    );
  },
  { scope: 'content:read' },
);
