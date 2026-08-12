import {
  createItem,
  getContentType,
  isContentTypeKind,
  isItemSort,
  itemWebhookSubject,
  itemWriteTags,
  listItems,
  normalizePath,
  publicationEvents,
  termIdsForBranch,
  type ContentTypeKind,
} from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, readJson } from '../_shared.js';
import { seoSchema } from '../seoSchema.js';
import { canChangeStatus } from '../../runtime/guards.js';

export const GET = handle(async ({ context, taproot }) => {
  const params = new URL(context.request.url).searchParams;

  /**
   * `termIds` and `sort` exist for the query field's live preview, which has to answer "what would
   * this rule return" using the *same* code path that answers it at delivery — otherwise the count
   * an editor tunes against and the list a visitor sees are two implementations free to disagree.
   *
   * Branch expansion happens here rather than in `ItemFilters`, which stays a synchronous query
   * builder the status facets can share. An empty `termIds` parameter means no filter, matching the
   * query field's own convention rather than `ItemFilters`' — see `resolveItemQueries` for why the
   * two differ.
   */
  const chosen = (params.get('termIds') ?? '').split(',').filter(Boolean);
  const termIds = chosen.length
    ? [...new Set((await Promise.all(chosen.map((id) => termIdsForBranch(taproot.db.db, id)))).flat())]
    : undefined;

  const sort = params.get('sort');
  const visibleOnly = params.get('visibleOnly') === '1';
  const contentTypeId = params.get('contentTypeId') ?? undefined;

  /**
   * Narrow to content types of a given kind — what the parent picker searches by.
   *
   * A parent need not share the item's content type (see `parentOptions.ts`), so the picker's
   * candidate set is "every `page`-kind item" rather than one type's. Its first page comes from
   * `parentCandidates` server-side; this is how it searches past that page with the same narrowing,
   * which is the whole reason the two must agree.
   *
   * **An unrecognised kind is refused rather than dropped.** A silently ignored `contentTypeKinds`
   * would widen the search to every item — the picker would start offering collection items as
   * parents, `createItem` would take them, and the mistake would look like a working feature. That
   * is the same rule `sort` follows one field along: a request parameter is a developer's typo, and
   * the fallbacks elsewhere in Taproot are for *stored* rules that outlive what they name.
   */
  const requestedKinds = (params.get('contentTypeKinds') ?? '').split(',').filter(Boolean);
  const unknownKind = requestedKinds.find((kind) => !isContentTypeKind(kind));
  if (unknownKind) {
    return apiError(400, `Unknown content type kind "${unknownKind}".`);
  }
  const contentTypeKinds = requestedKinds.length
    ? (requestedKinds as ContentTypeKind[])
    : undefined;

  /**
   * The date dimension, resolved exactly as `resolveItemQueries` resolves it — looked up on the
   * content type as it is now, and dropped when it does not name a real `date` field.
   *
   * Duplicating the *lookup* here is the price of the preview answering the same question delivery
   * will. Trusting the parameter instead would let the editor's count diverge from the published
   * page precisely when the configuration is wrong, which is when an admin most needs to see it.
   */
  const dateFieldApiId = params.get('dateField');
  const dateFilter = params.get('dateFilter');
  let dateField: { apiId: string; kind: 'date' } | undefined;

  if (contentTypeId && dateFieldApiId) {
    const contentType = await getContentType(taproot.db.db, contentTypeId);
    const found = contentType?.fields.find(
      (field) => field.api_id === dateFieldApiId && field.type === 'date',
    );
    if (found) dateField = { apiId: found.api_id, kind: 'date' };
  }

  const valueFilters =
    dateField && (dateFilter === 'upcoming' || dateFilter === 'past')
      ? [
          {
            field: dateField.apiId,
            operator: (dateFilter === 'upcoming' ? 'after' : 'before') as 'after' | 'before',
            // Now, worked out per request — never read from a parameter, for the same reason it is
            // never read from stored data.
            value: new Date().toISOString(),
          },
        ]
      : undefined;

  /**
   * `under` narrows the search to one branch, for a picker that should not offer the whole site.
   *
   * The relation-picker half of the same problem the delivery listing has: once a site holds five
   * catalog years, a "related programs" picker offers five identically titled entries with nothing
   * distinguishing them, and choosing the wrong one links this year's page to a superseded edition —
   * which nothing on screen would ever report. A field configured with a scope searches inside it.
   *
   * Normalised rather than validated, matching the delivery routes: a path that matches nothing
   * answers an empty list, which for a picker reads correctly as "no candidates here".
   */
  const under = params.get('under');

  const result = await listItems(taproot.db.db, {
    contentTypeId,
    contentTypeKinds,
    pathPrefix: under !== null ? normalizePath(under) : undefined,
    status: (params.get('status') as never) ?? undefined,
    search: params.get('search') ?? undefined,
    termIds,
    sort: isItemSort(sort) ? sort : undefined,
    sortField: dateField,
    valueFilters,
    visibleOnly: visibleOnly || undefined,
    limit: Number(params.get('limit') ?? 50),
    offset: Number(params.get('offset') ?? 0),
  });

  return json(result);
});

const createSchema = z.object({
  contentTypeId: z.string().min(1),
  title: z.string().min(1).max(300),
  slug: z.string().optional(),
  parentId: z.string().nullish(),
  status: z.enum(['draft', 'in_review', 'scheduled', 'published', 'archived']).default('draft'),
  /** When a scheduled item goes live. ISO 8601. */
  publishAt: z.string().datetime().nullish(),
  data: z.record(z.string(), z.unknown()).default({}),
  seo: seoSchema.default({}),
});

export const POST = handle(
  async ({ context, taproot, user }) => {
    const input = await readJson(context.request, createSchema);

    const contentType = await getContentType(taproot.db.db, input.contentTypeId);
    if (!contentType) return apiError(404, 'Content type not found.');

    // Publishing is a higher bar than creating: a contributor can draft, an editor publishes.
    // `scheduled` counts too — see `canChangeStatus`. A new item has no previous status.
    if (!canChangeStatus(user, undefined, input.status)) {
      return apiError(403, 'That status requires the editor role or higher. Save as a draft instead.');
    }

    const item = await createItem(taproot.db, contentType, contentType.fields, {
      contentTypeId: contentType.id,
      title: input.title,
      slug: input.slug,
      parentId: input.parentId ?? null,
      status: input.status,
      publishAt: input.publishAt,
      data: input.data,
      seo: input.seo,
      userId: user.id,
    });

    /**
     * A new item invalidates listings, not just its own URL — which nothing was caching yet.
     *
     * `item:` is the near-useless half here and `type:` is the whole point: publishing a new event
     * has to reach every page showing "the six soonest", and those pages' cached copies name the six
     * that existed before this one did.
     */
    taproot.invalidate(itemWriteTags(item.id, contentType.api_id));

    /**
     * Two events for one create, when the create is also a publish.
     *
     * `item.created` is the fact that a row exists and is what an inventory or a search index acts
     * on; `item.published` is the fact that visitors can see it, which an editor with the role for
     * it can do in the same request. An endpoint subscribes to whichever it is for, and neither is
     * derivable from the other — `item.created` carrying `status: 'published'` would make every
     * receiver reimplement `publicationEvents`.
     */
    taproot.emit({ event: 'item.created', subject: itemWebhookSubject(item, contentType) });

    for (const event of publicationEvents(undefined, item.status)) {
      taproot.emit({ event, subject: itemWebhookSubject(item, contentType) });
    }

    return json({ item }, { status: 201 });
  },
  { role: 'contributor' },
);
