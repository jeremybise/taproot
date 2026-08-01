import type { Kysely } from 'kysely';

import type { TaprootDb } from '../db/client.js';
import type {
  Database,
  ReleaseItemRow,
  ReleaseRow,
  ReleaseStatus,
  User,
} from '../db/schema.js';
import { now, parseJson, stringifyJson } from '../db/values.js';
import { newId } from '../ids.js';
import { validateItemData } from '../validation/fields.js';
import { recordAuditEntry } from './auditLog.js';
import { getItem, updateItem, type SeoData } from './items.js';
import { blockTypeRegistry, getContentType } from './types.js';
import { isLegalTransition } from './workflow.js';

/**
 * Content Releases: a named batch of content that goes live together.
 *
 * The feature exists for "tuition changes across a dozen live pages, all at 9am on the same day",
 * and until now Taproot had nowhere to put that work. `content_items` holds exactly one row per
 * item, so editing a published page changed what visitors saw at the moment of the save — there was
 * no pending version, and so nothing to coordinate. A release is the first place a page's next
 * version can wait.
 *
 * Three decisions shape everything below, and each has an alternative that looks simpler:
 *
 *  - **A staged version carries its own content, rather than pointing at a revision.** Revisions are
 *    an append-only record of what the live item *has been*. Staging by reference would mean every
 *    edit to a not-yet-live version wrote a line into the history of a page that never showed it.
 *  - **Pre-flight validation instead of atomicity.** The scope doc asks what happens when item 4 of
 *    12 fails at publish time. It cannot be answered with a transaction: D1 has no interactive
 *    transactions, and each item's publish is already its own batch of path rewrites, redirects, and
 *    a revision. So the check moves earlier — every staged version is validated *before* anything is
 *    written, which turns the overwhelmingly common failure into "nothing happened, here is what to
 *    fix". `release_items.published_at` then makes the residue of a genuinely unexpected failure
 *    resumable rather than a puzzle.
 *  - **Staging is not publishing.** Putting an item in a release is queuing work, which a
 *    contributor may do; publishing the release is what reaches the public, and needs an editor.
 *    That answers the permission question SCOPE.md left open, and it falls out of the workflow graph
 *    rather than being a new rule: every transition into `published` already needs the editor role.
 */

export class ReleaseError extends Error {
  override name = 'ReleaseError';
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'not_open'
      | 'already_published'
      | 'item_not_found'
      | 'validation_failed'
      | 'in_use' = 'not_found',
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message);
  }
}

/** A staged version with its JSON columns parsed. */
export interface StagedVersion extends Omit<ReleaseItemRow, 'data' | 'seo'> {
  data: Record<string, unknown>;
  seo: SeoData;
}

export function hydrateStagedVersion(row: ReleaseItemRow): StagedVersion {
  return {
    ...row,
    data: parseJson<Record<string, unknown>>(row.data, {}),
    seo: parseJson<SeoData>(row.seo, {}),
  };
}

/** A release plus the numbers every list of them wants. */
export interface ReleaseSummary extends ReleaseRow {
  itemCount: number;
  /** How many staged versions have already been applied. Non-zero only after a partial publish. */
  publishedCount: number;
  authorName: string | null;
  authorEmail: string | null;
}

