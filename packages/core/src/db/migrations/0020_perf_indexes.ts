import type { Kysely } from 'kysely';

/**
 * Indexes for predicates that were running as full table scans.
 *
 * Every one of these is a filter that already existed and had nothing to serve it. D1 bills rows
 * *scanned* rather than rows returned, so an unindexed `delete … where expires_at < ?` on an empty
 * result set is not free — it is the whole table, every time it runs.
 *
 * Three of the four are on the housekeeping sweep, which is the case worth stating plainly: the cron
 * fires every five minutes forever, so an unindexed predicate there is a scan 288 times a day on a
 * deployment where nobody has scheduled anything and nobody has signed in. `0011_scheduling` already
 * made this argument for `publish_at` — "Without the index that is a scan, on a schedule, forever" —
 * and the other three purges in the same sweep never had it applied to them.
 *
 * Indexes cost a row written per insert into these tables. That trade is obviously right here: all
 * four tables are written rarely relative to how often they are swept, and `login_attempts` — the
 * one with real write volume — is written once per *failed* sign-in, against being scanned end to
 * end every five minutes.
 */
export async function up(db: Kysely<any>): Promise<void> {
  /**
   * The purge sweep's widest scan, on the table that grows fastest.
   *
   * `login_attempts_identifier_idx` is `(identifier, created_at)` and cannot serve a filter on
   * `created_at` alone — `identifier` leads it, so there is no seekable prefix. That is easy to miss
   * because the column *is* in an index, just not in a position that helps. This table gains a row
   * per failed sign-in and per reset request from anyone on the internet, so it is the one whose
   * scan cost grows without bound while the deployment sits idle.
   */
  await db.schema
    .createIndex('login_attempts_created_at_idx')
    .on('login_attempts')
    .column('created_at')
    .execute();

  /**
   * Two indexes, and `purgeStaleResetTokens` had to be split into two statements to use them.
   *
   * That split is the load-bearing part, and it is not obvious. The purge deleted where
   * `expires_at < now()` **or** `used_at is not null`, and adding an index to each branch changed
   * the plan by nothing at all: measured with `explain query plan` against 20,000 rows, the `or`
   * form stays `SCAN password_reset_tokens` with both indexes present, while each branch on its own
   * becomes a covering-index seek. SQLite's OR-to-union optimisation simply does not fire for this
   * statement, so the only way to spend the indexes is to write the two deletes separately.
   *
   * Worth recording because indexing an `or` *looks* like the fix and leaves the scan exactly where
   * it was — a green migration, a plan nobody re-read, and the same table walked every five minutes.
   * If either half of that query changes, re-check the plan rather than assuming the index applies.
   *
   * `used_at` is not a partial index: `is not null` is exactly the seek an ordinary index supports,
   * since NULLs sort first and the scan starts past them.
   */
  await db.schema
    .createIndex('password_reset_tokens_expires_idx')
    .on('password_reset_tokens')
    .column('expires_at')
    .execute();

  await db.schema
    .createIndex('password_reset_tokens_used_idx')
    .on('password_reset_tokens')
    .column('used_at')
    .execute();

  /**
   * `kind` with the ordering that follows it — and this one serves `listBlockTypes` **only**.
   *
   * `listContentTypes` asks `kind != 'block'`, and an inequality is not seekable: measured, it stays
   * `SCAN content_types` with this index in place. So the sidebar's query is unchanged and only
   * `listBlockTypes` (`kind = 'block'`, the one on the public read path via `blockTypeRegistry`)
   * turns into a seek. Naming both in a comment would suggest a win that is not there.
   *
   * The honest size of that win: this table holds tens of rows, so it is billed rows rather than
   * latency, and the real fix for the public path is not issuing the query at all when the item has
   * no `block` or `query` field. The index is worth keeping because the `position, name` sort comes
   * with it — it removes a temp B-tree, which is the measurable part — but it is not what makes that
   * page fast, and treating it as though it were would leave the actual cost in place.
   */
  await db.schema
    .createIndex('content_types_kind_idx')
    .on('content_types')
    .columns(['kind', 'position', 'name'])
    .execute();

  /**
   * The audit log grows forever, and `schedulerStatus` reads it with no bound.
   *
   * "When did the sweep last publish something" is `action = 'item.published'` with a null actor,
   * newest first, limit 1 — which on a deployment where the scheduler has never published anything
   * walks every row in the table before answering nothing. `created_at` trails `action` so the
   * ordering is served by the same index and the limit stops at the first row; `actor_id` stays a
   * residual check on the few rows that match, which is cheap and keeps this index narrow.
   */
  await db.schema
    .createIndex('audit_log_action_idx')
    .on('audit_log')
    .columns(['action', 'created_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('audit_log_action_idx').execute();
  await db.schema.dropIndex('content_types_kind_idx').execute();
  await db.schema.dropIndex('password_reset_tokens_used_idx').execute();
  await db.schema.dropIndex('password_reset_tokens_expires_idx').execute();
  await db.schema.dropIndex('login_attempts_created_at_idx').execute();
}
