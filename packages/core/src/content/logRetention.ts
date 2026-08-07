import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { purgeAuditLogBefore } from './auditLog.js';
import { purgeSearchLogBefore } from './searchLog.js';

/**
 * How long the two logs are kept, and the sweep that enforces it.
 *
 * Both `purgeAuditLogBefore` and `purgeSearchLogBefore` were written to be safe to call on a
 * schedule and neither had a caller, so both tables grew forever. That is harmless for correctness
 * and steadily less harmless for a search log, which gains a row per search rather than a row per
 * consequential action.
 *
 * **Two periods, not one.** They answer different questions: an audit log is often kept because
 * somebody will need to reconstruct who changed what, sometimes to satisfy a policy, while a search
 * log is a content report whose value decays in weeks. One shared number forces the same answer to
 * both, and the answer that satisfies the audit log keeps search terms far longer than anyone needs.
 */

export interface LogRetentionEnv {
  TAPROOT_SEARCH_LOG_RETENTION_DAYS?: string;
  TAPROOT_AUDIT_LOG_RETENTION_DAYS?: string;
}

export interface LogRetentionConfig {
  /** Days of search history kept, or null for "keep everything". */
  searchLogDays: number | null;
  auditLogDays: number | null;
  /**
   * Variables that were set to something unusable, by name.
   *
   * Reported rather than thrown, and reported rather than ignored — see `resolveLogRetention`.
   */
  invalid: string[];
}

/**
 * Read the two periods out of the environment.
 *
 * **Unset means keep forever**, which is what every existing deployment already does. A default
 * period would mean upgrading Taproot silently began deleting a deployment's history, which is not
 * a change a version bump gets to make on an operator's behalf.
 *
 * **An unusable value disables that log's purge and is reported**, rather than throwing or being
 * quietly ignored. Both alternatives were considered and are worse in different directions.
 * Throwing follows `TAPROOT_DEV_AUTH`, which refuses to boot rather than let an operator believe
 * they had scoped something — but that guard protects against a *dangerous* misreading, where this
 * one fails in the safe direction: nothing is deleted. Taking a campus website down over a typo in
 * a retention period is not proportionate. Ignoring it silently is the genuinely bad option,
 * because the operator believes purging is happening and the table grows anyway — the exact failure
 * this module exists to prevent. So it fails safe *and* says so, on Settings → System.
 *
 * Zero and negative are unusable rather than meaning "delete everything". A retention of nothing is
 * far more likely to be a typo or an unset variable expanding to `0` than a deliberate instruction
 * to keep no history at all, and the cost of being wrong in that direction is unrecoverable.
 */
export function resolveLogRetention(env: LogRetentionEnv): LogRetentionConfig {
  const invalid: string[] = [];

  const read = (name: keyof LogRetentionEnv): number | null => {
    const raw = env[name]?.trim();
    if (!raw) return null;

    const days = Number(raw);
    if (!Number.isFinite(days) || !Number.isInteger(days) || days <= 0) {
      invalid.push(name);
      return null;
    }

    return days;
  };

  return {
    searchLogDays: read('TAPROOT_SEARCH_LOG_RETENTION_DAYS'),
    auditLogDays: read('TAPROOT_AUDIT_LOG_RETENTION_DAYS'),
    invalid,
  };
}

/**
 * Rows removed per log per sweep.
 *
 * A bound rather than a throttle. The first sweep after retention is switched on may face a table
 * that has been growing since the deployment was built, and one unbounded `delete` over hundreds of
 * thousands of rows is a statement long enough to hit a runtime limit — on D1, where the whole
 * point of the sweep is that it runs unattended. Capped, the backlog drains across successive runs
 * instead, which is the same shape `drainPurgeQueue` uses for the same reason.
 *
 * At the five-minute cron this is ~288k rows a day of drain capacity, which is far more than any
 * deployment produces.
 */
export const LOG_PURGE_BATCH = 1000;

export interface LogPurgeResult {
  searchQueries: number;
  auditEntries: number;
  /** True while a capped batch came back full, so there is more to remove on the next run. */
  moreToRemove: boolean;
}

/**
 * Delete what has aged out of both logs.
 *
 * Safe to call on every sweep. With no retention configured it does nothing and touches no table;
 * with retention configured and nothing expired, each delete is an indexed seek that matches no
 * rows — `search_queries_created_at_idx` and the audit log's own index are what make that cheap
 * enough to run every five minutes rather than needing a schedule of its own.
 *
 * `now` is a parameter so a test can age rows without waiting, following `dueForPublishing`.
 */
export async function purgeExpiredLogs(
  db: Kysely<Database>,
  config: LogRetentionConfig,
  now: Date = new Date(),
): Promise<LogPurgeResult> {
  const before = (days: number): Date => new Date(now.getTime() - days * 86_400_000);

  const searchQueries = config.searchLogDays
    ? await purgeSearchLogBefore(db, before(config.searchLogDays), LOG_PURGE_BATCH)
    : 0;

  const auditEntries = config.auditLogDays
    ? await purgeAuditLogBefore(db, before(config.auditLogDays), LOG_PURGE_BATCH)
    : 0;

  return {
    searchQueries,
    auditEntries,
    /**
     * A full batch means the cap was reached, not that the log is now clean.
     *
     * Worth reporting rather than inferring from the count at the call site: an operator watching
     * Settings → System during a first sweep should be able to tell "still draining a backlog" from
     * "this is the steady state", and the two look identical from a number alone.
     */
    moreToRemove: searchQueries >= LOG_PURGE_BATCH || auditEntries >= LOG_PURGE_BATCH,
  };
}
