import type { Kysely } from 'kysely';

/**
 * A derived index of an item's searchable text, so a site can offer search over its own content.
 *
 * `content_items.data` is TEXT holding JSON, and a body is authored as HTML inside it — often
 * several levels down, inside a block inside a repeater row. "Which pages mention accreditation"
 * has no SQL path through that: matching the raw blob would match markup, attribute values and
 * stored uuids as readily as prose, and would miss nothing only by matching far too much.
 *
 * **Not FTS5, and not `tsvector`.** Either would buy real ranking and cost the thing this repo has
 * protected since Phase 0: one migration set that runs unbranched on SQLite, D1 and Postgres.
 * FTS5 is a virtual table D1 does not reliably carry and Postgres does not have; `tsvector` is
 * Postgres only, and promoting it to a second real code path means every search bug can be a bug in
 * one dialect. What this stores instead is flattened plain text, matched with the lowercased `LIKE`
 * idiom already used for the admin's title search and ranked with a `CASE`.
 *
 * **The table is here to materialise the text, not to make it indexed.** `like '%needle%'` is a scan
 * on every dialect — a leading wildcard cannot use a B-tree — so an index on `text` would be paid
 * for on every write and spent on nothing. What the table buys is that the scan reads one flattened
 * column instead of parsing every item's JSON and walking it in JS, and that the walk happens once
 * per save rather than once per query.
 *
 * **One row per item rather than one per field.** Search asks whether an *item* mentions something;
 * a row per field would multiply the table by the field count to answer a question that never names
 * one, and the ranking that matters — a title match above a body match — reads `content_items` for
 * the title anyway.
 *
 * Same status and same rules as `content_item_values` and `taxonomy_assignments`: derived,
 * rebuilt inside the item's own write batch, with the authored value in `data` staying the source of
 * truth. A restored revision restores this with it. And, exactly as with `0019`, the table is
 * created empty and a migration cannot fill it — that needs each content type's field definitions
 * and a walk over stored JSON, which is what `npm run db:reindex` is for.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('content_item_text')
    .addColumn('content_item_id', 'text', (col) =>
      /**
       * Primary key as well as foreign key: one row per item is the invariant, and letting the
       * database hold it means a rebuild that somehow ran twice fails loudly instead of leaving
       * an item matching two copies of itself.
       *
       * Cascade for `content_item_values`' reason — the index is derived, so it has no meaning
       * once the item is gone, and there is no evidence here worth outliving its subject.
       */
      col.notNull().primaryKey().references('content_items.id').onDelete('cascade'),
    )
    /**
     * The item's prose, flattened and space-separated.
     *
     * Not null and possibly empty: an item whose fields hold no text still gets a row, so
     * "indexed and matched nothing" and "never indexed" stay different states. The second is what
     * a database that has not been reindexed since the migration looks like.
     */
    .addColumn('text', 'text', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('content_item_text').execute();
}
