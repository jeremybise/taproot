import { sql, type Kysely } from 'kysely';

/**
 * A derived index of scalar field values, so a listing can filter and sort on an item's own data.
 *
 * "Events whose start date is upcoming, soonest first" has no SQL path without this. `data` is TEXT
 * holding JSON, and the only reads into it anywhere in the codebase are `LIKE '%…%'` prefilters
 * verified afterwards in JS — fine for "does this blob mention this id", useless for a range or an
 * ordering.
 *
 * **A derived index rather than `json_extract`.** Reading the JSON in place would work on SQLite and
 * D1 and need different syntax on Postgres, making this the first dialect-branched query building in
 * the repo; it would also be an unindexed scan of every row unless an expression index existed per
 * content type per field. Plain columns sort and range-filter on all three dialects with no
 * branching and one index.
 *
 * **The precedent is `taxonomy_assignments`, deliberately.** Same shape, same rules: the authored
 * value in `content_items.data` stays the source of truth, this is rebuilt from it inside the same
 * atomic batch as the item write, and a revision restoring old `data` restores the index with it.
 * Storing values *only* here would lose them on a restore, exactly as storing tags only in the join
 * table would.
 *
 * **Nothing about status or visibility is denormalised in.** A listing joins back to
 * `content_items` and applies `visibleToPublic` there. Copying `status` or `publish_at` here would
 * mean a scheduled item became visible only when something happened to reindex it — and the whole
 * point of computing visibility on read is that it needs no sweep.
 *
 * Three value columns rather than one, because a type-correct comparison is the entire feature:
 * `'10' < '9'` is true as text and false as a number, and a date only sorts correctly as text
 * because ISO 8601 was designed that way.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('content_item_values')
    .addColumn('content_item_id', 'text', (col) =>
      // Cascade: the index is derived, so it has no meaning once the item is gone. Unlike the audit
      // log, there is no evidence here worth outliving its subject.
      col.notNull().references('content_items.id').onDelete('cascade'),
    )
    .addColumn('field_api_id', 'text', (col) => col.notNull())
    /** The canonical string form. Always written, so every indexed value is greppable. */
    .addColumn('value_text', 'text')
    /** Numbers and booleans (0/1), so `10` sorts above `9`. */
    .addColumn('value_num', 'real')
    /** ISO 8601, which sorts correctly as text — that is why it is not a numeric epoch. */
    .addColumn('value_date', 'text')
    .execute();

  /**
   * The read this table exists for: "items where `starts_at` is after now", and the correlated
   * subquery that orders by the same. Field first, because every query names one.
   */
  await sql`
    create index content_item_values_field_idx
      on content_item_values (field_api_id, value_date, value_num)
  `.execute(db);

  /** The rebuild, which deletes every row for one item before inserting its replacements. */
  await sql`
    create index content_item_values_item_idx on content_item_values (content_item_id)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('content_item_values').execute();
}
