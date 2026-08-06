import { sql, type Kysely } from 'kysely';

/**
 * A real full-text index over the text `0021_item_text` already flattens.
 *
 * `0021` settled for `lower(text) like '%needle%'` and said why: FTS5 was believed unavailable on D1,
 * and `tsvector` is Postgres-only, so buying ranking meant two index implementations that had to
 * agree. Both halves of that have since changed. D1 documents FTS5 (including `fts5vocab`) as
 * supported, and Taproot no longer has a Postgres driver — see the data-layer bullet in SCOPE.md,
 * where committing to one engine is recorded as having been *paid for* by exactly this.
 *
 * What it replaces is a scan. `like '%needle%'` has a leading wildcard, so no B-tree can serve it and
 * every search read every indexed row on every dialect; ranking was five `CASE` bands over more
 * `LIKE`s, because a `LIKE` answers whether a term appears and not how often or how near the start.
 * Measured on the new form, the plan is `LIST SUBQUERY` over the FTS index feeding a primary-key seek
 * into `content_items` — the table is not scanned at all — and `bm25` is a real score.
 *
 * **Deliberately no triggers**, which is the idiomatic way to keep an FTS5 index in sync and the
 * wrong choice here. `db:migrate:remote` sends each statement to D1's REST `/query` endpoint, which
 * is the exact path with the long-standing `CREATE TRIGGER` bug — a trigger body's semicolons get
 * split and the statement comes back `incomplete input [code: 7500]`, remotely but never locally.
 * That failure would land after a deploy, on the one command whose whole job is to be safe to run
 * against production. `planTextIndex` emits the maintenance statements instead.
 *
 * **An ordinary FTS5 table rather than `content='content_item_text'`, and the duplication is bought
 * deliberately.** External content stores no copy of the prose, which is the tidier design and was
 * the first one written here. It fails on one property that matters more than the bytes: an
 * external-content index can only retract a row by being handed the text it originally indexed, so
 * the moment the index and the text disagree — a database restored from an export, which
 * *cannot carry a virtual table at all*, or a batch that partly applied — the next **save** of that
 * item throws `database disk image is malformed`. An editor pressing save, on an ordinary page,
 * getting a corruption error. Measured, not reasoned about: it is what the reindex test did first.
 *
 * Storing the text means a row is retracted by `rowid` alone, which is a no-op when it is not there,
 * so the same drift is repaired by the next save instead of being escalated into an error nobody can
 * act on. The cost is one more copy of prose already capped at `MAX_SEARCH_TEXT` per item.
 * `content_item_text` stays the durable half regardless — excerpts (`loadSearchExcerpts`) and
 * `searchIndexStatus` read it, and it is what an export carries.
 *
 * Rowids mirror `content_item_text.rowid`, which is what makes the retraction an indexed seek rather
 * than a scan over an `UNINDEXED` id column on every write.
 *
 * **This migration backfills itself**, unlike `0019` and `0021`, because everything it needs is one
 * column away rather than behind a walk over stored JSON. There is no `npm run db:reindex` step — the
 * one asymmetry worth stating out loud, since the two migrations before it trained the other habit.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`create virtual table content_item_fts using fts5(text)`.execute(db);

  await sql`
    insert into content_item_fts(rowid, text) select rowid, text from content_item_text
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table content_item_fts`.execute(db);
}
