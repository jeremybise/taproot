import type { Kysely } from 'kysely';

import { typeHasItemPages } from '../content/items.js';
import type { ContentItemRow, ContentStatus, ContentTypeRow, Database } from '../db/schema.js';
import type { WebhookEventInput, WebhookItemSubject } from './events.js';

/**
 * Turning a row into the thing a receiver reads.
 *
 * One builder, called by every emit site, for the reason `resolveSeo` lives in core: the item
 * routes, the release publish and the scheduler all describe the same event, and three hand-written
 * object literals is three chances for one of them to send a `path` for an item that has no page or
 * to spell `contentType` as the uuid.
 */

/**
 * What an event says about a content item.
 *
 * `path` is null wherever the item has no page of its own, which is what `typeHasItemPages` decides.
 * Sending the stored path regardless is the tempting version and it is wrong in the direction that
 * costs a consumer real work: a rebuild would fetch, and a purge would clear, an address the site
 * answers 404 at.
 */
export function itemWebhookSubject(
  item: Pick<ContentItemRow, 'id' | 'title' | 'path' | 'slug' | 'status'>,
  contentType: Pick<ContentTypeRow, 'api_id' | 'kind' | 'item_pages'>,
  previousStatus?: ContentStatus,
): WebhookItemSubject {
  return {
    kind: 'item',
    id: item.id,
    title: item.title,
    path: typeHasItemPages(contentType) ? item.path : null,
    slug: item.slug,
    status: item.status,
    contentType: contentType.api_id,
    ...(previousStatus ? { previousStatus } : {}),
  };
}

/**
 * Which events one status change produces.
 *
 * Kept here rather than at each call site because the rule is easy to state and easy to get subtly
 * wrong: publication is about crossing the `published` boundary, **not** about the destination
 * status. Moving `published → archived` is an unpublish and reads like an archive; moving
 * `scheduled → published` is a publish and reads like a scheduled item catching up. A call site
 * checking `status === 'published'` gets the first of those wrong, which is the same mistake
 * `canChangeStatus` was written to stop being made three times over.
 *
 * Returns nothing for a move that stays on one side of the line — `draft → in_review` is workflow,
 * and nothing outside the CMS can act on it.
 */
export function publicationEvents(
  /**
   * `undefined` for an item that did not exist, which is a create.
   *
   * Spelled the same way `canChangeStatus(user, undefined, status)` already spells it, so the two
   * questions asked about one write — may they, and who should hear about it — take the same
   * argument. A create published straight away is a publication; a create saved as a draft is not.
   */
  from: ContentStatus | undefined,
  to: ContentStatus,
): ('item.published' | 'item.unpublished')[] {
  if (from === to) return [];
  if (to === 'published') return ['item.published'];
  if (from === 'published') return ['item.unpublished'];
  return [];
}

/**
 * Subjects for a set of item ids, in one query.
 *
 * For the two callers that publish in bulk and hold only ids: the scheduler sweep and a release
 * publish. Both need the content type's `api_id` and `item_pages`, which neither result carries,
 * and a lookup per item is the N+1 `dueWebhookDeliveries` avoids for the same reason.
 *
 * A `Map` rather than an array because both callers pair the subject back up with something they
 * already know about that item — the status it came *from*, which the rows can no longer answer
 * now that they have been updated.
 *
 * Called only when something actually published, so a deployment with nothing scheduled and no
 * releases pays nothing for it.
 */
export async function itemWebhookSubjects(
  db: Kysely<Database>,
  itemIds: string[],
): Promise<Map<string, WebhookItemSubject>> {
  if (itemIds.length === 0) return new Map();

  const rows = await db
    .selectFrom('content_items')
    .innerJoin('content_types', 'content_types.id', 'content_items.content_type_id')
    .select([
      'content_items.id as id',
      'content_items.title as title',
      'content_items.path as path',
      'content_items.slug as slug',
      'content_items.status as status',
      'content_types.api_id as api_id',
      'content_types.kind as kind',
      'content_types.item_pages as item_pages',
    ])
    .where('content_items.id', 'in', itemIds)
    .execute();

  return new Map(
    rows.map((row) => [
      row.id,
      itemWebhookSubject(
        { id: row.id, title: row.title, path: row.path, slug: row.slug, status: row.status },
        { api_id: row.api_id, kind: row.kind, item_pages: row.item_pages },
      ),
    ]),
  );
}

/**
 * The events for items the scheduler has just published.
 *
 * `scheduled` is stated rather than read back: the rows have already been updated by the time this
 * runs, so asking them where they came from answers `published`. It is also the only status the
 * sweep publishes from — `dueForPublishing` selects on it.
 */
export async function scheduledPublishEvents(
  db: Kysely<Database>,
  itemIds: string[],
): Promise<WebhookEventInput[]> {
  const subjects = await itemWebhookSubjects(db, itemIds);

  return [...subjects.values()].map((subject) => ({
    event: 'item.published' as const,
    subject: { ...subject, previousStatus: 'scheduled' as const },
  }));
}
