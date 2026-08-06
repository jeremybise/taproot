import type { Kysely } from 'kysely';

/**
 * Cache purges that failed, so the five-minute sweep can try them again.
 *
 * Purging is fire-and-forget by design — `purgeInvalidated` never throws, because the write it
 * describes has already happened and has already been reported successful to the editor. Turning a
 * cache-maintenance problem into a 500 would tell somebody their save failed when it did not, and
 * they would do it again.
 *
 * That was a cheap promise while the TTL was sixty seconds: a dropped purge cost a minute of
 * staleness. It stops being cheap at a long TTL, where the same dropped purge costs a day — and the
 * failure is silent, because "never throws" also means "never tells anybody". A row here is what
 * turns that back into minutes.
 *
 * **Created empty, and nothing needs backfilling.** Unlike `0019` and `0021` there is no
 * `npm run db:reindex` step: those tables were derived from content that already existed, and this
 * one only ever holds work that failed after the migration ran.
 *
 * **Not a general job queue, deliberately.** It holds one kind of work, retried by a sweep that
 * already runs, with no ordering guarantee and no fan-out — because the alternative is a scheduler
 * abstraction that a CMS shipping zero native dependencies should not be growing. If a second kind
 * of deferred work ever appears, that is the moment to reconsider, not now.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('pending_purges')
    .addColumn('id', 'text', (col) => col.primaryKey())
    /**
     * Which cache the purge was meant for.
     *
     * `self` is this deployment's own edge cache, reached through the execution context. `site` is a
     * consumer's, reached over HTTP. They fail for completely different reasons — a missing binding
     * versus an unreachable host — and a retry has to know which one it is replaying.
     */
    .addColumn('target', 'text', (col) => col.notNull())
    /**
     * The tags, comma-separated, exactly as a `Cache-Tag` header spells them.
     *
     * Stored in the header's own format rather than as JSON so there is one spelling of a tag list
     * in the system. `normalizeCacheTags` has already run by the time a row is written, so what
     * lands here is what would have gone out.
     *
     * Empty means "purge everything", which is what a consumer site is asked for — see the site
     * purge handler for why precision is unavailable there.
     */
    .addColumn('tags', 'text', (col) => col.notNull())
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    /** The last failure, so Settings → System can say *why* rather than only *that*. */
    .addColumn('last_error', 'text')
    /**
     * When the sweep may next try, which is what makes the backoff a fact about the row rather than
     * about whichever process happens to pick it up.
     */
    .addColumn('next_attempt_at', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();

  /**
   * The sweep's only query is "what is due", so that is what is indexed.
   *
   * Ordering matters: `next_attempt_at` leads because it is the range scan, and a composite led by
   * `target` would leave the range unindexed — the lesson `0020_perf_indexes` records, where an
   * index that looked correct changed the plan by nothing at all.
   */
  await db.schema
    .createIndex('pending_purges_due_idx')
    .on('pending_purges')
    .columns(['next_attempt_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('pending_purges_due_idx').execute();
  await db.schema.dropTable('pending_purges').execute();
}
