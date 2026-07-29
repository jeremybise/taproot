import type { Kysely } from 'kysely';

import type { Database, FieldRow, ReusableBlockRow } from '../db/schema.js';
import { now, parseJson, stringifyJson } from '../db/values.js';
import { newId } from '../ids.js';
import { validateItemData, type BlockInstance } from '../validation/fields.js';

/**
 * Reusable blocks.
 *
 * A block instance promoted to a shared library. The case is content that appears on many pages and
 * has to change in one place — an office's contact details, a term's key dates, a closure notice.
 * Copying a block onto twelve pages means twelve edits, and in practice three of them get missed.
 *
 * **The reference is one-directional and the library owns the content.** An item that places a
 * reusable block stores `{ id, type, ref }` and no data of its own; the data comes from the library
 * row at read time. That asymmetry is the feature: an ordinary block belongs to its page and is
 * versioned with it, while this belongs to the library and editing it changes every page at once.
 *
 * It also means a page's revision history records *that* it referenced a reusable block, not what
 * that block said at the time. Restoring an old revision brings back the reference, and the
 * reference resolves to today's content. That is the correct behaviour for shared content — a
 * restored page should not silently resurrect last month's opening hours — but it is a real
 * difference from ordinary blocks and the admin says so where it matters.
 */

export class ReusableBlockError extends Error {
  override name = 'ReusableBlockError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'in_use' | 'validation_failed' | 'type_mismatch' = 'not_found',
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message);
  }
}

export interface ReusableBlock extends Omit<ReusableBlockRow, 'data'> {
  data: Record<string, unknown>;
}

function hydrate(row: ReusableBlockRow): ReusableBlock {
  return { ...row, data: parseJson<Record<string, unknown>>(row.data, {}) };
}

export async function listReusableBlocks(
  db: Kysely<Database>,
  options: { blockType?: string } = {},
): Promise<ReusableBlock[]> {
  let query = db.selectFrom('reusable_blocks').selectAll();
  if (options.blockType) query = query.where('block_type', '=', options.blockType);

  return (await query.orderBy('name').execute()).map(hydrate);
}

export async function getReusableBlock(
  db: Kysely<Database>,
  id: string,
): Promise<ReusableBlock | undefined> {
  const row = await db
    .selectFrom('reusable_blocks')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  return row ? hydrate(row) : undefined;
}

export interface CreateReusableBlockInput {
  name: string;
  description?: string | null;
  blockType: string;
  data: Record<string, unknown>;
  userId?: string | null;
}

/**
 * Promote a block into the library.
 *
 * The data is validated against the block type's fields here rather than trusted from the caller,
 * because this is a write path like any other and the REST API reaches it directly.
 */
