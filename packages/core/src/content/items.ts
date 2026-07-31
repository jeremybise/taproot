import { sql, type Kysely, type SelectQueryBuilder } from 'kysely';

import type { BatchStatement } from '../db/batch.js';
import type { TaprootDb } from '../db/client.js';
import type {
  ContentItemRow,
  ContentStatus,
  ContentTypeRow,
  Database,
  FieldRow,
  RevisionReason,
} from '../db/schema.js';
import { now, parseJson, stringifyJson } from '../db/values.js';
import { newId } from '../ids.js';
import { validateItemData } from '../validation/fields.js';
import {
  buildRevisionStatement,
  getRevision,
  revisionSequence,
  snapshotIsUnchanged,
  RevisionError,
} from './revisions.js';
import { planAssignmentIndex } from './taxonomies.js';
import { blockTypeRegistry } from './types.js';
import {
  buildCollectionPath,
  buildPath,
  computeSubtreeRewrite,
  normalizePath,
  slugify,
  uniqueSlug,
  wouldCreateCycle,
  type PathRewrite,
  type SubtreeNode,
} from './paths.js';

export class ContentItemError extends Error {
  override name = 'ContentItemError';
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'validation_failed'
      | 'cycle'
      | 'singleton_exists'
      | 'invalid_parent' = 'validation_failed',
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message);
  }
}

export interface ContentItem extends Omit<ContentItemRow, 'data' | 'seo'> {
  data: Record<string, unknown>;
  seo: SeoData;
}

/**
 * Per-item SEO overrides.
 *
 * Every key is optional and absence means "fall back", which is what `resolveSeo` implements. No
 * length limits live here on purpose — see SEO_GUIDANCE in seo.ts for why an over-length title is
 * a warning in the editor rather than a rejected save.
 */
export interface SeoData {
  metaTitle?: string;
  metaDescription?: string;
  ogImageId?: string;
  noIndex?: boolean;
}

export function hydrateItem(row: ContentItemRow): ContentItem {
  return {
    ...row,
    data: parseJson<Record<string, unknown>>(row.data, {}),
    seo: parseJson<SeoData>(row.seo, {}),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListItemsOptions extends ItemFilters {
  limit?: number;
  offset?: number;
}

/** The narrowing part of a list query, without paging. */
export interface ItemFilters {
  contentTypeId?: string;
  status?: ContentStatus;
  parentId?: string | null;
  search?: string;
  /**
   * Term ids to filter by — an item carrying any one of them matches.
   *
   * A *list* rather than a single id because a term filter means the whole branch: filing something
   * under "Sciences" should find it when someone filters by "Academics". The expansion is the
   * caller's, through `termIdsForBranch`, so this stays a synchronous query builder that the status
   * counts can share.
   *
   * `undefined` means no filter. An empty array means *nothing matches*, following `listMedia`'s
   * precedent — with `in ()` being a syntax error, the tempting fallthrough is the dangerous one,
   * because it silently turns "filter by a term with no members" into "show everything".
   */
  termIds?: string[];
}

type ItemQuery = SelectQueryBuilder<Database, 'content_items', {}>;

/**
 * The WHERE clauses shared by the item list and its status counts.
 *
 * Extracted rather than duplicated because the counts label the list: a facet that applied a
 * different search than the rows beneath it would be worse than showing no count at all. Typed
 * against the pre-`select` builder, which is where both callers apply it.
 */
function applyItemFilters(query: ItemQuery, filters: ItemFilters): ItemQuery {
  let q = query;

  if (filters.contentTypeId) q = q.where('content_type_id', '=', filters.contentTypeId);
  if (filters.status) q = q.where('status', '=', filters.status);
  if (filters.parentId !== undefined) {
    q =
      filters.parentId === null
        ? q.where('parent_id', 'is', null)
        : q.where('parent_id', '=', filters.parentId);
  }
  if (filters.search) {
    const needle = `%${filters.search.toLowerCase()}%`;
    q = q.where((eb) =>
      eb.or([eb(sql`lower(title)`, 'like', needle), eb(sql`lower(path)`, 'like', needle)]),
    );
  }

  if (filters.termIds !== undefined) {
    const termIds = filters.termIds;

    /**
     * A correlated EXISTS against the derived assignment index.
     *
     * This is the read `taxonomy_assignments` exists to serve. Tags are authored into `data` and
     * the table is rebuilt from them, which looks like redundancy worth removing — what it buys is
     * exactly this: filtering a list by term without scanning every row and parsing its JSON blob.
     * The index shipped with the taxonomy work and this query never did, so until now the argument
     * for keeping it had no caller to point at.
     *
     * EXISTS rather than `id IN (subquery)` so an item carrying three terms in the branch still
     * counts once, without a DISTINCT over the join.
     */
    q =
      termIds.length === 0
        ? q.where(sql<boolean>`1 = 0`)
        : q.where((eb) =>
            eb.exists(
              eb
                .selectFrom('taxonomy_assignments')
                .select('taxonomy_assignments.content_item_id')
                .whereRef('taxonomy_assignments.content_item_id', '=', 'content_items.id')
                .where('taxonomy_assignments.term_id', 'in', termIds),
            ),
          );
  }

  return q;
}

export async function listItems(
  db: Kysely<Database>,
  options: ListItemsOptions = {},
): Promise<{ items: ContentItem[]; total: number }> {
  const query = applyItemFilters(db.selectFrom('content_items'), options);

  const totalRow = await query
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirst();

  const rows = await query
    .selectAll()
    .orderBy('path')
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0)
    .execute();

  return { items: rows.map(hydrateItem), total: Number(totalRow?.count ?? 0) };
}

/**
 * How many items sit in each status, under every filter *except* status.
 *
 * The omission is the point, and it is why `status` is excluded at the type level rather than by
 * convention. A status facet exists to answer "what would I get if I switched to Draft?", so
 * counting within the current status filter would answer with the number already on screen and
 * zero everywhere else. Statuses with no items are returned as 0 rather than omitted, so callers
 * can render a complete list without treating a missing key as a special case.
 */
export async function countItemsByStatus(
  db: Kysely<Database>,
  filters: Omit<ItemFilters, 'status'> = {},
): Promise<Record<ContentStatus, number>> {
  const rows = await applyItemFilters(db.selectFrom('content_items'), filters)
    .select('status')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .groupBy('status')
    .execute();

  const counts: Record<ContentStatus, number> = {
    draft: 0,
    in_review: 0,
    scheduled: 0,
    published: 0,
    archived: 0,
  };

  for (const row of rows) {
    // A row can carry a status this build does not know if the database is ahead of the code.
    // Dropping it keeps the shape honest instead of inventing a key nobody can render.
    if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.n);
  }

  return counts;
}

