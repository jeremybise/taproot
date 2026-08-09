import type { Kysely } from 'kysely';

/**
 * Reusable text snippets: a value defined once and used in prose across the site.
 *
 * The table `reusable_blocks` is shaped after, one size down — that owns a region of a page, this
 * owns a value inside a sentence. Content stores `{{ api_id }}` and no copy, so editing the row
 * changes every page at once and there is no second copy to go stale.
 *
 * **`api_id` is unique and immutable**, which is the one real difference from `reusable_blocks`.
 * That table's `name` is a label and safe to rename; this column *is* the reference every stored
 * token names. The uniqueness index is what makes a token resolve to one row, and the immutability
 * is enforced above rather than here — SQLite has no way to refuse an update to a column.
 *
 * `value` and `display` are separate columns rather than one, and that is what lets a single row
 * serve both a sentence and a chart: prose substitutes `display` ("$4,500") while a block component
 * plots `value` ("4500"). Collapsing them would mean every consumer parsing currency back out of
 * prose.
 *
 * No `created_by`, unlike `reusable_blocks`. That column exists there because a promoted block
 * carries provenance from the page it came from; a snippet is created directly and the audit log
 * already records who did it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('snippets')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('api_id', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('kind', 'text', (col) => col.notNull().defaultTo('text'))
    .addColumn('value', 'text', (col) => col.notNull())
    .addColumn('display', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  /*
   * `updated_at` is indexed because the delivery ETag reads `max(updated_at)` over this table on
   * every conditional request — the same stamp `reusableBlockLibraryVersion` computes, for the same
   * reason. An aggregate over an unindexed column is the shape `0020_perf_indexes` was written to
   * clean up after; there is no reason to add another one knowingly.
   */
  await db.schema
    .createIndex('snippets_updated_at_idx')
    .on('snippets')
    .column('updated_at')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('snippets').execute();
}
