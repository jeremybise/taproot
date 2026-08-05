import type { Kysely } from 'kysely';

import type { BatchStatement } from '../db/batch.js';
import type { TaprootDb } from '../db/client.js';
import type { Database, FieldRow, FieldType } from '../db/schema.js';
import { parseJson } from '../db/values.js';
import { MAX_BLOCK_DEPTH, repeaterRowFields } from '../validation/fields.js';
import { htmlToText } from './sanitizeHtml.js';
import { blockTypeRegistry } from './types.js';

/**
 * The derived indexes rebuilt from an item's `data`: scalar values, and searchable text.
 *
 * Both are rebuilt in the same atomic batch as the item write, exactly as `planAssignmentIndex` is,
 * and for the same reason: a stale row here is invisible until it wrongly answers a listing. The
 * authored value in `content_items.data` stays the source of truth — see `0019_item_values` and
 * `0021_item_text`.
 *
 * **Deliberately one planner, though it produces two tables' rows.** Two planners added at two
 * different times is two chances to miss one of the call sites, and a derived table rebuilt at a
 * *different* write point from its sibling is one of them going quietly stale. The *walks* differ —
 * values are top-level scalars with no recursion, text flattens richtext and descends through blocks
 * and repeater rows — but `planDerivedIndexes` is the only thing a call site names.
 */

/**
 * Field types that carry a value worth indexing.
 *
 * Top level only, and scalar only. A relation or media field stores ids that already have their own
 * resolution path; `taxonomy` has `taxonomy_assignments`, which is a better index than this one
 * because it understands branches. `richtext` is excluded because a body is prose — filtering or
 * ordering by it is not a thing anybody wants, and it is what the search index is for.
 *
 * Values inside blocks and repeater rows are excluded on purpose. "The events' start date" is a
 * property of the event, and a date buried in the third row of a repeater inside a block is not
 * something a listing can meaningfully order by — there would be several per item and no way to say
 * which one was meant.
 */
const INDEXED_TYPES = new Set<FieldType>(['text', 'number', 'boolean', 'date', 'select']);

/** How a field's values are compared, which decides which column carries them. */
export type IndexedValueKind = 'date' | 'number' | 'text';

export function indexedValueKind(type: FieldType): IndexedValueKind | null {
  if (type === 'date') return 'date';
  if (type === 'number' || type === 'boolean') return 'number';
  if (type === 'text' || type === 'select') return 'text';
  return null;
}

interface IndexRow {
  content_item_id: string;
  field_api_id: string;
  value_text: string | null;
  value_num: number | null;
  value_date: string | null;
}

/**
 * How long an indexed string may be.
 *
 * A text field can hold a paragraph and this index exists to sort and match, not to store. Truncating
 * keeps the table small and cannot affect ordering in any way somebody would notice — two values
 * agreeing for 200 characters sort together, which is the right answer anyway.
 */
const MAX_TEXT = 200;

function rowsForField(itemId: string, field: FieldRow, value: unknown): IndexRow[] {
  const kind = indexedValueKind(field.type);
  if (!kind) return [];

  // A multi-value `select` stores an array, and each member is its own row — so "audience is
  // alumni" matches an item that is also aimed at staff.
  const values = Array.isArray(value) ? value : [value];

  return values.flatMap((entry): IndexRow[] => {
    if (entry === null || entry === undefined || entry === '') return [];

    const base = { content_item_id: itemId, field_api_id: field.api_id };

    if (kind === 'number') {
      // Booleans index as 0/1 so `is_checked` and a numeric range share one column.
      const numeric = typeof entry === 'boolean' ? (entry ? 1 : 0) : Number(entry);
      if (!Number.isFinite(numeric)) return [];
      return [{ ...base, value_text: String(entry), value_num: numeric, value_date: null }];
    }

    if (kind === 'date') {
      if (typeof entry !== 'string') return [];
      /**
       * Normalised through `Date` so everything in the column is directly comparable. A `date`
       * field with `includeTime` off stores `2026-09-14` and with it on stores a full timestamp —
       * as text those sort together correctly, but `2026-09-14` compares as *before*
       * `2026-09-14T09:00:00Z`, which would drop an all-day event out of an "after 9am" window it
       * belongs in. Storing the parsed instant makes the comparison mean one thing.
       */
      const parsed = new Date(entry);
      if (Number.isNaN(parsed.getTime())) return [];
      return [
        { ...base, value_text: entry.slice(0, MAX_TEXT), value_num: null, value_date: parsed.toISOString() },
      ];
    }

    if (typeof entry !== 'string') return [];
    return [
      { ...base, value_text: entry.slice(0, MAX_TEXT), value_num: null, value_date: null },
    ];
  });
}

/**
 * The statements rebuilding one item's value rows.
 *
 * Not exported: `planDerivedIndexes` is the only entry a call site names, so the two indexes cannot
 * be rebuilt at different write points.
 *
 * The delete is unconditional, for the reason the taxonomy planner states: removing a field from a
 * content type would otherwise strand its rows here forever, answering listings with values the
 * item no longer has.
 */
