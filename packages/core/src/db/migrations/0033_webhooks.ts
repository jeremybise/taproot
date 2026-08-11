import type { Kysely } from 'kysely';

/**
 * Outbound webhooks: where to send content events, and every attempt to send one.
 *
 * **This is the second kind of deferred work, which `0023_pending_purges` said was the moment to
 * reconsider a shared queue.** Reconsidered, and they stay separate — the two differ on the one
 * property a queue is for:
 *
 * - A purge is *attempt-then-enqueue-on-failure*. Losing one costs staleness bounded by `s-maxage`,
 *   so a Worker killed between the response and the `fetch` loses nothing that time does not fix.
 * - A delivery is *enqueue-then-attempt*. An event is a fact about a moment; nothing regenerates it,
 *   and a consumer that never hears "published" waits forever rather than a day. So the row is
 *   written **before** the request goes out, which means a killed isolate leaves work the sweep
 *   finds rather than an event that never existed.
 *
 * They also want different columns — a purge is a tag list, a delivery is a body, a signature and a
 * response status — and `webhook_deliveries` is read by a *screen*, which `pending_purges` never is.
 * Forcing one table would mean a nullable half per kind and a `target` column doing two jobs.
 *
 * **Created empty, and nothing needs backfilling.** No `npm run db:reindex` step: unlike `0019` and
 * `0021`, neither table is derived from content that already exists.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('webhook_endpoints')
    .addColumn('id', 'text', (col) => col.primaryKey())
    /** What it is for, in a human's words. The list is an inventory of integrations. */
    .addColumn('label', 'text', (col) => col.notNull())
    .addColumn('url', 'text', (col) => col.notNull())
    /**
     * The signing secret, stored recoverable — the one secret at rest in Taproot, deliberately.
     *
     * Everything else credential-shaped here is hashed (`sessions`, `api_keys`,
     * `password_reset_tokens`) because verification only ever needs to compare. An HMAC is not a
     * comparison: this deployment has to *produce* the signature on every send, so a hash of the
     * secret cannot sign anything.
     *
     * Admissible where a provider key is not, and the difference is what it can do. An
     * `TAPROOT_ANTHROPIC_API_KEY` in a column would be a credential on somebody's paid account,
     * which is why those live in the environment; this one is minted by Taproot, authenticates a
     * message rather than authorising access, and its whole blast radius is that somebody could
     * forge an event to one endpoint. It is per-endpoint and rotatable, so containing a leak is one
     * button rather than a re-key.
     *
     * The alternative was deriving each secret from one master secret in the environment, and it is
     * closed by precedent: that master needs a working default for `npm run dev`, and a default
     * signing secret is not a secret — the exact argument that made `preview_tokens` a table rather
     * than a signed value.
     */
    .addColumn('secret', 'text', (col) => col.notNull())
    /**
     * Which events this endpoint asked for, comma-separated.
     *
     * A list rather than a row per subscription: the set is small and fixed, it is always read
     * whole, and nothing ever queries "which endpoints want `item.published`" except the dispatcher,
     * which is already loading every active endpoint. A join table would buy an index nothing reads.
     *
     * **Empty is not "everything".** `matchesEvent` refuses it, following `embed.allowedHosts` and
     * `ItemFilters.termIds` — where a value bounds what may leave the deployment, the tempting
     * fallthrough is the dangerous one.
     */
    .addColumn('events', 'text', (col) => col.notNull())
    /**
     * Paused rather than deleted, so a noisy integration can be switched off without losing its
     * URL, its secret, and the delivery history that explains why somebody switched it off.
     */
    .addColumn('active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('webhook_deliveries')
    .addColumn('id', 'text', (col) => col.primaryKey())
    /**
     * Cascades, unlike `audit_log.subject_id`.
     *
     * The opposite call from the audit log, and for the reason that log gives: an audit entry is
     * evidence about an actor and has to outlive its subject. A delivery row is *operational* — it
     * exists to be retried and to be read on the endpoint's own screen — so once the endpoint is
     * gone there is nothing to retry against and no screen to read it on. The audit log is where
     * "somebody deleted this endpoint" is recorded, and that entry survives.
     */
    .addColumn('endpoint_id', 'text', (col) =>
      col.references('webhook_endpoints.id').onDelete('cascade').notNull(),
    )
    /** `item.published`, `release.published`… Copied onto the row so the log reads after a resend. */
    .addColumn('event', 'text', (col) => col.notNull())
    /**
     * The exact bytes to send, built once and kept rather than rebuilt per attempt.
     *
     * Rebuilding means re-reading a row that may have changed since, so a "published" event retried
     * an hour later would carry the title somebody has edited in the meantime — which is not the
     * event that happened. Same rule as `release_items` staging its own copy and the audit log
     * copying `subject_label`: what a record needs about a moment is taken *at* that moment.
     *
     * The **signature is not stored with it**, and that is the other half. It covers a timestamp so
     * a consumer can bound replay, so it is computed fresh on every attempt — a signature queued
     * eight hours ago would arrive outside any sane tolerance and be rejected as an attack.
     */
    .addColumn('payload', 'text', (col) => col.notNull())
    /** `pending` while it is still being tried, then `delivered` or `failed`. */
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    /** The HTTP status of the last attempt, null if the request never got an answer. */
    .addColumn('response_status', 'integer')
    /** Why the last attempt failed, so the screen can say more than "failed". */
    .addColumn('last_error', 'text')
    /** When the sweep may next try. Null once the row is settled, which is what keeps it out of the
     * due query without a second status check. */
    .addColumn('next_attempt_at', 'text')
    .addColumn('delivered_at', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();

  /**
   * The sweep's query is "what is due", so that is what leads — the ordering lesson from
   * `0020_perf_indexes`, where a composite led by the equality column left the range scan unindexed
   * and changed the plan by nothing at all.
   *
   * `next_attempt_at` is null on a settled row, and SQLite indexes nulls, so a delivered row still
   * occupies an entry — but it sorts to one end and the range predicate excludes it, which is
   * cheaper than the partial index D1 would have to be asked about.
   */
  await db.schema
    .createIndex('webhook_deliveries_due_idx')
    .on('webhook_deliveries')
    .columns(['next_attempt_at'])
    .execute();

  /** The screen's query: this endpoint's deliveries, newest first. */
  await db.schema
    .createIndex('webhook_deliveries_endpoint_idx')
    .on('webhook_deliveries')
    .columns(['endpoint_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('webhook_deliveries_endpoint_idx').execute();
  await db.schema.dropIndex('webhook_deliveries_due_idx').execute();
  await db.schema.dropTable('webhook_deliveries').execute();
  await db.schema.dropTable('webhook_endpoints').execute();
}
