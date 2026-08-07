import { sql, type Kysely } from 'kysely';

/**
 * What visitors searched for, and whether the site had an answer.
 *
 * The report that earns this table is **zero results**: it names, in the visitors' own words,
 * content that is missing or titled something nobody would guess. Nothing else in the CMS can
 * answer that, and the people who can act on it are editors — which is why it lives here rather
 * than in whatever analytics the site is wired to.
 *
 * **One row per search, aggregated on read**, following `audit_log` rather than keeping running
 * counters. A counter table cannot answer a question nobody thought to ask when it was designed —
 * "what did people search for the week the catalogue went up" — and the volume this sees is a few
 * thousand rows a month on a campus site, which is nothing to group over. `purgeSearchLogBefore` is
 * the retention story, and like the audit log's it is a capability nothing schedules: adding a
 * recurring delete to a deployment's data is not a decision a migration gets to make.
 *
 * **Nothing identifying is stored, and that is a decision rather than an omission.** No IP, no user
 * agent, no session id, no account. A search log at a college contains "withdrawal deadline",
 * "counseling", "financial aid appeal" — anything that lets a row be tied back to a person turns a
 * content report into a record of who was worried about what. The session id used to collapse
 * prefixes lives in the browser for the length of a visit and is never sent.
 *
 * `normalized` exists so grouping is a plain indexed `group by` instead of a `lower()` over every
 * row. It is written by the application, not by SQLite's `lower()`, because the tokenizer's folding
 * rules are the ones that decide whether two searches are the same search — see `searchTerms.ts`,
 * which is the only place that is written down.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('search_queries')
    .addColumn('id', 'text', (col) => col.primaryKey())
    /** Exactly what was typed, for display. Trimmed and length-capped, never otherwise altered. */
    .addColumn('query', 'text', (col) => col.notNull())
    /** Case- and diacritic-folded, for grouping. `Peña` and `pena` are one search. */
    .addColumn('normalized', 'text', (col) => col.notNull())
    /**
     * How many results it found.
     *
     * The whole point. Nullable would mean "we did not record it", and there is no path that does
     * not know — the number is in hand at the moment the search is answered.
     */
    .addColumn('result_count', 'integer', (col) => col.notNull())
    /**
     * `page`, `suggest`, or `abandoned`.
     *
     * Kept apart because they are different acts and mixing them makes both reports wrong. A `page`
     * row is a whole word somebody committed to; an `abandoned` row is whatever prefix they had
     * reached when they gave up, so it may be a fragment. Averaging fragments into "top searches"
     * is how a report starts recommending that somebody write a page about "nursi".
     */
    .addColumn('source', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();

  /** The report's only ordering, and the retention sweep's only predicate. */
  await db.schema
    .createIndex('search_queries_created_at_idx')
    .on('search_queries')
    .column('created_at')
    .execute();

  /**
   * Grouping is always `normalized` within a date window, so the window has to be the leading
   * column — an index on `normalized` alone would be a scan for every report this screen draws.
   */
  await sql`
    create index search_queries_window_idx on search_queries (created_at, normalized)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('search_queries').execute();
}