/** A staged version alongside the live item it will overwrite. */
export interface StagedItemDetail extends StagedVersion {
  /** The live row. Never null in practice — `release_items` cascades — but read defensively. */
  live: {
    id: string;
    title: string;
    path: string;
    status: string;
    contentTypeId: string;
    contentTypeName: string;
  } | null;
  stagedByName: string | null;
  /**
   * Other unpublished releases holding this same item.
   *
   * The scope doc calls for an item to be stageable in more than one release at once, which is a
   * real hazard rather than an oversight: publishing one makes the other's copy stale, and the
   * staler one wins on whichever release nobody reopened. Surfaced on the screen rather than
   * forbidden by the schema, because staging the same page in "Spring launch" and "Tuition update"
   * is a thing editors legitimately do.
   */
  otherReleases: { id: string; name: string; status: ReleaseStatus }[];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListReleasesOptions {
  status?: ReleaseStatus;
  limit?: number;
  offset?: number;
}

export async function listReleases(
  db: Kysely<Database>,
  options: ListReleasesOptions = {},
): Promise<{ releases: ReleaseSummary[]; total: number }> {
  let query = db.selectFrom('releases');
  if (options.status) query = query.where('status', '=', options.status);

  const totalRow = await query
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirst();

  const rows = await query
    .leftJoin('users', 'users.id', 'releases.created_by')
    .selectAll('releases')
    .select(['users.name as author_name', 'users.email as author_email'])
    /**
     * Open releases first, then scheduled, then the rest — and newest within each.
     *
     * A list of releases is a worklist, not an archive: what somebody is assembling matters more
     * than what shipped last quarter, and ordering purely by date buries the former under the
     * latter within a term.
     */
    .orderBy(
      (eb) =>
        eb
          .case()
          .when('releases.status', '=', 'open')
          .then(0)
          .when('releases.status', '=', 'scheduled')
          .then(1)
          .when('releases.status', '=', 'blocked')
          .then(2)
          .else(3)
          .end(),
      'asc',
    )
    .orderBy('releases.created_at', 'desc')
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0)
    .execute();

  if (rows.length === 0) return { releases: [], total: Number(totalRow?.count ?? 0) };

  const counts = await db
    .selectFrom('release_items')
    .select((eb) => [
      'release_id',
      eb.fn.countAll<number>().as('n'),
      eb.fn
        .sum<number>(eb.case().when('published_at', 'is not', null).then(1).else(0).end())
        .as('done'),
    ])
    .where(
      'release_id',
      'in',
      rows.map((row) => row.id),
    )
    .groupBy('release_id')
    .execute();

  const byRelease = new Map(counts.map((row) => [row.release_id, row]));

  return {
    releases: rows.map((row) => ({
      ...row,
      itemCount: Number(byRelease.get(row.id)?.n ?? 0),
      publishedCount: Number(byRelease.get(row.id)?.done ?? 0),
      authorName: row.author_name,
      authorEmail: row.author_email,
    })),
    total: Number(totalRow?.count ?? 0),
  };
}

export async function getRelease(
  db: Kysely<Database>,
  id: string,
): Promise<ReleaseRow | undefined> {
  return db.selectFrom('releases').selectAll().where('id', '=', id).executeTakeFirst();
}

/**
 * Everything a release's own screen needs, in one call.
 *
 * The cross-release conflict lookup is one query for the whole release rather than one per item —
 * a launch with thirty pages in it should not cost thirty round trips to answer a question that is
 * the same shape for all of them.
 */
export async function getReleaseWithItems(
  db: Kysely<Database>,
  id: string,
): Promise<{ release: ReleaseRow; items: StagedItemDetail[] } | undefined> {
  const release = await getRelease(db, id);
  if (!release) return undefined;

  const rows = await db
    .selectFrom('release_items')
    .leftJoin('content_items', 'content_items.id', 'release_items.content_item_id')
    .leftJoin('content_types', 'content_types.id', 'content_items.content_type_id')
    .leftJoin('users', 'users.id', 'release_items.staged_by')
    .selectAll('release_items')
    .select([
      'content_items.title as live_title',
      'content_items.path as live_path',
      'content_items.status as live_status',
      'content_items.content_type_id as live_type_id',
      'content_types.name as live_type_name',
      'users.name as staged_by_name',
    ])
    .where('release_items.release_id', '=', id)
    .orderBy('content_items.path')
    .execute();

  const itemIds = rows.map((row) => row.content_item_id);
  const conflicts = await releaseConflicts(db, id, itemIds);

  return {
    release,
    items: rows.map((row) => ({
      ...hydrateStagedVersion(row),
      live: row.live_path
        ? {
            id: row.content_item_id,
            title: row.live_title!,
            path: row.live_path,
            status: row.live_status!,
            contentTypeId: row.live_type_id!,
            contentTypeName: row.live_type_name ?? 'Unknown type',
          }
        : null,
      stagedByName: row.staged_by_name,
      otherReleases: conflicts.get(row.content_item_id) ?? [],
    })),
  };
}

