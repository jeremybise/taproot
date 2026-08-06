/**
 * The retry queue behind cache purging.
 *
 * A purge is fire-and-forget: `purgeInvalidated` never throws, because the write it describes has
 * already committed and has already been reported successful. That is the right call — failing an
 * editor's save over a cache-maintenance problem tells them a lie and makes them do it again — but
 * it means a dropped purge is *silent*, and silence is only affordable when the TTL is short.
 *
 * At sixty seconds a dropped purge cost a minute. At a day it costs a day, and nobody finds out
 * except by noticing that a page is wrong. These rows are what turn that back into one sweep
 * interval, using the cron that already runs rather than a queue product or a new binding.
 *
 * Nothing here throws into a request path. `enqueuePurge` is called from a place that has already
 * decided the response is a success, so it swallows its own failures for exactly the reason the
 * purge it is recording does.
 */

import type { Kysely } from 'kysely';

import type { Database, PendingPurgeRow, PurgeTarget } from '../db/schema.js';
import { now } from '../db/values.js';
import { newId } from '../ids.js';

/**
 * Re-exported so the server reaches them through the main barrel, exactly as `preview.ts` does for
 * `PREVIEW_PARAM`. They are *declared* in `pure.ts` because the consumer's handler must import them
 * without dragging Kysely into a site's bundle, and this module cannot be that entry — it is nothing
 * but database access. No cycle: `pure.ts` does not export this file.
 */
export { PURGE_PATH, PURGE_SECRET_HEADER } from '../pure.js';

/**
 * How many times a purge is retried before it is left alone.
 *
 * A ceiling rather than forever: a purge that has failed this many times is a misconfiguration, not
 * a blip, and retrying it every five minutes until somebody notices turns one broken setting into
 * an unbounded stream of outbound requests. What a stuck row buys instead is a thing Settings →
 * System can *report*, which is the only way a silent failure becomes a fixable one.
 */
export const MAX_PURGE_ATTEMPTS = 8;

/** Backoff in minutes, indexed by attempts already made. The last entry repeats. */
const BACKOFF_MINUTES = [0, 5, 15, 30, 60, 120, 240, 480];

function nextAttemptAt(attempts: number): string {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)]!;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * Record a purge that did not land, so the sweep can replay it.
 *
 * **Never throws**, and the whole body is inside the `try` rather than only the insert — the same
 * lesson `purgeInvalidated` learned the hard way, where only the call was guarded and the property
 * access that reached it was what threw. A queue that fails a request by failing to record a
 * failure would be worse than having no queue.
 *
 * Deliberately not deduplicated against existing rows. Two saves a minute apart genuinely are two
 * purges, the tag lists usually differ, and a `select` before every insert would put a read on the
 * failure path of a write that has already been reported successful.
 */
export async function enqueuePurge(
  db: Kysely<Database>,
  target: PurgeTarget,
  tags: Iterable<string>,
  error?: unknown,
): Promise<void> {
  try {
    await db
      .insertInto('pending_purges')
      .values({
        id: newId(),
        target,
        tags: [...tags].join(','),
        attempts: 0,
        last_error: error instanceof Error ? error.message : error ? String(error) : null,
        next_attempt_at: nextAttemptAt(0),
        created_at: now(),
      })
      .execute();
  } catch (cause) {
    console.error('[taproot] could not record a failed cache purge', cause);
  }
}

/** Purges whose backoff has elapsed, oldest first, bounded so one sweep cannot run long. */
export async function duePurges(
  db: Kysely<Database>,
  limit = 50,
): Promise<PendingPurgeRow[]> {
  return db
    .selectFrom('pending_purges')
    .selectAll()
    .where('next_attempt_at', '<=', now())
    .where('attempts', '<', MAX_PURGE_ATTEMPTS)
    .orderBy('next_attempt_at')
    .limit(limit)
    .execute();
}

/** The purge landed; the row has done its job. */
export async function resolvePurge(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom('pending_purges').where('id', '=', id).execute();
}

/** It failed again: count it and push the next attempt out. */
export async function deferPurge(
  db: Kysely<Database>,
  row: PendingPurgeRow,
  error?: unknown,
): Promise<void> {
  const attempts = row.attempts + 1;

  await db
    .updateTable('pending_purges')
    .set({
      attempts,
      last_error: error instanceof Error ? error.message : error ? String(error) : null,
      next_attempt_at: nextAttemptAt(attempts),
    })
    .where('id', '=', row.id)
    .execute();
}

export interface PurgeQueueStatus {
  /** Waiting, and still being retried. */
  pending: number;
  /** Given up on, and therefore the number a human has to do something about. */
  stuck: number;
  /** The most recent failure across stuck rows, so the screen can say why and not only how many. */
  lastError: string | null;
}

/**
 * What Settings → System reports, in one query rather than three.
 *
 * `stuck` is the number that matters and is deliberately separate from `pending`: a handful of
 * pending rows is a sweep that has not run yet, which is normal, while a stuck row is a purge that
 * will never happen and content that is wrong until somebody acts. Reporting one total would let
 * the ordinary case hide the actionable one.
 */
export async function purgeQueueStatus(db: Kysely<Database>): Promise<PurgeQueueStatus> {
  const rows = await db
    .selectFrom('pending_purges')
    .select(['attempts', 'last_error'])
    .execute();

  const stuck = rows.filter((row) => row.attempts >= MAX_PURGE_ATTEMPTS);

  return {
    pending: rows.length - stuck.length,
    stuck: stuck.length,
    lastError: stuck.at(-1)?.last_error ?? null,
  };
}

/**
 * Drop rows that have been stuck for long enough to be noise rather than news.
 *
 * Swept for the reason `login_attempts` is: a table nothing deletes from only grows. Long enough
 * that Settings → System has had every chance to show it first.
 */
export async function purgeExpiredPurgeQueue(db: Kysely<Database>, days = 30): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const result = await db
    .deleteFrom('pending_purges')
    .where('attempts', '>=', MAX_PURGE_ATTEMPTS)
    .where('created_at', '<', cutoff)
    .executeTakeFirst();

  return Number(result?.numDeletedRows ?? 0);
}
