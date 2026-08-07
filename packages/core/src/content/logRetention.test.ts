import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { newId } from '../ids.js';
import { LOG_PURGE_BATCH, purgeExpiredLogs, resolveLogRetention } from './logRetention.js';
import { normalizeSearchQuery } from './searchLog.js';

/**
 * Retention on the two logs.
 *
 * The behaviour worth defending is what happens when it is *not* configured, and what happens when
 * it is configured wrongly — because both are states a real deployment sits in, and the failure
 * mode of each is deleting data nobody meant to delete.
 */

let db: TaprootDb;

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', location: ':memory:' });
  await migrateToLatest(db.db);
});

const NOW = new Date('2026-06-01T00:00:00.000Z');
const daysBefore = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

async function seedSearch(count: number, ageDays: number) {
  for (let i = 0; i < count; i++) {
    await db.db
      .insertInto('search_queries')
      .values({
        id: newId(),
        query: `term ${i}`,
        normalized: normalizeSearchQuery(`term ${i}`),
        result_count: 1,
        source: 'page',
        created_at: daysBefore(ageDays),
      })
      .execute();
  }
}

async function seedAudit(count: number, ageDays: number) {
  for (let i = 0; i < count; i++) {
    await db.db
      .insertInto('audit_log')
      .values({
        id: newId(),
        actor_id: null,
        actor_email: null,
        action: 'item.published',
        subject_type: 'item',
        subject_id: null,
        subject_label: `Item ${i}`,
        detail: null,
        created_at: daysBefore(ageDays),
      })
      .execute();
  }
}

const counts = async () => ({
  search: Number(
    (
      await db.db
        .selectFrom('search_queries')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .executeTakeFirst()
    )?.n ?? 0,
  ),
  audit: Number(
    (
      await db.db
        .selectFrom('audit_log')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .executeTakeFirst()
    )?.n ?? 0,
  ),
});

describe('resolveLogRetention', () => {
  it('reads both periods independently', () => {
    expect(
      resolveLogRetention({
        TAPROOT_SEARCH_LOG_RETENTION_DAYS: '90',
        TAPROOT_AUDIT_LOG_RETENTION_DAYS: '400',
      }),
    ).toEqual({ searchLogDays: 90, auditLogDays: 400, invalid: [] });
  });

  it('treats unset as keep-forever', () => {
    /**
     * The default that matters. A default *period* would mean upgrading Taproot silently began
     * deleting a deployment's history, which is not a change a version bump gets to make.
     */
    expect(resolveLogRetention({})).toEqual({
      searchLogDays: null,
      auditLogDays: null,
      invalid: [],
    });
    expect(resolveLogRetention({ TAPROOT_SEARCH_LOG_RETENTION_DAYS: '  ' }).searchLogDays).toBeNull();
  });

  it('disables the purge for an unusable value, and names it', () => {
    /**
     * Fails safe *and* says so. Silently ignoring it is the genuinely bad option — the operator
     * believes purging is happening while the table grows, which is the exact failure retention
     * exists to prevent. Throwing would take a site down over a typo in a housekeeping setting.
     */
    for (const raw of ['soon', '', '9.5', '-30', '0', 'NaN', 'Infinity']) {
      const config = resolveLogRetention({ TAPROOT_SEARCH_LOG_RETENTION_DAYS: raw });
      expect(config.searchLogDays).toBeNull();
      // An empty string is "unset", not "wrong" — nothing to report.
      expect(config.invalid).toEqual(raw.trim() === '' ? [] : ['TAPROOT_SEARCH_LOG_RETENTION_DAYS']);
    }
  });

  it('treats zero as a mistake rather than as "keep nothing"', () => {
    // Far more likely an unset variable expanding to 0 than an instruction to keep no history, and
    // the cost of being wrong in that direction cannot be undone.
    const config = resolveLogRetention({ TAPROOT_AUDIT_LOG_RETENTION_DAYS: '0' });
    expect(config.auditLogDays).toBeNull();
    expect(config.invalid).toContain('TAPROOT_AUDIT_LOG_RETENTION_DAYS');
  });
});

describe('purgeExpiredLogs', () => {
  it('deletes nothing at all when retention is unconfigured', async () => {
    await seedSearch(3, 500);
    await seedAudit(3, 500);

    const result = await purgeExpiredLogs(db.db, resolveLogRetention({}), NOW);

    expect(result).toMatchObject({ searchQueries: 0, auditEntries: 0, moreToRemove: false });
    expect(await counts()).toEqual({ search: 3, audit: 3 });
  });

  it('deletes only what has aged out', async () => {
    await seedSearch(2, 100);
    await seedSearch(3, 10);

    await purgeExpiredLogs(
      db.db,
      resolveLogRetention({ TAPROOT_SEARCH_LOG_RETENTION_DAYS: '30' }),
      NOW,
    );

    expect((await counts()).search).toBe(3);
  });

  it('keeps the two periods independent', async () => {
    // The whole reason there are two: an audit log is often kept far longer than search terms.
    await seedSearch(2, 200);
    await seedAudit(2, 200);

    await purgeExpiredLogs(
      db.db,
      resolveLogRetention({
        TAPROOT_SEARCH_LOG_RETENTION_DAYS: '90',
        TAPROOT_AUDIT_LOG_RETENTION_DAYS: '400',
      }),
      NOW,
    );

    expect(await counts()).toEqual({ search: 0, audit: 2 });
  });

  it('caps a batch and reports that there is more to remove', async () => {
    /**
     * The first sweep after retention is switched on can face a table that has grown since the
     * deployment was built. One unbounded delete over that is a statement long enough to hit a
     * runtime limit, on the one path that runs unattended.
     */
    await seedSearch(LOG_PURGE_BATCH + 5, 100);

    const first = await purgeExpiredLogs(
      db.db,
      resolveLogRetention({ TAPROOT_SEARCH_LOG_RETENTION_DAYS: '30' }),
      NOW,
    );

    expect(first.searchQueries).toBe(LOG_PURGE_BATCH);
    expect(first.moreToRemove).toBe(true);
    expect((await counts()).search).toBe(5);

    // The backlog drains across runs rather than needing one enormous statement.
    const second = await purgeExpiredLogs(
      db.db,
      resolveLogRetention({ TAPROOT_SEARCH_LOG_RETENTION_DAYS: '30' }),
      NOW,
    );

    expect(second.searchQueries).toBe(5);
    expect(second.moreToRemove).toBe(false);
    expect((await counts()).search).toBe(0);
  });

  it('is a no-op once the backlog is gone, so it is safe every five minutes', async () => {
    await seedSearch(2, 5);

    const result = await purgeExpiredLogs(
      db.db,
      resolveLogRetention({ TAPROOT_SEARCH_LOG_RETENTION_DAYS: '30' }),
      NOW,
    );

    expect(result).toMatchObject({ searchQueries: 0, moreToRemove: false });
    expect((await counts()).search).toBe(2);
  });

  it('does not purge a log whose period was set to something unusable', async () => {
    // Fails in the direction that keeps data.
    await seedAudit(3, 900);

    await purgeExpiredLogs(
      db.db,
      resolveLogRetention({ TAPROOT_AUDIT_LOG_RETENTION_DAYS: 'ninety' }),
      NOW,
    );

    expect((await counts()).audit).toBe(3);
  });
});