function planValueIndex(
  db: Kysely<Database>,
  contentItemId: string,
  fields: FieldRow[],
  data: Record<string, unknown>,
): BatchStatement[] {
  const statements: BatchStatement[] = [
    db.deleteFrom('content_item_values').where('content_item_id', '=', contentItemId),
  ];

  const rows = fields
    .filter((field) => INDEXED_TYPES.has(field.type))
    .flatMap((field) => rowsForField(contentItemId, field, data[field.api_id]));

  /**
   * One insert for the lot rather than one per value.
   *
   * These join a batch that already holds path rewrites, redirects, a revision and the taxonomy
   * assignments, and D1 caps how many statements a batch may carry — a thirty-field item adding
   * thirty statements is how a save starts failing on a content type nobody thought was large.
   */
  if (rows.length > 0) statements.push(db.insertInto('content_item_values').values(rows));

  return statements;
}

// ---------------------------------------------------------------------------
// Searchable text
// ---------------------------------------------------------------------------

/**
 * How much of one item's prose is searchable.
 *
 * A bound rather than the whole thing, because `like '%needle%'` reads this column for every row it
 * considers — so an unbounded column makes one thirty-thousand-word policy document part of the cost
 * of everybody else's search. What it costs is stated plainly: a match beyond this point is missed.
 * 20,000 characters is roughly 3,000 words, which is longer than the pages a CMS like this holds and
 * far short of any dialect's row limit.
 */
const MAX_SEARCH_TEXT = 20_000;

/**
 * Gather every piece of prose an item holds, in field order.
 *
 * Unlike the value walk above this one **recurses**, because prose is where authors put it: a
 * paragraph inside a repeater row inside a block is exactly as much a part of the page as a
 * top-level body, and a search that could not see it would miss most of a composed homepage. The
 * bound is `MAX_BLOCK_DEPTH`, the same one `validateItemData` enforces, so a hand-written payload
 * cannot recurse this until the stack gives out.
 *
 * Only `text` and `richtext` contribute. The others are excluded on purpose rather than by
 * oversight:
 *
 * - `select` stores the option's *value* (`student_services`), which is a key an editor never sees.
 *   Matching it produces hits the visible page cannot explain.
 * - `media`, `relation`, `link` and `taxonomy` store ids. An id is not text somebody searches for,
 *   and a term's *name* belongs to the term rather than to the item — `taxonomy_assignments` is
 *   how that question gets asked.
 * - `embed` stores an address and a frame title. The address is not prose, and the title names a
 *   frame rather than describing the page — indexing it would answer a search for "video" with
 *   every page carrying one, which is a worse result than none. What is *inside* the frame belongs
 *   to another origin and is not this CMS's content in any sense.
 * - `number`, `boolean` and `date` are what the value index is for.
 * - `query` stores a rule, not an answer. Indexing the rule would match on the vocabulary of the
 *   query builder, and indexing the answer would make one item's text depend on another's.
 */
function collectText(
  out: string[],
  fields: FieldRow[],
  data: Record<string, unknown>,
  blockTypes: Map<string, { fields: FieldRow[] }> | undefined,
  depth: number,
): void {
  for (const field of fields) {
    const value = data[field.api_id];
    if (value === null || value === undefined) continue;

    if (field.type === 'text') {
      if (typeof value === 'string') out.push(value);
      continue;
    }

    if (field.type === 'richtext') {
      // The reason `htmlToText`'s docstring has always named search indexing. Matching the stored
      // HTML would match tag names and attribute values as readily as prose — a search for "title"
      // hitting every page carrying a `title` attribute — and would miss a phrase split across an
      // emphasis, because `<em>` sits in the middle of it.
      if (typeof value === 'string') out.push(htmlToText(value));
      continue;
    }

    if (field.type === 'repeater') {
      if (!Array.isArray(value)) continue;
      const subFields = repeaterRowFields(field);
      for (const row of value) {
        if (!row || typeof row !== 'object') continue;
        const rowData = (row as { data?: unknown }).data;
        if (rowData && typeof rowData === 'object') {
          collectText(out, subFields, rowData as Record<string, unknown>, blockTypes, depth);
        }
      }
      continue;
    }

    if (field.type === 'block') {
      if (!Array.isArray(value) || depth <= 0) continue;

      for (const raw of value) {
        if (!raw || typeof raw !== 'object') continue;
        const instance = raw as { type?: unknown; data?: unknown; ref?: unknown };
        if (typeof instance.type !== 'string') continue;

        /**
         * A reusable block contributes nothing, and that is a limitation worth stating rather than
         * hiding. Its content belongs to the library entry — the page stores only `{ id, type, ref }`
         * — so reaching it needs a read, which this planner deliberately cannot do: it is
         * synchronous so the paths that have no read available can still call it. Worse than the
         * read is the fan-out: text pulled in from the library would have to be rebuilt across every
         * referencing page each time the entry was edited, and nothing here can trigger that.
         *
         * So prose that lives *only* in a shared block is not findable through the pages that show
         * it. That is the same trade the feature already makes elsewhere — a referencing page's
         * revision records that it referenced the entry, never what the entry said.
         */
        const blockType = blockTypes?.get(instance.type);
        if (!blockType || !instance.data || typeof instance.data !== 'object') continue;

        collectText(
          out,
          blockType.fields,
          instance.data as Record<string, unknown>,
          blockTypes,
          depth - 1,
        );
      }
    }
  }
}