export async function getItem(
  db: Kysely<Database>,
  id: string,
): Promise<ContentItem | undefined> {
  const row = await db
    .selectFrom('content_items')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? hydrateItem(row) : undefined;
}

/**
 * Resolve a request path to a content item in a single indexed lookup.
 *
 * This is the hot path — every public page view runs it — which is why `path` is a unique indexed
 * column rather than something reconstructed by walking parents at request time.
 */
/**
 * The SQL condition for "a visitor may see this".
 *
 * One expression, used by every reader — the rule that decides what the public sees is exactly the
 * kind that must not be implemented twice. It lives here rather than in `scheduler.ts` because
 * `scheduler.ts` already depends on this module, and the reverse would close the loop.
 *
 * A `scheduled` item whose time has passed is included whether or not a sweep has run: that is
 * what makes "goes live at 9am" true on a deployment where nobody wired up a cron.
 */
export function visibleToPublic(eb: any) {
  return eb.or([
    eb('status', '=', 'published'),
    eb.and([
      eb('status', '=', 'scheduled'),
      eb('publish_at', 'is not', null),
      eb('publish_at', '<=', now()),
    ]),
  ]);
}

export async function getItemByPath(
  db: Kysely<Database>,
  path: string,
  options: { publishedOnly?: boolean } = {},
): Promise<ContentItem | undefined> {
  let query = db.selectFrom('content_items').selectAll().where('path', '=', normalizePath(path));
  /**
   * A scheduled item whose time has passed counts as visible, whether or not a sweep has run yet.
   *
   * That is what makes "goes live at 9am" true on a deployment where nobody wired up a cron —
   * which is every deployment on its first day. The sweep then makes the *stored* status agree;
   * without this rule, a missed cron would silently hold a launch.
   */
  if (options.publishedOnly !== false) query = query.where(visibleToPublic);

  const row = await query.executeTakeFirst();
  return row ? hydrateItem(row) : undefined;
}

