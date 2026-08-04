/**
 * How a listing is ordered.
 *
 * Its own module, importing nothing, because both halves of the system need it and they already
 * point at each other: `items.ts` imports `validateItemData` from `validation/fields.ts`, and the
 * `query` field's value schema in that file has to validate a sort. Defining it in either one makes
 * a cycle.
 *
 * Deliberately a **named set rather than a column plus a direction**. A caller handing over a column
 * name can order by anything the table happens to have — `id`, `created_by` — and the delivery API
 * would then be publishing the schema as its sort vocabulary. These five are the orders a listing
 * actually wants, and each is free to be a different expression: `newest` is not "the `published_at`
 * column, descending", it is `coalesce(published_at, created_at)`, so an item still awaiting its
 * sweep does not sort as though it had no date at all.
 *
 * Sorting by a value inside `data` — an event's own start date — is deliberately absent and arrives
 * with the derived value index, because `data` is TEXT and there is nothing to order by yet.
 */
export const ITEM_SORTS = [
  'path',
  'title',
  'newest',
  'oldest',
  'recently_updated',
  /**
   * By one of the item's *own* field values — an event's start date rather than its publish date.
   *
   * Which field is not named here: it comes from `ListItemsOptions.sortField`, because the field
   * belongs to the query being run rather than to the vocabulary of orders. Choosing one of these
   * with no `sortField` falls back to `path` rather than erroring, so a query field whose date
   * field has since been deleted still answers.
   */
  'field_asc',
  'field_desc',
] as const;

export type ItemSort = (typeof ITEM_SORTS)[number];

/**
 * What each order is called in the admin. One place, so the builder and the editor agree.
 *
 * The two field orders are worded generically because the field they refer to is only known at the
 * call site — the query field's control substitutes the field's own label ("Starts — soonest
 * first") when it has one.
 */
export const ITEM_SORT_LABELS: Record<ItemSort, string> = {
  path: 'Site order',
  title: 'Title, A to Z',
  newest: 'Newest first',
  oldest: 'Oldest first',
  recently_updated: 'Recently updated',
  field_asc: 'Soonest first',
  field_desc: 'Latest first',
};

/** Orders that mean nothing without a `sortField`, so a control can hide them when there is none. */
export const FIELD_SORTS: readonly ItemSort[] = ['field_asc', 'field_desc'];

export function isItemSort(value: unknown): value is ItemSort {
  return typeof value === 'string' && (ITEM_SORTS as readonly string[]).includes(value);
}
