import type { Kysely } from 'kysely';

/**
 * Let a content type say what its list screen shows and how it is ordered.
 *
 * Every list rendered the same five columns — title, path, status, updated, created — which is a
 * reasonable default for a page and tells you nothing useful about an event or a person. What an
 * editor wants to see is the thing that distinguishes one row from the next: an event's start date,
 * a person's job title, a photograph.
 *
 * ## Three columns rather than one blob
 *
 * `list_columns` is JSON because it is genuinely a list, and the two sort columns are separate
 * because they are separate facts — one names an order from a **closed vocabulary** (`ITEM_SORTS`)
 * and the other names a field. Folding them into one JSON object would put a value validated against
 * a fixed set inside a blob nothing type-checks, which is how `sort` ends up holding a column name
 * and the delivery API ends up publishing the schema as its sort vocabulary.
 *
 * ## Nullable, and null means "as before"
 *
 * A type that configures nothing keeps the five columns and `path` ordering it already had. That
 * matters more than usual here: this migration runs against deployments whose lists people are used
 * to, and a migration that changed what every screen looked like would be a surprise nobody asked
 * for. Configuring it is opt-in per type.
 *
 * ## No backfill, and nothing to reindex
 *
 * Unlike `0019` and `0021`, this stores a *preference*, not derived data. The values a column
 * displays come from `content_items.data`, which is already there, and the ordering comes from
 * `content_item_values`, which `planDerivedIndexes` has been maintaining since `0019`. There is no
 * `db:reindex` step.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('content_types')
    // A JSON array of column keys: a field's `api_id`, or one of the built-in names.
    .addColumn('list_columns', 'text')
    .execute();

  await db.schema
    .alterTable('content_types')
    // One of `ITEM_SORTS`. Null means `path`, which is what every list did before this.
    .addColumn('list_sort', 'text')
    .execute();

  await db.schema
    .alterTable('content_types')
    /*
     * The field `field_asc` and `field_desc` order by.
     *
     * Separate from `list_sort` because it is only meaningful for two of the seven orders, and
     * because a field named here can be deleted on another screen later — at which point the sort
     * falls back to `path` rather than erroring, exactly as a query field's `dateFieldApiId` does.
     */
    .addColumn('list_sort_field', 'text')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_types').dropColumn('list_sort_field').execute();
  await db.schema.alterTable('content_types').dropColumn('list_sort').execute();
  await db.schema.alterTable('content_types').dropColumn('list_columns').execute();
}