/** Look up a redirect for a path that no longer resolves. */
export async function getRedirect(
  db: Kysely<Database>,
  path: string,
): Promise<{ to: string; status: number } | undefined> {
  const row = await db
    .selectFrom('redirects')
    .select(['to_path', 'status_code'])
    .where('from_path', '=', normalizePath(path))
    .executeTakeFirst();

  return row ? { to: row.to_path, status: row.status_code } : undefined;
}

export async function getChildren(
  db: Kysely<Database>,
  parentId: string | null,
): Promise<ContentItem[]> {
  const query = db.selectFrom('content_items').selectAll().orderBy('position').orderBy('title');
  const rows = await (parentId === null
    ? query.where('parent_id', 'is', null)
    : query.where('parent_id', '=', parentId)
  ).execute();

  return rows.map(hydrateItem);
}

/**
 * Read an item and every descendant, in one recursive query.
 *
 * `WITH RECURSIVE` works identically on SQLite, D1, and Postgres, which is what makes cascading
 * moves implementable rather than something to special-case away.
 */
export async function getSubtree(db: Kysely<Database>, rootId: string): Promise<SubtreeNode[]> {
  const result = await sql<SubtreeNode>`
    WITH RECURSIVE subtree(id, path, depth) AS (
      SELECT id, path, depth FROM content_items WHERE id = ${rootId}
      UNION ALL
      SELECT c.id, c.path, c.depth
      FROM content_items c
      JOIN subtree s ON c.parent_id = s.id
    )
    SELECT id, path, depth FROM subtree
  `.execute(db);

  return result.rows;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreateItemInput {
  contentTypeId: string;
  title: string;
  slug?: string;
  parentId?: string | null;
  status?: ContentStatus;
  data?: Record<string, unknown>;
  seo?: SeoData;
  /** When a `scheduled` item should go live. ISO 8601. */
  publishAt?: string | null;
  userId?: string | null;
}

export async function createItem(
  handle: TaprootDb,
  contentType: ContentTypeRow,
  fields: FieldRow[],
  input: CreateItemInput,
): Promise<ContentItem> {
  const { db } = handle;

  /**
   * A block type has no addressable instances, so it can never have a content item.
   *
   * Guarded here rather than only in the admin because block types share a table with content
   * types: a POST carrying a block type's id would otherwise create an item with no URL, invisible
   * in every list that filters blocks out.
   */
  if (contentType.kind === 'block') {
    throw new ContentItemError(
      `"${contentType.name}" is a block type. Blocks are placed into a block field on a content ` +
        `item; they do not have items of their own.`,
      'invalid_parent',
    );
  }

  // A singleton exists exactly once — that is the whole point of the kind.
  if (contentType.kind === 'singleton') {
    const existing = await db
      .selectFrom('content_items')
      .select('id')
      .where('content_type_id', '=', contentType.id)
      .executeTakeFirst();

    if (existing) {
      throw new ContentItemError(
        `"${contentType.name}" is a singleton and already has an item. Edit the existing one.`,
        'singleton_exists',
      );
    }
  }

  const validation = validateItemData(fields, input.data ?? {}, {
    blockTypes: await blockTypeRegistry(db),
  });
  if (!validation.success) {
    throw new ContentItemError('Content failed validation.', 'validation_failed', validation.errors);
  }

  const parentId = contentType.kind === 'page' ? (input.parentId ?? null) : null;
  const parent = parentId ? await getItem(db, parentId) : undefined;
  if (parentId && !parent) {
    throw new ContentItemError(`Parent item ${parentId} not found.`, 'invalid_parent');
  }

  const siblings = await siblingSlugs(db, contentType.id, parentId);
  // `||` rather than `??`: an editor who leaves the slug blank sends an empty string, not
  // undefined, and `??` would let it through to `uniqueSlug` — which slugifies it to nothing and
  // falls back to the literal "item". Blank means "derive it from the title".
  const slug = uniqueSlug(blankToUndefined(input.slug) || slugify(input.title), siblings);
  const path = resolveItemPath(contentType, parent?.path ?? null, slug);

  const timestamp = now();
  const status = input.status ?? 'draft';
  const row: ContentItemRow = {
    id: newId(),
    content_type_id: contentType.id,
    slug,
    parent_id: parentId,
    path,
    depth: parent ? parent.depth + 1 : 0,
    position: siblings.length,
    status,
    title: input.title,
    data: stringifyJson(validation.data ?? {}),
    seo: stringifyJson(input.seo ?? {}),
    published_at: status === 'published' ? timestamp : null,
    // Set through the scheduling path rather than at creation: an item is not scheduled until
    // somebody picks a time, and a create that lands straight in `scheduled` has none yet.
    publish_at: input.publishAt ?? null,
    created_by: input.userId ?? null,
    updated_by: input.userId ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  const assignments = await planAssignmentIndex(db, row.id, fields, validation.data ?? {});
  assertTermsExist(assignments.missing);

  // Batched rather than a bare insert so the item, its first revision, and its taxonomy index
  // cannot diverge — an item whose history begins one save late is a gap that can never be
  // reconstructed, and a stale index row is invisible until it wrongly answers a filtered listing.
  await handle.batch([
    db.insertInto('content_items').values(row),
    ...assignments.statements,
    buildRevisionStatement(db, {
      contentItemId: row.id,
      revisionNumber: 1,
      title: row.title,
      slug: row.slug,
      path: row.path,
      status,
      data: validation.data ?? {},
      seo: input.seo ?? {},
      reason: 'create',
      userId: input.userId ?? null,
      timestamp,
    }),
  ]);

  return hydrateItem(row);
}

export interface UpdateItemInput {
  title?: string;
  slug?: string;
  parentId?: string | null;
  status?: ContentStatus;
  data?: Record<string, unknown>;
  seo?: SeoData;
  /**
   * When a `scheduled` item should go live. ISO 8601, or null to clear.
   *
   * Cleared automatically whenever the status leaves `scheduled` — see the write below. A stale
   * time left on a published page is a booby trap: reschedule it later and it goes live in the
   * past, which is to say immediately.
   */
  publishAt?: string | null;
  userId?: string | null;
  /**
   * How the resulting revision should be labelled. Defaults to `save`.
   *
   * Only `restoreRevision` sets this, to mark that a save came from restoring earlier content
   * rather than from someone editing. It is on the input rather than a separate code path because
   * a restore *is* an ordinary update — same validation, same path cascade, same redirects.
   */
  revisionReason?: RevisionReason;
  /** The revision number being restored. Meaningful only with `revisionReason: 'restore'`. */
  restoredFrom?: number | null;
}

/**
 * Update an item, cascading path changes to its descendants.
 *
 * When the slug or parent changes, every descendant's path changes with it, and each moved path
 * gets a redirect written automatically. Doing that by hand is what people forget, which is why
 * it happens here rather than being left to whoever remembers.
 *
 * The whole rewrite is submitted as one atomic batch, so a partially-renamed tree is not a state
 * the database can end up in.
 */
export async function updateItem(
  handle: TaprootDb,
  contentType: ContentTypeRow,
  fields: FieldRow[],
  id: string,
  input: UpdateItemInput,
): Promise<ContentItem> {
  const { db } = handle;

  const existing = await getItem(db, id);
  if (!existing) throw new ContentItemError(`Content item ${id} not found.`, 'not_found');

  let data = existing.data;
  if (input.data !== undefined) {
    const validation = validateItemData(fields, input.data, {
      blockTypes: await blockTypeRegistry(db),
    });
    if (!validation.success) {
      throw new ContentItemError(
        'Content failed validation.',
        'validation_failed',
        validation.errors,
      );
    }
    data = validation.data ?? {};
  }

  const timestamp = now();
  const status = input.status ?? existing.status;

  const parentChanged =
    input.parentId !== undefined && (input.parentId ?? null) !== existing.parent_id;

  // A blank slug on update means "leave it alone", not "regenerate". Regenerating would silently
  // move the page and write a redirect every time someone saved with the field cleared.
  const submittedSlug = blankToUndefined(input.slug);
  const desiredSlug = submittedSlug ? slugify(submittedSlug) || existing.slug : existing.slug;
  const slugChanged = desiredSlug !== existing.slug;

  const statements: BatchStatement[] = [];
  let slug = existing.slug;
  let path = existing.path;
  let parentId = existing.parent_id;
  let depth = existing.depth;

  if ((parentChanged || slugChanged) && contentType.kind !== 'singleton') {
    const subtree = await getSubtree(db, id);
    const nextParentId = parentChanged ? (input.parentId ?? null) : existing.parent_id;

    // Re-parenting a node under its own descendant would detach the whole subtree from the site.
    if (wouldCreateCycle(subtree, nextParentId)) {
      throw new ContentItemError(
        'A content item cannot be moved underneath itself or one of its own descendants.',
        'cycle',
      );
    }

    const parent = nextParentId ? await getItem(db, nextParentId) : undefined;
    if (nextParentId && !parent) {
      throw new ContentItemError(`Parent item ${nextParentId} not found.`, 'invalid_parent');
    }

    const taken = await siblingSlugs(db, contentType.id, nextParentId, id);
    slug = uniqueSlug(desiredSlug, taken);
    path = resolveItemPath(contentType, parent?.path ?? null, slug);
    parentId = nextParentId;
    depth = parent ? parent.depth + 1 : 0;

    const rewrites = computeSubtreeRewrite(subtree, id, path);
    statements.push(
      ...buildRewriteStatements(db, rewrites, { rootId: id, parentId, slug, timestamp }),
    );
    statements.push(...buildRedirectStatements(db, rewrites, timestamp));
  }

  const title = input.title ?? existing.title;
  const seo = input.seo ?? existing.seo;

  statements.push(
    db
      .updateTable('content_items')
      .set({
        title,
        status,
        data: stringifyJson(data),
        seo: stringifyJson(seo),
        published_at:
          status === 'published' ? (existing.published_at ?? timestamp) : existing.published_at,
        /**
         * Cleared the moment the status leaves `scheduled`.
         *
         * A stale time left behind on a published or archived page is a booby trap: schedule it
         * again months later, and the sweep sees a `publish_at` in the past and takes it live
         * immediately. Tying the value's lifetime to the status it belongs to is what stops that.
         */
        publish_at:
          status === 'scheduled'
            ? (input.publishAt ?? existing.publish_at)
            : null,
        updated_by: input.userId ?? existing.updated_by,
        updated_at: timestamp,
      })
      .where('id', '=', id),
  );

  /**
   * Append a revision describing the item as it will be *after* this save.
   *
   * Both reads happen here, before the batch is submitted, because a batch cannot read its own
   * writes. Two cases skip the append:
   *
   * - Nothing about the authored content changed, so the previous revision already says this.
   * - ...unless the item has no revisions at all, which means it predates this table. Backfilling
   *   its current state gives the history a floor to diff against instead of starting blank.
   */
  const assignments = await planAssignmentIndex(db, id, fields, data);
  assertTermsExist(assignments.missing);
  statements.push(...assignments.statements);

  const sequence = await revisionSequence(db, id);
  const after = { title, slug, status, data, seo };
  if (sequence.count === 0 || !snapshotIsUnchanged(existing, after)) {
    statements.push(
      buildRevisionStatement(db, {
        contentItemId: id,
        revisionNumber: sequence.latest + 1,
        ...after,
        path,
        reason: input.revisionReason ?? 'save',
        restoredFrom: input.restoredFrom ?? null,
        userId: input.userId ?? existing.updated_by,
        timestamp,
      }),
    );
  }

  await handle.batch(statements);

  return {
    ...existing,
    title,
    slug,
    path,
    parent_id: parentId,
    depth,
    status,
    data,
    seo,
    updated_at: timestamp,
  };
}

/**
 * Restore an item to an earlier revision.
 *
 * Deliberately routed through `updateItem` rather than writing the old row back directly. A
 * revision stores the slug, so restoring one can move the page — and that has to cascade to every
 * descendant's path and write the redirects, exactly as an ordinary rename does. Writing the
 * snapshot back verbatim would restore the content and quietly corrupt the tree.
 *
 * The restore appends a new revision rather than truncating the log back to the restored point.
 * History stays append-only, so restoring the wrong revision is itself undoable.
 */
export async function restoreRevision(
  handle: TaprootDb,
  contentType: ContentTypeRow,
  fields: FieldRow[],
  itemId: string,
  revisionId: string,
  userId?: string | null,
): Promise<ContentItem> {
  const revision = await getRevision(handle.db, revisionId);
  if (!revision) {
    throw new RevisionError(`Revision ${revisionId} not found.`, 'not_found');
  }

  // Without this an editor could restore one item's content over another's by pasting an id.
  if (revision.content_item_id !== itemId) {
    throw new RevisionError(
      'That revision belongs to a different content item.',
      'wrong_item',
    );
  }

  return updateItem(handle, contentType, fields, itemId, {
    title: revision.title,
    slug: revision.slug,
    status: revision.status,
    data: revision.data,
    seo: revision.seo,
    userId,
    revisionReason: 'restore',
    restoredFrom: revision.revision_number,
  });
}

/**
 * What has to be cleared before this item can be deleted, and what merely changes if it is.
 *
 * Same shape and same reasoning as `contentTypeDeleteBlockers`: one function that both the guard
 * and the screen read, so a screen cannot work out for itself that a delete would succeed and then
 * be refused. Blockers are phrased as standalone clauses so they read correctly both bulleted and
 * after the error's `Cannot delete X:` prefix.
 *
 * The split between the two lists is the difference between a broken invariant and a consequence.
 * Descendants block, because `parent_id` is `ON DELETE SET NULL` and the delete would leave them
 * at root with a `path` and `depth` still describing where they used to be — the materialised path
 * and the tree would disagree, which nothing downstream expects. A menu entry or an incoming
 * relation is a consequence: both already degrade visibly and on purpose, so the editor should be
 * told rather than stopped.
 */
export interface ItemDeleteImpact {
  blockers: string[];
  warnings: string[];
}

export async function itemDeleteImpact(
  db: Kysely<Database>,
  itemId: string,
): Promise<ItemDeleteImpact> {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const item = await db
    .selectFrom('content_items')
    .select(['id', 'path'])
    .where('id', '=', itemId)
    .executeTakeFirst();

  if (!item) return { blockers: ['it no longer exists.'], warnings };

  const children = await db
    .selectFrom('content_items')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('parent_id', '=', itemId)
    .executeTakeFirst();

  const childCount = Number(children?.count ?? 0);
  if (childCount > 0) {
    blockers.push(
      `${childCount} item(s) sit beneath it. Move or delete them first, or they are left at the ` +
        'top level with URLs that still describe the old position.',
    );
  }

  const menuEntries = await db
    .selectFrom('menu_items')
    .innerJoin('menus', 'menus.id', 'menu_items.menu_id')
    .select(['menus.name as menu_name'])
    .where('menu_items.content_item_id', '=', itemId)
    .execute();

  if (menuEntries.length > 0) {
    const names = [...new Set(menuEntries.map((entry) => entry.menu_name))].join(', ');
    warnings.push(
      `${menuEntries.length} menu item(s) point at it, in: ${names}. They stay in the admin as ` +
        'broken entries and stop rendering on the site.',
    );
  }

  const referencing = await itemsReferencing(db, itemId, 20);
  if (referencing.length > 0) {
    const titles = referencing
      .slice(0, 5)
      .map((reference) => reference.title)
      .join(', ');
    const more = referencing.length > 5 ? `, and ${referencing.length - 5} more` : '';
    warnings.push(
      `${referencing.length} item(s) reference it through a relation field: ${titles}${more}. ` +
        'Those fields keep the id and show it as missing.',
    );
  }

  return { blockers, warnings };
}

export class ItemError extends Error {
  constructor(
    message: string,
    readonly code: 'in_use',
  ) {
    super(message);
    this.name = 'ItemError';
  }
}

export async function deleteItem(handle: TaprootDb, id: string): Promise<void> {
  const { blockers } = await itemDeleteImpact(handle.db, id);
  if (blockers.length > 0) {
    // Enforced here rather than only in the route, so the REST API cannot do what the admin
    // refuses. The editor is not the boundary.
    throw new ItemError(`Cannot delete this item: ${blockers[0]}`, 'in_use');
  }

  await handle.db.deleteFrom('content_items').where('id', '=', id).execute();
}

/** One item pointing at another through a `relation` field. */
export interface IncomingReference {
  id: string;
  title: string;
  path: string;
  status: ContentStatus;
  /** The relation field on the referring item that points here. */
  fieldApiId: string;
  fieldLabel: string;
  /**
   * What this side of the relationship is called, from the field's `reverseLabel`.
   *
   * The config has collected this since the field type was designed and nothing ever read it,
   * which is what made the reverse side of a relation a promise rather than a feature.
   */
  reverseLabel: string | null;
  contentTypeName: string;
}

/**
 * Which items point at this one through a relation field.
 *
 * The reverse side of `relation`, which SCOPE names as the thing Wolly gets wrong. Without it a
 * relation is one-directional in practice: an editor looking at a page has no way to know what
 * depends on it, and finds out by deleting it.
 *
 * Two steps, and the first is what makes the second honest. Relation targets live in another
 * type's JSON `config`, so the set of fields that *could* point here is found by reading the
 * `fields` table; only then is `content_items.data` searched, narrowed to the types that own one
 * of those fields. A `LIKE` for the bare id across every item would also match the id sitting in
 * a text field or a block's media reference, and would report a relationship that does not exist.
 *
 * Same trade as `countBlockUsage`: relation values live inside a JSON blob and have no rows of
 * their own, so this cannot be an indexed join. It runs on one screen and when deleting an item,
 * and is bounded by `limit`.
 */
export async function itemsReferencing(
  db: Kysely<Database>,
  itemId: string,
  limit = 50,
): Promise<IncomingReference[]> {
  const item = await db
    .selectFrom('content_items')
    .select('content_type_id')
    .where('id', '=', itemId)
    .executeTakeFirst();

  if (!item) return [];

  const relationFields = await db
    .selectFrom('fields')
    .selectAll()
    .where('type', '=', 'relation')
    .execute();

  const pointingHere = relationFields.filter((field) => {
    try {
      const config = JSON.parse(field.config) as { targetContentTypeId?: string | null };
      return config.targetContentTypeId === item.content_type_id;
    } catch {
      return false;
    }
  });

  if (pointingHere.length === 0) return [];

  const ownerTypeIds = [...new Set(pointingHere.map((field) => field.content_type_id))];

  const candidates = await db
    .selectFrom('content_items')
    .innerJoin('content_types', 'content_types.id', 'content_items.content_type_id')
    .select([
      'content_items.id as id',
      'content_items.title as title',
      'content_items.path as path',
      'content_items.status as status',
      'content_items.content_type_id as content_type_id',
      'content_items.data as data',
      'content_types.name as content_type_name',
    ])
    .where('content_items.content_type_id', 'in', ownerTypeIds)
    .where('content_items.data', 'like', `%${itemId}%`)
    .orderBy('content_items.path')
    .execute();

  const references: IncomingReference[] = [];

  for (const candidate of candidates) {
    const data = parseJson<Record<string, unknown>>(candidate.data, {});

    for (const field of pointingHere) {
      if (field.content_type_id !== candidate.content_type_id) continue;

      // Checked against the field's own key rather than trusting the `LIKE`, which is only a
      // prefilter — it matches the id anywhere in the blob, including places that are not a
      // relation to it at all.
      const stored = data[field.api_id];
      const points = Array.isArray(stored) ? stored.includes(itemId) : stored === itemId;
      if (!points) continue;

      let reverseLabel: string | null = null;
      try {
        reverseLabel =
          (JSON.parse(field.config) as { reverseLabel?: string }).reverseLabel ?? null;
      } catch {
        // A malformed config costs the group its name, not the reference its visibility.
      }

      references.push({
        id: candidate.id,
        title: candidate.title,
        path: candidate.path,
        status: candidate.status as ContentStatus,
        fieldApiId: field.api_id,
        fieldLabel: field.label,
        reverseLabel,
        contentTypeName: candidate.content_type_name,
      });

      if (references.length >= limit) return references;
    }
  }

  return references;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Reject a save that references terms which do not exist.
 *
 * Caught here rather than left to the foreign key so the caller gets per-field messages in the
 * same shape as every other validation failure — and so the whole batch is never submitted, rather
 * than failing at statement nine of twelve with a constraint error nobody can act on.
 */
function assertTermsExist(missing: Record<string, string[]>): void {
  const apiIds = Object.keys(missing);
  if (apiIds.length === 0) return;

  throw new ContentItemError(
    'Content failed validation.',
    'validation_failed',
    Object.fromEntries(
      apiIds.map((apiId) => [
        apiId,
        [
          missing[apiId]!.length === 1
            ? 'That term no longer exists. It may have been deleted while you were editing.'
            : 'Some of those terms no longer exist. They may have been deleted while you were editing.',
        ],
      ]),
    ),
  );
}

/**
 * Treat a blank or whitespace-only string as absent.
 *
 * Forms submit empty strings where an API client would send nothing at all, and the two must mean
 * the same thing to the services underneath.
 */
function blankToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Where an item's path comes from depends on its type's kind. */
export function resolveItemPath(
  contentType: ContentTypeRow,
  parentPath: string | null,
  slug: string,
): string {
  switch (contentType.kind) {
    case 'page':
      return buildPath(parentPath, slug);
    case 'collection':
      return buildCollectionPath(contentType.url_prefix, slug);
    case 'singleton':
      // Singletons are edited and rendered through other content, never routed to directly.
      return `/__singleton/${contentType.api_id}`;
    case 'block':
      // Unreachable through the normal path: `createItem` refuses a block type before it gets
      // here. Kept explicit rather than folded into the default so the exhaustiveness check keeps
      // working, and so reaching it names the actual mistake.
      throw new Error(
        `Block types have no items and therefore no path. "${contentType.api_id}" should never ` +
          `have reached path resolution.`,
      );
    default: {
      const exhaustive: never = contentType.kind;
      throw new Error(`Unhandled content type kind: ${String(exhaustive)}`);
    }
  }
}

async function siblingSlugs(
  db: Kysely<Database>,
  contentTypeId: string,
  parentId: string | null,
  excludeId?: string,
): Promise<string[]> {
  let query = db.selectFrom('content_items').select('slug');

  // Collection items are siblings of every other item of their type; page items are siblings only
  // under the same parent.
  query =
    parentId === null
      ? query.where('parent_id', 'is', null).where('content_type_id', '=', contentTypeId)
      : query.where('parent_id', '=', parentId);

  if (excludeId) query = query.where('id', '!=', excludeId);

  return (await query.execute()).map((row) => row.slug);
}

function buildRewriteStatements(
  db: Kysely<Database>,
  rewrites: PathRewrite[],
  root: { rootId: string; parentId: string | null; slug: string; timestamp: string },
): BatchStatement[] {
  return rewrites.map((rewrite) => {
    const patch: Record<string, unknown> = {
      path: rewrite.newPath,
      depth: rewrite.depth,
      updated_at: root.timestamp,
    };

    // Only the moved node itself changes parent and slug; descendants keep theirs and simply
    // inherit the new prefix.
    if (rewrite.id === root.rootId) {
      patch.parent_id = root.parentId;
      patch.slug = root.slug;
    }

    return db.updateTable('content_items').set(patch).where('id', '=', rewrite.id);
  });
}

/**
 * Write a redirect for every path that actually moved.
 *
 * Three things happen per moved path, and each exists because of a specific way redirects rot:
 *
 * 1. **Upsert the new redirect.** A page moved twice would otherwise collide on `from_path`.
 * 2. **Re-point existing redirects that aimed at the old path.** Without this, moving `/a` to `/b`
 *    and later `/b` to `/c` leaves `/a → /b → /c`, a chain the browser has to walk and search
 *    engines penalise. Re-pointing collapses it to `/a → /c`.
 * 3. **Delete any redirect leaving from the new path.** If something previously moved *away* from
 *    `/c` and a live page now occupies `/c`, that stale row is dead weight — the resolver finds
 *    the item first — and would resurrect wrongly if the item moved away again.
 */
function buildRedirectStatements(
  db: Kysely<Database>,
  rewrites: PathRewrite[],
  timestamp: string,
): BatchStatement[] {
  const moved = rewrites.filter((rewrite) => rewrite.oldPath !== rewrite.newPath);
  const statements: BatchStatement[] = [];

  for (const rewrite of moved) {
    statements.push(
      /**
       * Automatic rows only. `source: 'manual'` is documented on the table as "author-created and
       * never GC'd", and now that authors can create them, this is where that promise is kept.
       *
       * Keeping the row is safe as well as promised: the catch-all resolves a content item before
       * it consults the redirect table, so a manual redirect leaving a path a live item now
       * occupies is simply inert — and becomes correct again the moment that item moves away,
       * which is the situation the author wrote it for.
       */
      db
        .deleteFrom('redirects')
        .where('from_path', '=', rewrite.newPath)
        .where('source', '=', 'auto'),

      db
        .insertInto('redirects')
        .values({
          id: newId(),
          from_path: rewrite.oldPath,
          to_path: rewrite.newPath,
          status_code: 301,
          source: 'auto',
          content_item_id: rewrite.id,
          created_at: timestamp,
        })
        .onConflict((oc) =>
          oc.column('from_path').doUpdateSet({ to_path: rewrite.newPath, created_at: timestamp }),
        ),

      db
        .updateTable('redirects')
        .set({ to_path: rewrite.newPath })
        .where('to_path', '=', rewrite.oldPath)
        .where('from_path', '!=', rewrite.newPath),
    );
  }

  return statements;
}