/**
 * The statement rebuilding one item's searchable text.
 *
 * An upsert rather than a delete and an insert, because there is exactly one row: two statements
 * would double this planner's share of a batch that already carries path rewrites, redirects, a
 * revision, the taxonomy assignments and the value rows — and D1 caps how many statements a batch
 * may hold.
 *
 * The row is written even when the item has no prose at all. An empty string means "indexed, holds
 * nothing"; a *missing* row means "never indexed", which is what every item looks like on a database
 * that has not run `db:reindex` since the migration. Collapsing the two would make that state
 * undiagnosable.
 *
 * The stored text keeps its original case. The query lowercases both sides, following the admin's
 * existing title search, and an excerpt drawn from this column has to read the way the page does.
 */
function planTextIndex(
  db: Kysely<Database>,
  contentItemId: string,
  fields: FieldRow[],
  data: Record<string, unknown>,
  blockTypes?: Map<string, { fields: FieldRow[] }>,
): BatchStatement[] {
  const parts: string[] = [];
  collectText(parts, fields, data, blockTypes, MAX_BLOCK_DEPTH);

  const text = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_TEXT);

  return [
    db
      .insertInto('content_item_text')
      .values({ content_item_id: contentItemId, text })
      .onConflict((oc) => oc.column('content_item_id').doUpdateSet({ text })),
  ];
}

export interface DerivedIndexOptions {
  /**
   * Block type schemas keyed by `api_id`, from `blockTypeRegistry`.
   *
   * Omitted, a block's contents are not indexed — which is right for a caller that has no registry
   * in hand and wrong for a write. Both write paths already load one for `validateItemData`, so
   * passing it costs nothing.
   */
  blockTypes?: Map<string, { fields: FieldRow[] }>;
}

/**
 * Every derived-index statement for one item, for the one call site shape that must not drift.
 *
 * Synchronous and read-free, unlike `planAssignmentIndex` — there is nothing to check the existence
 * of, because a value is not a reference. That is what lets it be called from the paths where a read
 * is not available.
 */
export function planDerivedIndexes(
  db: Kysely<Database>,
  contentItemId: string,
  fields: FieldRow[],
  data: Record<string, unknown>,
  options: DerivedIndexOptions = {},
): BatchStatement[] {
  return [
    ...planValueIndex(db, contentItemId, fields, data),
    ...planTextIndex(db, contentItemId, fields, data, options.blockTypes),
  ];
}

/**
 * Rebuild every derived index for every item.
 *
 * **Required after the migrations that add them, not optional.** Both tables are created empty, so
 * until this has run a query field answers as though nothing matched and a search finds only what
 * its title says — and a migration cannot do it, because it needs each content type's field
 * definitions and a walk over stored JSON.
 *
 * One walk rebuilds both, which is the same argument `planDerivedIndexes` makes: a command that
 * rebuilt one of them would leave a database half-indexed by whoever ran the older version.
 *
 * Batched per item rather than per row, and sequential rather than parallel: this runs against a
 * production database and finishing a minute later is a better trade than saturating D1's
 * connection budget.
 */
export async function reindexDerived(
  handle: TaprootDb,
  onProgress?: (done: number, total: number) => void,
): Promise<{ items: number }> {
  const { db } = handle;

  const items = await db
    .selectFrom('content_items')
    .select(['id', 'content_type_id', 'data'])
    .execute();

  const fieldRows = await db.selectFrom('fields').selectAll().execute();
  const byType = new Map<string, FieldRow[]>();
  for (const field of fieldRows) {
    const list = byType.get(field.content_type_id) ?? [];
    list.push(field as FieldRow);
    byType.set(field.content_type_id, list);
  }

  // Once for the whole run rather than per item: it is the same map for every one of them, and this
  // walks the entire site.
  const blockTypes = await blockTypeRegistry(db);

  let done = 0;
  for (const item of items) {
    const fields = byType.get(item.content_type_id) ?? [];
    const data = parseJson<Record<string, unknown>>(item.data, {});

    // Through `batch` rather than statement by statement, so an item is never left with its old
    // rows deleted and its new ones not yet written — which is what a listing would read as the
    // item having no values at all.
    await handle.batch(planDerivedIndexes(db, item.id, fields, data, { blockTypes }));

    done += 1;
    onProgress?.(done, items.length);
  }

  return { items: items.length };
}