export async function createReusableBlock(
  db: Kysely<Database>,
  fields: FieldRow[],
  input: CreateReusableBlockInput,
): Promise<ReusableBlock> {
  const validation = validateItemData(fields, input.data);
  if (!validation.success) {
    throw new ReusableBlockError(
      'Block content failed validation.',
      'validation_failed',
      validation.errors,
    );
  }

  const timestamp = now();
  const row: ReusableBlockRow = {
    id: newId(),
    name: input.name,
    description: input.description ?? null,
    block_type: input.blockType,
    data: stringifyJson(validation.data ?? {}),
    created_by: input.userId ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('reusable_blocks').values(row).execute();
  return hydrate(row);
}

export async function updateReusableBlock(
  db: Kysely<Database>,
  fields: FieldRow[],
  id: string,
  input: { name?: string; description?: string | null; data?: Record<string, unknown> },
): Promise<ReusableBlock> {
  const existing = await getReusableBlock(db, id);
  if (!existing) throw new ReusableBlockError(`Reusable block ${id} not found.`, 'not_found');

  let data = existing.data;
  if (input.data !== undefined) {
    const validation = validateItemData(fields, input.data);
    if (!validation.success) {
      throw new ReusableBlockError(
        'Block content failed validation.',
        'validation_failed',
        validation.errors,
      );
    }
    data = validation.data ?? {};
  }

  const patch = {
    name: input.name ?? existing.name,
    description: input.description === undefined ? existing.description : (input.description ?? null),
    data: stringifyJson(data),
    updated_at: now(),
  };

  await db.updateTable('reusable_blocks').set(patch).where('id', '=', id).execute();
  return { ...existing, ...patch, data };
}

/**
 * How many content items reference this reusable block.
 *
 * A `LIKE` over the stored `data` blob, for the same reason block-type usage is: references live
 * inside a content item's JSON and have no rows of their own. Only ever run on the library screens
 * and before a delete, where being right matters more than being fast.
 */
export async function countReusableBlockUsage(
  db: Kysely<Database>,
  id: string,
): Promise<number> {
  const row = await db
    .selectFrom('content_items')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('data', 'like', `%"ref":"${id}"%`)
    .executeTakeFirst();

  return Number(row?.count ?? 0);
}

/** Which items reference it, for the "still in use" list before a delete. */
export async function itemsUsingReusableBlock(
  db: Kysely<Database>,
  id: string,
  limit = 20,
): Promise<{ id: string; title: string; path: string }[]> {
  return db
    .selectFrom('content_items')
    .select(['id', 'title', 'path'])
    .where('data', 'like', `%"ref":"${id}"%`)
    .orderBy('path')
    .limit(limit)
    .execute();
}

/**
 * Delete a reusable block, refusing while anything still references it.
 *
 * Refusing rather than warning-and-proceeding: a reference whose target has gone would render as a
 * gap on a live page, and the pages affected are exactly the ones nobody is looking at — that is
 * why the content was shared in the first place.
 */
export async function deleteReusableBlock(db: Kysely<Database>, id: string): Promise<void> {
  const existing = await getReusableBlock(db, id);
  if (!existing) throw new ReusableBlockError(`Reusable block ${id} not found.`, 'not_found');

  const usage = await countReusableBlockUsage(db, id);
  if (usage > 0) {
    throw new ReusableBlockError(
      `Cannot delete "${existing.name}" while ${usage} content item(s) still use it. Replace or ` +
        `remove those references first.`,
      'in_use',
    );
  }

  await db.deleteFrom('reusable_blocks').where('id', '=', id).execute();
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** A block whose `data` has been filled in from the library, flagged so templates can tell. */
export interface ResolvedBlock extends BlockInstance {
  /** Set when this block came from the library, carrying the entry's name for the admin. */
  reusable?: { id: string; name: string };
}

/**
 * Fill in the data for any referenced blocks.
 *
 * Called by the public route and by the admin editor, so both see the same content — a preview that
 * resolved references differently from the live page would be a preview of something else.
 *
 * One query for the whole list rather than one per block: a page with six references to two
 * library entries costs one lookup, not six. A reference whose target has been deleted keeps its
 * envelope and gets empty data, so the page renders without it rather than throwing; deletion is
 * refused while references exist, so this is a torn-database case rather than a routine one.
 */
export async function resolveBlockReferences(
  db: Kysely<Database>,
  blocks: unknown,
): Promise<ResolvedBlock[]> {
  if (!Array.isArray(blocks)) return [];

  const list = blocks as ResolvedBlock[];
  const refs = [...new Set(list.map((block) => block?.ref).filter((ref): ref is string => !!ref))];
  if (refs.length === 0) return list;

  const rows = await db
    .selectFrom('reusable_blocks')
    .selectAll()
    .where('id', 'in', refs)
    .execute();

  const byId = new Map(rows.map((row) => [row.id, hydrate(row)]));

  return list.map((block) => {
    if (!block?.ref) return block;

    const entry = byId.get(block.ref);
    if (!entry) return { ...block, data: {} };

    return {
      ...block,
      // The library's type wins: if a reference somehow points at an entry of another type, the
      // data is that type's shape and rendering it as the stored `type` would be wrong.
      type: entry.block_type,
      data: entry.data,
      reusable: { id: entry.id, name: entry.name },
    };
  });
}

/** Resolve every block field on an item in one pass, returning a copy of its `data`. */
export async function resolveItemBlocks(
  db: Kysely<Database>,
  fields: FieldRow[],
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const blockFields = fields.filter((field) => field.type === 'block');
  if (blockFields.length === 0) return data;

  const resolved = { ...data };
  for (const field of blockFields) {
    resolved[field.api_id] = await resolveBlockReferences(db, data[field.api_id]);
  }

  return resolved;
}
