import type { ContentTypeRow, FieldRow } from '../db/schema.js';
import { parseJson } from '../db/values.js';
import { indexedValueKind, type IndexedValueKind } from './derivedIndex.js';
import { isItemSort, type ItemSort } from './itemSort.js';

/**
 * What a content type's list screen shows, and in what order.
 *
 * Every list rendered the same five columns, which is right for a page and says nothing useful about
 * an event or a person. What distinguishes one row from the next is usually a field — a start date,
 * a job title, a photograph — and that is a fact about the content type rather than about the admin.
 *
 * In core rather than in the `.astro` page for the reason `parentOptions.ts` and `status.ts` were
 * extracted: an `.astro` file's contents are neither type-checked nor reachable by the test suite,
 * so logic left inline there is logic that drifts without anything noticing.
 */

/** Columns that exist for every type, whatever its fields are. */
export const BUILT_IN_COLUMNS = ['title', 'path', 'status', 'updated', 'created'] as const;

export type BuiltInColumn = (typeof BUILT_IN_COLUMNS)[number];

/**
 * What every list showed before this was configurable, and what a type with no preference still
 * shows.
 *
 * Preserved exactly rather than trimmed to something tidier: this migration runs against
 * deployments whose lists people are used to reading, and quietly changing them all is a surprise
 * nobody asked for.
 */
export const DEFAULT_COLUMNS: BuiltInColumn[] = ['title', 'path', 'status', 'updated', 'created'];

export interface ListColumn {
  key: string;
  label: string;
  /** Built-ins render from the row; a field column renders from the item's `data`. */
  field: FieldRow | null;
  /**
   * Whether this column shows an image rather than text.
   *
   * A `media` field is the one column type that cannot come from `content_item_values` — that index
   * holds text, numbers and dates, and a media value is an id — so a thumbnail is resolved from
   * `data` and the media table instead. Worth flagging on the column rather than re-deriving it at
   * each render site.
   */
  thumbnail: boolean;
}

function isBuiltIn(key: string): key is BuiltInColumn {
  return (BUILT_IN_COLUMNS as readonly string[]).includes(key);
}

const BUILT_IN_LABELS: Record<BuiltInColumn, string> = {
  title: 'Title',
  path: 'Path',
  status: 'Status',
  updated: 'Updated',
  created: 'Created',
};

/**
 * Resolve the stored preference into columns that can actually be rendered.
 *
 * Three rules, each preventing a specific way a stored list goes wrong:
 *
 * - **A key naming a field that no longer exists is dropped**, not rendered as an empty column. A
 *   content type's fields are edited on a different screen from this preference, so the two go out
 *   of step as a matter of course rather than as a mistake.
 * - **`title` is always present**, and first if the preference did not place it. It carries the link
 *   to the editor, so a list without it is a table nobody can click out of — and that is a
 *   configuration an admin could otherwise save without noticing.
 * - **An empty or unparseable preference falls back to the defaults.** Same reasoning as
 *   `parseJson`: a bad stored value degrades to the sensible thing rather than taking the screen
 *   down.
 */
export function resolveListColumns(
  contentType: Pick<ContentTypeRow, 'list_columns'> & { fields?: FieldRow[] },
  fields: FieldRow[] = contentType.fields ?? [],
): ListColumn[] {
  const stored = parseJson<unknown>(contentType.list_columns ?? null, null);
  const keys =
    Array.isArray(stored) && stored.length > 0
      ? stored.filter((key): key is string => typeof key === 'string')
      : DEFAULT_COLUMNS;

  const byApiId = new Map(fields.map((field) => [field.api_id, field]));
  const columns: ListColumn[] = [];

  for (const key of keys) {
    if (isBuiltIn(key)) {
      columns.push({ key, label: BUILT_IN_LABELS[key], field: null, thumbnail: false });
      continue;
    }

    const field = byApiId.get(key);
    if (!field) continue;
    if (!COLUMN_FIELD_TYPES.has(field.type)) continue;

    columns.push({
      key,
      label: field.label,
      field,
      thumbnail: field.type === 'media',
    });
  }

  if (!columns.some((column) => column.key === 'title')) {
    columns.unshift({ key: 'title', label: BUILT_IN_LABELS.title, field: null, thumbnail: false });
  }

  return columns;
}

/**
 * Field types that can be a column.
 *
 * Narrower than "every field type", and the exclusions are the point. A `block` or `repeater` holds
 * a structure with no single reading; a `query` holds a rule; a `richtext` value is a paragraph,
 * and a column of flattened paragraphs is a table nobody can scan. Those are all better answered by
 * opening the item.
 *
 * `media` is in, and is the only one that renders as an image rather than text.
 */
const COLUMN_FIELD_TYPES = new Set([
  'text',
  'number',
  'boolean',
  'date',
  'select',
  'taxonomy',
  'relation',
  'link',
  'media',
  'snippet',
]);

/** Field types offered as a column in the settings picker, in field order. */
export function columnCandidates(fields: FieldRow[]): FieldRow[] {
  return fields.filter((field) => COLUMN_FIELD_TYPES.has(field.type));
}

/**
 * The order a list should use, resolved against the fields that exist *now*.
 *
 * Returns what `listItemSummaries` takes, so the caller passes it straight through rather than
 * re-deriving the shape. A `field_asc`/`field_desc` preference whose field has since been deleted —
 * or has become a type the value index does not carry — **drops back to `path`** rather than
 * erroring, which is the rule a query field's `dateFieldApiId` already follows: a live screen must
 * not break for a configuration change made weeks earlier on another screen.
 */
export function resolveListSort(
  contentType: Pick<ContentTypeRow, 'list_sort' | 'list_sort_field'>,
  fields: FieldRow[],
): { sort: ItemSort; sortField?: { apiId: string; kind: IndexedValueKind } } {
  const stored = contentType.list_sort;
  if (!isItemSort(stored)) return { sort: 'path' };

  if (stored !== 'field_asc' && stored !== 'field_desc') return { sort: stored };

  const named = contentType.list_sort_field;
  const field = named ? fields.find((entry) => entry.api_id === named) : undefined;
  const kind = field ? indexedValueKind(field.type) : null;

  if (!field || !kind) return { sort: 'path' };
  return { sort: stored, sortField: { apiId: field.api_id, kind } };
}
