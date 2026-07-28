import { sql, type Kysely } from 'kysely';

import type { BatchStatement } from '../db/batch.js';
import type { TaprootDb } from '../db/client.js';
import type {
  ContentItemRow,
  ContentStatus,
  ContentTypeRow,
  Database,
  FieldRow,
} from '../db/schema.js';
import { now, parseJson, stringifyJson } from '../db/values.js';
import { newId } from '../ids.js';
import { validateItemData } from '../validation/fields.js';
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

export interface ListItemsOptions {
  contentTypeId?: string;
  status?: ContentStatus;
  parentId?: string | null;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listItems(
  db: Kysely<Database>,
  options: ListItemsOptions = {},
): Promise<{ items: ContentItem[]; total: number }> {
  let query = db.selectFrom('content_items');

  if (options.contentTypeId) query = query.where('content_type_id', '=', options.contentTypeId);
  if (options.status) query = query.where('status', '=', options.status);
  if (options.parentId !== undefined) {
    query =
      options.parentId === null
        ? query.where('parent_id', 'is', null)
        : query.where('parent_id', '=', options.parentId);
  }
  if (options.search) {
    const needle = `%${options.search.toLowerCase()}%`;
    query = query.where((eb) =>
      eb.or([eb(sql`lower(title)`, 'like', needle), eb(sql`lower(path)`, 'like', needle)]),
    );
  }

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
export async function getItemByPath(
  db: Kysely<Database>,
  path: string,
  options: { publishedOnly?: boolean } = {},
): Promise<ContentItem | undefined> {
  let query = db.selectFrom('content_items').selectAll().where('path', '=', normalizePath(path));
  if (options.publishedOnly !== false) query = query.where('status', '=', 'published');

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
  userId?: string | null;
}

export async function createItem(
  handle: TaprootDb,
  contentType: ContentTypeRow,
  fields: FieldRow[],
  input: CreateItemInput,
): Promise<ContentItem> {
  const { db } = handle;

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

  const validation = validateItemData(fields, input.data ?? {});
  if (!validation.success) {
    throw new ContentItemError('Content failed validation.', 'validation_failed', validation.errors);
  }

  const parentId = contentType.kind === 'page' ? (input.parentId ?? null) : null;
  const parent = parentId ? await getItem(db, parentId) : undefined;
  if (parentId && !parent) {
    throw new ContentItemError(`Parent item ${parentId} not found.`, 'invalid_parent');
  }

  const siblings = await siblingSlugs(db, contentType.id, parentId);
  const slug = uniqueSlug(input.slug ?? slugify(input.title), siblings);
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
    created_by: input.userId ?? null,
    updated_by: input.userId ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('content_items').values(row).execute();
  return hydrateItem(row);
}

export interface UpdateItemInput {
  title?: string;
  slug?: string;
  parentId?: string | null;
  status?: ContentStatus;
  data?: Record<string, unknown>;
  seo?: SeoData;
  userId?: string | null;
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
    const validation = validateItemData(fields, input.data);
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
  const desiredSlug = input.slug !== undefined ? slugify(input.slug) : existing.slug;
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

  statements.push(
    db
      .updateTable('content_items')
      .set({
        title: input.title ?? existing.title,
        status,
        data: stringifyJson(data),
        seo: stringifyJson(input.seo ?? existing.seo),
        published_at:
          status === 'published' ? (existing.published_at ?? timestamp) : existing.published_at,
        updated_by: input.userId ?? existing.updated_by,
        updated_at: timestamp,
      })
      .where('id', '=', id),
  );

  await handle.batch(statements);

  return {
    ...existing,
    title: input.title ?? existing.title,
    slug,
    path,
    parent_id: parentId,
    depth,
    status,
    data,
    seo: input.seo ?? existing.seo,
    updated_at: timestamp,
  };
}

export async function deleteItem(handle: TaprootDb, id: string): Promise<void> {
  await handle.db.deleteFrom('content_items').where('id', '=', id).execute();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

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
      db.deleteFrom('redirects').where('from_path', '=', rewrite.newPath),

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