export async function getStagedItem(
  db: Kysely<Database>,
  releaseId: string,
  contentItemId: string,
): Promise<StagedVersion | undefined> {
  const row = await db
    .selectFrom('release_items')
    .selectAll()
    .where('release_id', '=', releaseId)
    .where('content_item_id', '=', contentItemId)
    .executeTakeFirst();

  return row ? hydrateStagedVersion(row) : undefined;
}

/**
 * The unpublished releases holding each of these items, excluding one.
 *
 * `published` releases are left out because they are history: their staged versions have already
 * been applied and cannot go live a second time, so naming them would report a conflict that
 * cannot happen.
 */
export async function releaseConflicts(
  db: Kysely<Database>,
  excludeReleaseId: string,
  contentItemIds: string[],
): Promise<Map<string, { id: string; name: string; status: ReleaseStatus }[]>> {
  const conflicts = new Map<string, { id: string; name: string; status: ReleaseStatus }[]>();
  if (contentItemIds.length === 0) return conflicts;

  const rows = await db
    .selectFrom('release_items')
    .innerJoin('releases', 'releases.id', 'release_items.release_id')
    .select([
      'release_items.content_item_id as content_item_id',
      'releases.id as id',
      'releases.name as name',
      'releases.status as status',
    ])
    .where('release_items.content_item_id', 'in', contentItemIds)
    .where('release_items.release_id', '!=', excludeReleaseId)
    .where('releases.status', '!=', 'published')
    .orderBy('releases.name')
    .execute();

  for (const row of rows) {
    const list = conflicts.get(row.content_item_id) ?? [];
    list.push({ id: row.id, name: row.name, status: row.status });
    conflicts.set(row.content_item_id, list);
  }

  return conflicts;
}

/**
 * Unpublished releases holding one item.
 *
 * Read by the item editor's banner and by `itemDeleteImpact`. Kept separate from
 * `releaseConflicts` because it has no release to exclude — the caller is an item, not a release.
 */
export async function openReleasesForItem(
  db: Kysely<Database>,
  contentItemId: string,
): Promise<{ id: string; name: string; status: ReleaseStatus }[]> {
  return db
    .selectFrom('release_items')
    .innerJoin('releases', 'releases.id', 'release_items.release_id')
    .select(['releases.id as id', 'releases.name as name', 'releases.status as status'])
    .where('release_items.content_item_id', '=', contentItemId)
    .where('releases.status', '!=', 'published')
    .orderBy('releases.name')
    .execute();
}

/** Open releases an item is *not* already in — what an "Add to release" control offers. */
export async function releasesAvailableFor(
  db: Kysely<Database>,
  contentItemId: string,
): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .selectFrom('releases')
    .select(['id', 'name'])
    // Only `open`. Adding to a release somebody has already scheduled would put content in front of
    // the public at a moment they chose without knowing about it — reopening it first is the
    // explicit act that makes that visible.
    .where('status', '=', 'open')
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('release_items')
            .select('release_items.id')
            .whereRef('release_items.release_id', '=', 'releases.id')
            .where('release_items.content_item_id', '=', contentItemId),
        ),
      ),
    )
    .orderBy('name')
    .execute();

  return rows;
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

export interface ReleaseProblem {
  /** Null when the problem is with the release itself rather than one of its items. */
  contentItemId: string | null;
  /** What to call the thing in a message — the staged title, or the release's name. */
  label: string;
  reason: string;
}

