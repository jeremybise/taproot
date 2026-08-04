import type { Kysely } from 'kysely';

import type { BatchStatement } from '../db/batch.js';
import type { TaprootDb } from '../db/client.js';
import type { Database, FieldRow, FieldType } from '../db/schema.js';
import { parseJson } from '../db/values.js';

/**
 * The derived index of scalar field values.
 *
 * Rebuilt in the same atomic batch as the item write, exactly as `planAssignmentIndex` is, and for
 * the same reason: a stale row here is invisible until it wrongly answers a listing. The authored
 * value in `content_items.data` stays the source of truth — see `0019_item_values`.
 *
 * **Deliberately one planner, even though it currently produces one table's rows.** Full-text search
 * needs a second derived table rebuilt at exactly the same write points, and two planners added at
 * two different times is two chances to miss one of them; the *walks* differ (this one is top-level
 * scalars with no recursion, search flattens richtext and descends through blocks), but the call
 * sites must not.
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
 * Statements rebuilding one item's index rows.
 *
 * Synchronous and read-free, unlike `planAssignmentIndex` — there is nothing to check the existence
 * of, because a value is not a reference. That is what lets it be called from the cascading paths
 * where a read is not available.
 *
 * The delete is unconditional, for the reason the taxonomy planner states: removing a field from a
 * content type would otherwise strand its rows here forever, answering listings with values the
 * item no longer has.
 */
export function planValueIndex(
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

/**
 * Rebuild the index for every item.
 *
 * **Required after the migration, not optional.** The table is created empty, so until this has run
 * every query field answers nothing — and a migration cannot do it, because it needs each content
 * type's field definitions and a walk over stored JSON.
 *
 * Batched per item rather than per row, and sequential rather than parallel: this runs against a
 * production database and finishing a minute later is a better trade than saturating D1's
 * connection budget.
 */
export async function reindexValues(
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

  let done = 0;
  for (const item of items) {
    const fields = byType.get(item.content_type_id) ?? [];
    const data = parseJson<Record<string, unknown>>(item.data, {});

    // Through `batch` rather than statement by statement, so an item is never left with its old
    // rows deleted and its new ones not yet written — which is what a listing would read as the
    // item having no values at all.
    await handle.batch(planValueIndex(db, item.id, fields, data));

    done += 1;
    onProgress?.(done, items.length);
  }

  return { items: items.length };
}
