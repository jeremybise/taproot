import type { TaprootDb } from '../db/client.js';
import type { ContentStatus, ContentTypeRow, FieldRow } from '../db/schema.js';
import { getContentType } from './types.js';
import { getItem, updateItem, visibleToPublic } from './items.js';
import { descendantPathRange } from './paths.js';
import { isLegalTransition } from './workflow.js';

/**
 * Applying one change across a whole branch.
 *
 * Superseding a catalog year is the case: ~280 items want unpublishing, or want `noIndex` set so the
 * old edition stops competing with the new one in search results. One at a time is not a workflow
 * anybody completes.
 *
 * **Everything goes through `updateItem`, never around it.** A direct `update content_items set
 * status` would be faster and would skip the cascading path rules, the revision, the derived
 * indexes, the audit trail and the cache purge — a second write implementation for the operation
 * most likely to touch hundreds of rows at once. Same rule `publishRelease` follows for the same
 * reason.
 *
 * Chunked and resumable exactly as `duplicateSubtree` is, and for the same reason: each item is its
 * own batch, and a few hundred of them do not fit in one Worker request.
 */

export interface BulkSubtreeInput {
  /** The new status, or omitted to leave it alone. */
  status?: ContentStatus;
  /** Whether items should ask search engines not to index them, or omitted to leave it alone. */
  noIndex?: boolean;
  /** Include the root itself. Off by default, matching `pathPrefix`. */
  includeRoot?: boolean;
  /** How many items to write before returning. A caller loops until `remaining` is 0. */
  limit?: number;
  /** Who is doing it, for `updated_by` and the revision. */
  userId?: string | null;
  /**
   * Whether *this actor* may make this move, asked per item.
   *
   * **A callback because the answer lives in the studio and this does not.** `canChangeStatus`
   * needs a role, and roles are the server's; core owns only the half that is a fact about the
   * graph — `archived → published` is an arrow that does not exist, which is refused for an admin
   * too and is checked below regardless. The same split `resolveMenu` makes with `termHref`: the
   * part core can answer, plus a callback for the part it cannot.
   *
   * Omitted, only legality is enforced — which is right for a script or a migration, and wrong for
   * a request. A route must always pass it.
   */
  canChange?: (from: ContentStatus, to: ContentStatus) => boolean;
}

export interface BulkSubtreeResult {
  changed: number;
  /**
   * Each changed item's id and the status it came *from*.
   *
   * Carried out rather than derived, because publication is judged by **crossing the boundary**, not
   * by the destination: `published → archived` is an unpublish and `draft → archived` is not, and a
   * caller checking `status === 'published'` gets that wrong — which is the mistake `canChangeStatus`
   * exists because somebody made three times. `publicationEvents` needs the `from`, and once this
   * function has returned it is the only place left holding it.
   */
  touched: Map<string, ContentStatus>;
  /** Items matching the filter that this call did not reach. */
  remaining: number;
  /**
   * Items the actor was not allowed to change, with the reason.
   *
   * **Reported rather than thrown**, because one refusal must not sink the batch: a contributor
   * running "unpublish this year" over 280 items should move the 277 they may move and be told
   * about the three they may not. Same shape as `publishRelease`'s `failed`, and the same argument
   * a per-file upload failure makes against refusing the whole request.
   */
  refused: { id: string; title: string; reason: string }[];
}

export class BulkSubtreeError extends Error {
  override name = 'BulkSubtreeError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'nothing_to_do' = 'not_found',
  ) {
    super(message);
  }
}

/**
 * Apply a status and/or a `noIndex` flag to everything under a path.
 *
 * The `noIndex` half is the one worth having beside the status: an archived catalog year usually
 * *should* stay readable — students hold rights to it — while no longer competing with the current
 * edition in search results. "Unpublish it" and "stop indexing it" are different intentions and a
 * bulk tool that only offered the first would force the wrong one.
 */
