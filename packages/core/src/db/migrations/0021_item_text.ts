import type { Kysely } from 'kysely';

/**
 * A derived index of an item's searchable text, so a site can offer search over its own content.
 *
 * `content_items.data` is TEXT holding JSON, and a body is authored as HTML inside it — often
 * several levels down, inside a block inside a repeater row. "Which pages mention accreditation"
 * has no SQL path through that: matching the raw blob would match markup, attribute values and
 * stored uuids as readily as prose, and would miss nothing only by matching far too much.
 *
 * **Superseded in part by `0025_item_text_fts`, and this paragraph is why it survives as a note.**
 * What stood here said "Not FTS5, and not `tsvector`" — either would buy real ranking and cost one
 * migration set running unbranched on SQLite, D1 and Postgres — and it was wrong on one fact and
 * overtaken on the other. **D1 does document FTS5**, including `fts5vocab`; the claim that it "does
 * not reliably carry" it was true of an earlier D1 and was never rechecked. And Postgres is gone, so
 * the portability half no longer costs anything to spend. `0025` adds an FTS5 index over this table's
 * column and `bm25` replaces most of the `CASE`.
 *
 * **This table stays, and is not made redundant by that.** It is the durable, exportable half: it is
 * what `loadSearchExcerpts` reads to build an excerpt, what `searchIndexStatus` counts to tell
 * "nothing matched" apart from "nobody reindexed", and — since a `wrangler d1 export` cannot carry a
 * virtual table at all — the only copy of the flattened prose that survives a dump and restore.
 * `0025` is rebuilt from *this*, not the other way round.
 *
 * The original point of materialising the text also stands unchanged: the walk happens once per save
 * rather than once per query, so no read parses every item's JSON.
 *
 * **One row per item rather than one per field.** Search asks whether an *item* mentions something;
 * a row per field would multiply the table by the field count to answer a question that never names
 * one, and the ranking that matters — a title match above a body match — reads `content_items` for
 * the title anyway. That last clause is still load-bearing under `0025`: `bm25` scores this column,
 * which holds no title, which is why the title bands in `applyItemSort` were kept rather than
 * replaced by the score.
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
