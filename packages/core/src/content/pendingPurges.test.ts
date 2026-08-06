import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import {
  MAX_PURGE_ATTEMPTS,
  deferPurge,
  duePurges,
  enqueuePurge,
  purgeExpiredPurgeQueue,
  purgeQueueStatus,
  resolvePurge,
} from './pendingPurges.js';

/**
 * The queue that bounds a dropped purge.
 *
 * Purging never throws and therefore never tells anybody it failed — affordable when the TTL was
 * sixty seconds, and not when it is a day. These rows are the difference between "stale for one
 * sweep interval" and "stale until somebody notices by eye".
 */

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

describe('the purge retry queue', () => {
  it('records a failed purge with the tags it was going to send', async () => {
    await enqueuePurge(handle.db, 'self', ['item:a', 'type:page'], new Error('no binding'));

    const due = await duePurges(handle.db);
    expect(due).toHaveLength(1);
    expect(due[0]!.target).toBe('self');
    // Stored in the header's own spelling, so there is one format for a tag list in the system.
    expect(due[0]!.tags).toBe('item:a,type:page');
    expect(due[0]!.last_error).toBe('no binding');
  });

  /**
   * A consumer's cache is asked to flush wholesale, so its queued row carries no tags at all.
   * An empty string has to survive the round trip as "purge everything" rather than as "nothing to
   * do" — the distinction `enqueuePurge`'s caller depends on.
   */
  it('keeps an empty tag list, which is how a whole-site flush is spelled', async () => {
    await enqueuePurge(handle.db, 'site', []);

    const [row] = await duePurges(handle.db);
    expect(row!.tags).toBe('');
    expect(row!.target).toBe('site');
  });

  it('stops offering a row once it has been resolved', async () => {
    await enqueuePurge(handle.db, 'self', ['site']);
    const [row] = await duePurges(handle.db);

    await resolvePurge(handle.db, row!.id);

    expect(await duePurges(handle.db)).toHaveLength(0);
  });

  /**
   * The backoff is a fact about the row, not about whichever process picked it up — so a deferred
   * row must stop being due immediately, or a sweep that runs every five minutes would retry a
   * failing purge every five minutes forever.
   */
  it('pushes a failed retry out of the due set', async () => {
    await enqueuePurge(handle.db, 'self', ['site']);
    const [row] = await duePurges(handle.db);

    await deferPurge(handle.db, row!, new Error('still unreachable'));

    expect(await duePurges(handle.db)).toHaveLength(0);
  });

  /**
   * A purge that has failed this many times is a misconfiguration rather than a blip. Retrying it
   * forever turns one broken setting into an unbounded stream of outbound requests; leaving it
   * stuck is what gives Settings → System something to report.
   */
  it('gives up after the attempt ceiling and reports the row as stuck', async () => {
    await enqueuePurge(handle.db, 'site', ['site']);

    for (let i = 0; i < MAX_PURGE_ATTEMPTS; i++) {
      const [row] = await handle.db.selectFrom('pending_purges').selectAll().execute();
      await deferPurge(handle.db, row!, new Error(`attempt ${i}`));
    }

    expect(await duePurges(handle.db)).toHaveLength(0);

    const status = await purgeQueueStatus(handle.db);
    expect(status.stuck).toBe(1);
    expect(status.pending).toBe(0);
    // The screen has to be able to say *why*, not only how many.
    expect(status.lastError).toBe(`attempt ${MAX_PURGE_ATTEMPTS - 1}`);
  });

  /**
   * Pending and stuck are counted apart deliberately. A few pending rows is a sweep that has not
   * run yet, which is ordinary; a stuck row is content that stays wrong until somebody acts. One
   * combined total would let the ordinary case hide the actionable one.
   */
  it('separates a sweep that has not run from a purge that never will', async () => {
    await enqueuePurge(handle.db, 'self', ['item:a']);

    const status = await purgeQueueStatus(handle.db);
    expect(status.pending).toBe(1);
    expect(status.stuck).toBe(0);
  });

  it('sweeps stuck rows only once they are old, and never live ones', async () => {
    await enqueuePurge(handle.db, 'self', ['item:a']);

    // Freshly stuck: reported, not yet swept, or the screen would never get to show it.
    await handle.db
      .updateTable('pending_purges')
      .set({ attempts: MAX_PURGE_ATTEMPTS })
      .execute();

    expect(await purgeExpiredPurgeQueue(handle.db)).toBe(0);
    expect((await purgeQueueStatus(handle.db)).stuck).toBe(1);
  });
});