/**
 * Everything that would stop this release publishing, found before anything is written.
 *
 * This is the answer to "what happens if item 4 of 12 fails validation at publish time": it does
 * not, because the check runs first and refuses the whole publish. That is not merely a nicer
 * error — it is the only form of atomicity available here. A release publish is N item updates,
 * each already a batch of its own, and D1 offers no transaction spanning them.
 *
 * Re-run rather than stored. A release blocked at 3am because a required field was empty is
 * unblocked the moment somebody fills it in, and a cached list of reasons would still be accusing
 * them an hour later.
 */
export async function releasePreflight(
  db: Kysely<Database>,
  releaseId: string,
): Promise<{ ok: boolean; problems: ReleaseProblem[] }> {
  const release = await getRelease(db, releaseId);
  if (!release) {
    return {
      ok: false,
      problems: [{ contentItemId: null, label: 'Release', reason: 'It no longer exists.' }],
    };
  }

  const problems: ReleaseProblem[] = [];

  if (release.status === 'published') {
    problems.push({
      contentItemId: null,
      label: release.name,
      reason: 'It has already been published.',
    });
    return { ok: false, problems };
  }

  const staged = await db
    .selectFrom('release_items')
    .selectAll()
    .where('release_id', '=', releaseId)
    .execute();

  const pending = staged.filter((row) => row.published_at === null);

  if (staged.length === 0) {
    problems.push({
      contentItemId: null,
      label: release.name,
      reason: 'It has no content in it. Add at least one item before publishing.',
    });
  } else if (pending.length === 0) {
    problems.push({
      contentItemId: null,
      label: release.name,
      reason: 'Every item in it has already been published.',
    });
  }

  const blockTypes = await blockTypeRegistry(db);

  for (const row of pending) {
    const version = hydrateStagedVersion(row);
    const live = await getItem(db, row.content_item_id);

    if (!live) {
      problems.push({
        contentItemId: row.content_item_id,
        label: version.title,
        reason: 'The content item it was staged from no longer exists. Remove it from the release.',
      });
      continue;
    }

    /**
     * Legality first, and it is genuinely separate from permission.
     *
     * `archived → published` is not an arrow in the workflow graph — for an admin either — because
     * a page coming back from the archive goes through draft so that somebody reads it. A release
     * must not be a way around that, which is exactly what publishing without this check would be.
     */
    if (!isLegalTransition(live.status, 'published')) {
      problems.push({
        contentItemId: row.content_item_id,
        label: version.title,
        reason:
          `It is ${live.status.replace(/_/g, ' ')}, and there is no direct route from there to ` +
          'published. Return it to draft first, then re-stage it.',
      });
      continue;
    }

    const contentType = await getContentType(db, live.content_type_id);
    if (!contentType) {
      problems.push({
        contentItemId: row.content_item_id,
        label: version.title,
        reason: 'Its content type no longer exists.',
      });
      continue;
    }

    /**
     * Validated against the type's fields *as they are now*, not as they were when it was staged.
     *
     * A release can sit open for weeks, and a required field added in the meantime is exactly the
     * kind of change that turns a staged version into something the item editor would refuse. Better
     * found here than by `updateItem` throwing halfway down the list.
     */
    const validation = validateItemData(contentType.fields, version.data, { blockTypes });
    if (!validation.success) {
      const fields = Object.keys(validation.errors);
      const named = fields
        .map((apiId) => contentType.fields.find((f) => f.api_id === apiId)?.label ?? apiId)
        .join(', ');
      problems.push({
        contentItemId: row.content_item_id,
        label: version.title,
        reason: `Its content no longer validates: ${named}.`,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createRelease(
  db: Kysely<Database>,
  input: { name: string; description?: string | null; userId?: string | null },
): Promise<ReleaseRow> {
  const timestamp = now();
  const row: ReleaseRow = {
    id: newId(),
    name: input.name.trim(),
    description: input.description?.trim() || null,
    status: 'open',
    publish_at: null,
    published_at: null,
    created_by: input.userId ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('releases').values(row).execute();
  return row;
}

export async function updateRelease(
  db: Kysely<Database>,
  id: string,
  input: { name?: string; description?: string | null },
): Promise<ReleaseRow> {
  const release = await getRelease(db, id);
  if (!release) throw new ReleaseError(`Release ${id} not found.`);

  const patch: Record<string, unknown> = { updated_at: now() };
  if (input.name !== undefined) patch.name = input.name.trim();
  // `undefined` means "not provided"; `null` means "clear it". Collapsing them with `??` is the
  // bug that let a PATCH silently ignore a request to remove a value elsewhere in this codebase.
  if (input.description !== undefined) patch.description = input.description?.trim() || null;

  await db.updateTable('releases').set(patch).where('id', '=', id).execute();
  return { ...release, ...patch } as ReleaseRow;
}

/**
 * Move a release between the states a person can put it in.
 *
 * `publish_at` is cleared the moment the status leaves `scheduled`, in every path — the same rule
 * `updateItem` and `publishDueItems` keep for content items, and for the same reason. A stale time
 * left behind is a booby trap: reschedule the release later without picking a new moment and it
 * inherits one in the past, which is to say it goes live the instant the next sweep runs.
 */
export async function setReleaseStatus(
  db: Kysely<Database>,
  id: string,
  status: Extract<ReleaseStatus, 'open' | 'scheduled' | 'blocked'>,
  options: { publishAt?: string | null; actor?: Pick<User, 'id' | 'email'> | null } = {},
): Promise<ReleaseRow> {
  const release = await getRelease(db, id);
  if (!release) throw new ReleaseError(`Release ${id} not found.`);

  if (release.status === 'published') {
    throw new ReleaseError(
      'That release has already been published. Create a new one for further changes.',
      'already_published',
    );
  }

  if (status === 'scheduled' && !options.publishAt) {
    throw new ReleaseError('Scheduling a release needs a date and time.', 'validation_failed', {
      publishAt: ['Pick when this release should go live.'],
    });
  }

  const timestamp = now();
  const patch = {
    status,
    publish_at: status === 'scheduled' ? (options.publishAt ?? null) : null,
    updated_at: timestamp,
  };

  await db.updateTable('releases').set(patch).where('id', '=', id).execute();

  await recordAuditEntry(db, {
    action: `release.${status}`,
    subjectType: 'release',
    subjectId: id,
    subjectLabel: release.name,
    actor: options.actor ?? null,
    detail: { from: release.status, to: status, publishAt: patch.publish_at },
  });

  return { ...release, ...patch };
}

/**
 * What has to be cleared before a release can be deleted.
 *
 * Same shape and same reasoning as `contentTypeDeleteBlockers` and `itemDeleteImpact`: one function
 * that both the guard and the screen read, so a screen cannot decide for itself that a delete would
 * succeed and then be refused. Blockers are phrased as standalone clauses so they read correctly
 * both bulleted and after the error's `Cannot delete X:` prefix.
 */
export async function releaseDeleteBlockers(
  db: Kysely<Database>,
  id: string,
): Promise<string[]> {
  const release = await getRelease(db, id);
  if (!release) return ['it no longer exists.'];

  if (release.status === 'published') {
    /**
     * A published release is the only record of which pages went live together.
     *
     * The audit log records that it published, but not its contents — entries name one subject, and
     * a launch is a set. Deleting the release would leave those entries pointing at a name nobody
     * can look up, which is the failure mode the log is denormalised to avoid.
     */
    return [
      'it has already been published, and is the record of which items went live together. ' +
        'Create a new release for further changes.',
    ];
  }

  return [];
}

export async function deleteRelease(db: Kysely<Database>, id: string): Promise<void> {
  const blockers = await releaseDeleteBlockers(db, id);
  if (blockers.length > 0) {
    // Enforced here rather than only in the route, so the REST API cannot do what the admin
    // refuses. The editor is not the boundary.
    throw new ReleaseError(`Cannot delete this release: ${blockers[0]}`, 'in_use');
  }

  // `release_items` cascades — a staged version has no meaning without its release.
  await db.deleteFrom('releases').where('id', '=', id).execute();
}

/**
 * Put an item's current authored content into a release.
 *
 * The snapshot is taken at stage time and then diverges: editing the staged version afterwards
 * changes the release's copy and leaves the live page alone, which is the whole point. Re-syncing
 * from the live item is a deliberate act (`restageItem`) rather than something that happens
 * silently, because a release is a decision about what will go live and an invisible refresh would
 * quietly change it.
 */
export async function stageItem(
  db: Kysely<Database>,
  releaseId: string,
  contentItemId: string,
  options: { actor?: Pick<User, 'id' | 'email'> | null } = {},
): Promise<StagedVersion> {
  const release = await getRelease(db, releaseId);
  if (!release) throw new ReleaseError(`Release ${releaseId} not found.`);

  if (release.status !== 'open') {
    throw new ReleaseError(
      `"${release.name}" is ${release.status} and is not accepting new content. Reopen it first.`,
      'not_open',
    );
  }

  const item = await getItem(db, contentItemId);
  if (!item) throw new ReleaseError(`Content item ${contentItemId} not found.`, 'item_not_found');

  const existing = await getStagedItem(db, releaseId, contentItemId);
  if (existing) return existing;

  const timestamp = now();
  const row: ReleaseItemRow = {
    id: newId(),
    release_id: releaseId,
    content_item_id: contentItemId,
    title: item.title,
    slug: item.slug,
    data: stringifyJson(item.data),
    seo: stringifyJson(item.seo),
    staged_by: options.actor?.id ?? null,
    published_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('release_items').values(row).execute();

  await recordAuditEntry(db, {
    action: 'release.item_staged',
    subjectType: 'release',
    subjectId: releaseId,
    subjectLabel: release.name,
    actor: options.actor ?? null,
    detail: { itemId: contentItemId, itemTitle: item.title, path: item.path },
  });

  return hydrateStagedVersion(row);
}

export async function unstageItem(
  db: Kysely<Database>,
  releaseId: string,
  contentItemId: string,
  options: { actor?: Pick<User, 'id' | 'email'> | null } = {},
): Promise<void> {
  const release = await getRelease(db, releaseId);
  if (!release) throw new ReleaseError(`Release ${releaseId} not found.`);

  if (release.status === 'published') {
    throw new ReleaseError(
      'That release has already been published; its contents are a record of what went live.',
      'already_published',
    );
  }

  const staged = await getStagedItem(db, releaseId, contentItemId);
  if (!staged) return;

  if (staged.published_at) {
    /**
     * Refused rather than silently allowed.
     *
     * A staged version with a `published_at` has already reached its item — removing the row would
     * erase the record of that while leaving the change live, and a resumed publish would then have
     * no way to know it had run.
     */
    throw new ReleaseError(
      'That item has already been published as part of this release and cannot be removed from it.',
      'already_published',
    );
  }

  await db
    .deleteFrom('release_items')
    .where('release_id', '=', releaseId)
    .where('content_item_id', '=', contentItemId)
    .execute();

  await recordAuditEntry(db, {
    action: 'release.item_unstaged',
    subjectType: 'release',
    subjectId: releaseId,
    subjectLabel: release.name,
    actor: options.actor ?? null,
    detail: { itemId: contentItemId, itemTitle: staged.title },
  });
}

export interface UpdateStagedItemInput {
  title?: string;
  slug?: string;
  data?: Record<string, unknown>;
  seo?: SeoData;
}

/**
 * Edit the version waiting inside a release, leaving the live page untouched.
 *
 * Validation runs here and not only at pre-flight, and that is a security property rather than a
 * convenience: `validateItemData` is where richtext is sanitised, and a staged version is stored
 * HTML that the admin renders in the editor long before anything publishes it. Deferring the
 * sanitising to publish time would leave unsanitised markup in the database and put it in front of
 * every editor who opened the release. The boundary is the write, here as everywhere else.
 */
export async function updateStagedItem(
  db: Kysely<Database>,
  releaseId: string,
  contentItemId: string,
  input: UpdateStagedItemInput,
): Promise<StagedVersion> {
  const release = await getRelease(db, releaseId);
  if (!release) throw new ReleaseError(`Release ${releaseId} not found.`);

  if (release.status === 'published') {
    throw new ReleaseError(
      'That release has already been published and can no longer be edited.',
      'already_published',
    );
  }

  const staged = await getStagedItem(db, releaseId, contentItemId);
  if (!staged) {
    throw new ReleaseError('That item is not in this release.', 'item_not_found');
  }

  const item = await getItem(db, contentItemId);
  if (!item) throw new ReleaseError(`Content item ${contentItemId} not found.`, 'item_not_found');

  const contentType = await getContentType(db, item.content_type_id);
  if (!contentType) throw new ReleaseError('Content type not found.', 'item_not_found');

  let data = staged.data;
  if (input.data !== undefined) {
    const validation = validateItemData(contentType.fields, input.data, {
      blockTypes: await blockTypeRegistry(db),
    });
    if (!validation.success) {
      throw new ReleaseError('Content failed validation.', 'validation_failed', validation.errors);
    }
    data = validation.data ?? {};
  }

  const timestamp = now();
  const patch = {
    title: input.title ?? staged.title,
    // A blank slug means "leave it alone", matching `updateItem`. Regenerating would silently move
    // the page at publish time and write a redirect nobody asked for.
    slug: input.slug?.trim() || staged.slug,
    data: stringifyJson(data),
    seo: stringifyJson(input.seo ?? staged.seo),
    updated_at: timestamp,
  };

  await db
    .updateTable('release_items')
    .set(patch)
    .where('release_id', '=', releaseId)
    .where('content_item_id', '=', contentItemId)
    .execute();

  return { ...staged, ...patch, data, seo: input.seo ?? staged.seo, updated_at: timestamp };
}

/**
 * Refresh a staged version from the live item, discarding edits made inside the release.
 *
 * The inverse of publishing, and needed for the case where a page changed on the site after it was
 * staged: without this the release would quietly revert those changes when it published, because a
 * staged version is a whole snapshot rather than a diff.
 */
export async function restageItem(
  db: Kysely<Database>,
  releaseId: string,
  contentItemId: string,
): Promise<StagedVersion> {
  const staged = await getStagedItem(db, releaseId, contentItemId);
  if (!staged) throw new ReleaseError('That item is not in this release.', 'item_not_found');

  const item = await getItem(db, contentItemId);
  if (!item) throw new ReleaseError(`Content item ${contentItemId} not found.`, 'item_not_found');

  return updateStagedItem(db, releaseId, contentItemId, {
    title: item.title,
    slug: item.slug,
    data: item.data,
    seo: item.seo,
  });
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export interface ReleasePublishResult {
  ok: boolean;
  /** Why nothing was written. Empty when pre-flight passed. */
  problems: ReleaseProblem[];
  published: { id: string; title: string; path: string }[];
  /** Items that failed *after* pre-flight passed — a genuinely unexpected write failure. */
  failed: { id: string; title: string; reason: string }[];
}

/**
 * Publish every staged version in a release.
 *
 * Ordered: pre-flight refuses the whole thing before a single write, then each staged version is
 * applied through `updateItem` — the ordinary path, so a staged slug change cascades to
 * descendants, writes its redirects, and appends a revision exactly as an editor's rename would.
 * Routing around it would mean a second implementation of the path rewrite, which is the part
 * people get wrong.
 *
 * A failure *after* pre-flight passed does not stop the loop. The remaining items are independent
 * pages, and holding eleven of them back because the twelfth hit an unexpected error would turn a
 * small problem into a missed launch. Each success is recorded on its own row, so re-running picks
 * up exactly what is left.
 */
export async function publishRelease(
  handle: TaprootDb,
  releaseId: string,
  options: { actor?: Pick<User, 'id' | 'email'> | null } = {},
): Promise<ReleasePublishResult> {
  const { db } = handle;

  const release = await getRelease(db, releaseId);
  if (!release) throw new ReleaseError(`Release ${releaseId} not found.`);

  const preflight = await releasePreflight(db, releaseId);
  if (!preflight.ok) {
    return { ok: false, problems: preflight.problems, published: [], failed: [] };
  }

  const staged = await db
    .selectFrom('release_items')
    .selectAll()
    .where('release_id', '=', releaseId)
    .where('published_at', 'is', null)
    .execute();

  const published: ReleasePublishResult['published'] = [];
  const failed: ReleasePublishResult['failed'] = [];

  for (const row of staged) {
    const version = hydrateStagedVersion(row);

    try {
      const item = await getItem(db, row.content_item_id);
      if (!item) throw new Error('The content item no longer exists.');

      const contentType = await getContentType(db, item.content_type_id);
      if (!contentType) throw new Error('The content type no longer exists.');

      const updated = await updateItem(handle, contentType, contentType.fields, item.id, {
        title: version.title,
        slug: version.slug,
        status: 'published',
        data: version.data,
        seo: version.seo,
        userId: options.actor?.id ?? null,
      });

      const timestamp = now();
      await db
        .updateTable('release_items')
        .set({ published_at: timestamp, updated_at: timestamp })
        .where('id', '=', row.id)
        .execute();

      await recordAuditEntry(db, {
        action: 'item.published',
        subjectType: 'item',
        subjectId: updated.id,
        subjectLabel: updated.title,
        actor: options.actor ?? null,
        detail: {
          from: item.status,
          to: 'published',
          path: updated.path,
          releaseId,
          releaseName: release.name,
        },
      });

      published.push({ id: updated.id, title: updated.title, path: updated.path });
    } catch (error) {
      failed.push({
        id: row.content_item_id,
        title: version.title,
        reason: error instanceof Error ? error.message : 'Unknown error.',
      });
    }
  }

  const timestamp = now();

  if (failed.length === 0) {
    await db
      .updateTable('releases')
      .set({
        status: 'published',
        published_at: timestamp,
        // Cleared for the same reason `updateItem` clears an item's: a time left behind on a
        // finished release is one a reschedule would inherit, in the past.
        publish_at: null,
        updated_at: timestamp,
      })
      .where('id', '=', releaseId)
      .execute();

    await recordAuditEntry(db, {
      action: 'release.published',
      subjectType: 'release',
      subjectId: releaseId,
      subjectLabel: release.name,
      actor: options.actor ?? null,
      detail: { itemCount: published.length, items: published.map((entry) => entry.path) },
    });
  } else {
    /**
     * Left in its current status rather than marked failed.
     *
     * Some of the release is live and some is not, and that is a state somebody has to look at.
     * Calling it `published` would hide the remainder; calling it `blocked` would suggest nothing
     * happened. What the screen shows is the per-item truth, which is where it actually lives.
     */
    await recordAuditEntry(db, {
      action: 'release.publish_failed',
      subjectType: 'release',
      subjectId: releaseId,
      subjectLabel: release.name,
      actor: options.actor ?? null,
      detail: {
        publishedCount: published.length,
        failedCount: failed.length,
        failures: failed.map((entry) => `${entry.title}: ${entry.reason}`),
      },
    });
  }

  return { ok: failed.length === 0, problems: [], published, failed };
}