export async function updateSubtree(
  handle: TaprootDb,
  rootId: string,
  input: BulkSubtreeInput,
): Promise<BulkSubtreeResult> {
  const { db } = handle;

  if (input.status === undefined && input.noIndex === undefined) {
    throw new BulkSubtreeError('Nothing to change: pass a status, a noIndex flag, or both.', 'nothing_to_do');
  }

  const root = await getItem(db, rootId);
  if (!root) throw new BulkSubtreeError(`Content item ${rootId} not found.`);

  const { start, end } = descendantPathRange(root.path);

  /**
   * Ordered by path, so a resumed run is deterministic and a partial pass is a contiguous prefix of
   * the branch rather than a scatter somebody has to reason about.
   */
  const rows = await db
    .selectFrom('content_items')
    .select(['id', 'title', 'status', 'content_type_id'])
    .where((eb) =>
      input.includeRoot
        ? eb.or([eb('id', '=', root.id), eb.and([eb('path', '>', start), eb('path', '<', end)])])
        : eb.and([eb('path', '>', start), eb('path', '<', end)]),
    )
    .orderBy('path')
    .execute();

  const limit = input.limit ?? Number.POSITIVE_INFINITY;
  const refused: BulkSubtreeResult['refused'] = [];
  const typeCache = new Map<string, { type: ContentTypeRow; fields: FieldRow[] }>();

  const touched = new Map<string, ContentStatus>();
  let changed = 0;
  let remaining = 0;

  for (const row of rows) {
    /**
     * Already in the desired state — skipped, and that is what makes a resumed run cheap.
     *
     * It also keeps the revision log honest: rewriting an item to the status it already has would
     * append a revision recording a change nobody made.
     */
    const statusSettled = input.status === undefined || row.status === input.status;
    if (statusSettled && input.noIndex === undefined) continue;

    if (changed >= limit) {
      remaining += 1;
      continue;
    }

    /**
     * The same two questions one item at a time would ask, in the same order.
     *
     * Legality first, because it does not depend on who is asking: a page coming back from the
     * archive goes through draft so somebody reads it first, and that is refused for an admin too.
     * Then permission, through the caller's callback. A bulk tool must not become a route to a
     * transition the single-item path would refuse — which is the objection Content Releases already
     * answers with "publishing is editor".
     *
     * Checked per item because the answer depends on each item's *current* status: a branch part
     * published and part draft has two different transitions in it.
     */
    if (input.status !== undefined && row.status !== input.status) {
      if (!isLegalTransition(row.status, input.status)) {
        refused.push({
          id: row.id,
          title: row.title,
          reason: `"${row.title}" cannot go from ${row.status} to ${input.status}.`,
        });
        continue;
      }
      if (input.canChange && !input.canChange(row.status, input.status)) {
        refused.push({
          id: row.id,
          title: row.title,
          reason: `You do not have permission to move "${row.title}" to ${input.status}.`,
        });
        continue;
      }
    }

    let entry = typeCache.get(row.content_type_id);
    if (!entry) {
      const loaded = await getContentType(db, row.content_type_id);
      if (!loaded) continue;
      entry = { type: loaded, fields: loaded.fields };
      typeCache.set(row.content_type_id, entry);
    }

    const item = await getItem(db, row.id);
    if (!item) continue;

    await updateItem(handle, entry.type, entry.fields, row.id, {
      ...(input.status !== undefined ? { status: input.status } : {}),
      /**
       * `noIndex` rides on the existing `seo` blob rather than replacing it.
       *
       * Spreading the stored value keeps a meta description and an OG image an editor wrote, which a
       * bulk tool that sent `{ noIndex: true }` alone would silently erase across the whole branch —
       * the destructive-transform failure `validateItemData` refuses to commit for hidden fields.
       *
       * Written as `true` or removed entirely, matching `seoSchema`: falsy is omitted there, so
       * "unset" has exactly one spelling and a round-trip cannot invent a second.
       */
      ...(input.noIndex !== undefined
        ? {
            seo: input.noIndex
              ? { ...item.seo, noIndex: true }
              : (({ noIndex: _dropped, ...rest }) => rest)(item.seo),
          }
        : {}),
      userId: input.userId ?? null,
    });

    touched.set(row.id, row.status);
    changed += 1;
  }

  return { changed, remaining, refused, touched };
}

/**
 * How many items under a path a visitor can currently see.
 *
 * What a confirmation screen needs before somebody unpublishes a year: "this will take 188 pages off
 * the site" is a different sentence from "this will change 280 rows", and the second is the one that
 * gets read past.
 */
export async function visibleCountUnder(handle: TaprootDb, rootId: string): Promise<number> {
  const root = await getItem(handle.db, rootId);
  if (!root) return 0;

  const { start, end } = descendantPathRange(root.path);
  const row = await handle.db
    .selectFrom('content_items')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('path', '>', start)
    .where('path', '<', end)
    .where(visibleToPublic)
    .executeTakeFirst();

  return Number(row?.count ?? 0);
}
