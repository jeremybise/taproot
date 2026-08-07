import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { newId } from '../ids.js';
import {
  normalizeSearchQuery,
  purgeSearchLogBefore,
  recordSearch,
  searchLogStats,
  topSearchTerms,
  zeroResultSearchTerms,
} from './searchLog.js';

/**
 * The search log: what visitors looked for, and whether anything came back.
 *
 * The reports are aggregates over a table the *consumer* writes to, so what is defended here is the
 * grouping and the two "which row wins" rules — both of which are wrong in the obvious
 * implementation and wrong in a way that only shows up once the log has history in it.
 */

let db: TaprootDb;

const at = (iso: string) => new Date(iso);
const WINDOW = at('2026-01-01T00:00:00.000Z');

/**
 * Insert with a chosen timestamp, because every rule worth testing here is about *which row wins*
 * and `recordSearch` stamps `now()`.
 *
 * Written as a direct insert rather than `recordSearch` followed by an update. The update version
 * has to find the row it just wrote, and the only handle on it is "the newest" — which is ambiguous
 * the moment two inserts land inside the same millisecond, so the test would reorder its own
 * fixtures intermittently. It still goes through `normalizeSearchQuery`, which is the part the
 * grouping depends on; `recordSearch` is covered on its own above.
 */
async function logAt(query: string, resultCount: number, iso: string, source = 'page') {
  await db.db
    .insertInto('search_queries')
    .values({
      id: newId(),
      query,
      normalized: normalizeSearchQuery(query),
      result_count: resultCount,
      source,
      created_at: iso,
    })
    .execute();
}

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', location: ':memory:' });
  await migrateToLatest(db.db);
});

describe('normalizeSearchQuery', () => {
  it('folds case and accents, so one search is one row', () => {
    // The matcher folds `Peña` to `pena`; a report that split them would describe a distinction
    // search does not make. SQL's `lower()` gets the first and not the second.
    expect(normalizeSearchQuery('Peña')).toBe(normalizeSearchQuery('pena'));
    expect(normalizeSearchQuery('NURSING')).toBe(normalizeSearchQuery('nursing'));
  });

  it('collapses whitespace, which is a difference only a GROUP BY can see', () => {
    expect(normalizeSearchQuery('financial  aid')).toBe(normalizeSearchQuery(' financial aid '));
  });
});

describe('recordSearch', () => {
  it('drops a blank search rather than storing it', async () => {
    // An empty box submitted by accident is not a search, and it would be the top row of every report.
    await recordSearch(db.db, { query: '   ', resultCount: 0, source: 'page' });
    await recordSearch(db.db, { query: '', resultCount: 0, source: 'page' });

    const stats = await searchLogStats(db.db, { since: WINDOW });
    expect(stats.total).toBe(0);
  });

  it('refuses to let a bad count poison the column', async () => {
    // This arrives over HTTP from a consumer, so it is input rather than a value we computed.
    await recordSearch(db.db, { query: 'nursing', resultCount: -5, source: 'page' });
    await recordSearch(db.db, { query: 'welding', resultCount: 2.7, source: 'page' });

    const rows = await db.db.selectFrom('search_queries').select(['query', 'result_count']).execute();
    expect(rows.find((r) => r.query === 'nursing')?.result_count).toBe(0);
    expect(rows.find((r) => r.query === 'welding')?.result_count).toBe(2);
  });

  it('truncates rather than refusing a very long query', async () => {
    // Refusing would blind the report to exactly the searches most likely to have failed.
    await recordSearch(db.db, { query: 'x'.repeat(5000), resultCount: 0, source: 'page' });

    const row = await db.db.selectFrom('search_queries').select('query').executeTakeFirstOrThrow();
    expect(row.query.length).toBe(200);
  });

  it('never throws, whatever the database does', async () => {
    // The search it describes has already been answered; there is nobody left to report a failure to.
    await db.db.schema.dropTable('search_queries').execute();
    await expect(
      recordSearch(db.db, { query: 'nursing', resultCount: 1, source: 'page' }),
    ).resolves.toBeUndefined();
  });
});

describe('topSearchTerms', () => {
  it('groups spellings of one term together and counts them', async () => {
    await logAt('Nursing', 3, '2026-02-01T10:00:00.000Z');
    await logAt('nursing', 3, '2026-02-01T11:00:00.000Z');
    await logAt('NURSING', 3, '2026-02-01T12:00:00.000Z');
    await logAt('welding', 1, '2026-02-01T13:00:00.000Z');

    const top = await topSearchTerms(db.db, { since: WINDOW });

    expect(top).toHaveLength(2);
    expect(top[0].searches).toBe(3);
    expect(top[1].searches).toBe(1);
  });

  it('displays the most common spelling, not the first or the last', async () => {
    /**
     * A report headed `NURSING` because one person shouted is a report people stop reading.
     *
     * Three lowercase against two uppercase, with the shouted spelling deliberately both the
     * **first** and the **last** row — so an implementation reaching for either fails here, and a
     * genuine majority exists for the right one to find. An earlier version of this fixture was two
     * against two, which is a tie: it asserted nothing about "most common" and only pinned the
     * tiebreak.
     */
    await logAt('NURSING', 1, '2026-02-01T10:00:00.000Z');
    await logAt('nursing', 1, '2026-02-01T11:00:00.000Z');
    await logAt('nursing', 1, '2026-02-01T12:00:00.000Z');
    await logAt('nursing', 1, '2026-02-01T13:00:00.000Z');
    await logAt('NURSING', 1, '2026-02-01T14:00:00.000Z');

    const [term] = await topSearchTerms(db.db, { since: WINDOW });
    expect(term.query).toBe('nursing');
  });

  it('honours the date window', async () => {
    await logAt('old', 1, '2025-06-01T00:00:00.000Z');
    await logAt('recent', 1, '2026-02-01T00:00:00.000Z');

    const top = await topSearchTerms(db.db, { since: WINDOW });
    expect(top.map((t) => t.query)).toEqual(['recent']);
  });

  it('separates sources, so a fragment cannot lead the report', async () => {
    // An `abandoned` row is whatever prefix somebody had reached, so it may not be a whole word.
    await logAt('nursi', 0, '2026-02-01T10:00:00.000Z', 'abandoned');
    await logAt('nursing', 4, '2026-02-01T11:00:00.000Z', 'page');

    const committed = await topSearchTerms(db.db, { since: WINDOW, sources: ['page', 'suggest'] });
    expect(committed.map((t) => t.query)).toEqual(['nursing']);

    const everything = await topSearchTerms(db.db, { since: WINDOW });
    expect(everything).toHaveLength(2);
  });
});

describe('zeroResultSearchTerms', () => {
  it('reports a term nothing was found for', async () => {
    await logAt('basket weaving', 0, '2026-02-01T10:00:00.000Z');
    await logAt('nursing', 4, '2026-02-01T11:00:00.000Z');

    const zero = await zeroResultSearchTerms(db.db, { since: WINDOW });
    expect(zero.map((t) => t.query)).toEqual(['basket weaving']);
  });

  it('stops accusing an editor the moment they publish the page', async () => {
    /**
     * The rule that matters, and the one the obvious implementation gets wrong. Searched three
     * times with no results, then somebody wrote the page and the next search found it. A
     * `min(result_count) = 0` — or any average — keeps this on the list for as long as the window
     * is open, telling an editor to fix something they have already fixed.
     */
    await logAt('welding', 0, '2026-02-01T10:00:00.000Z');
    await logAt('welding', 0, '2026-02-01T11:00:00.000Z');
    await logAt('welding', 0, '2026-02-01T12:00:00.000Z');
    await logAt('welding', 2, '2026-02-05T09:00:00.000Z');

    const zero = await zeroResultSearchTerms(db.db, { since: WINDOW });
    expect(zero).toHaveLength(0);

    // …and it still shows up as a popular search, with its current answer.
    const [term] = await topSearchTerms(db.db, { since: WINDOW });
    expect(term.searches).toBe(4);
    expect(term.resultCount).toBe(2);
  });

  it('reports a term that has started failing', async () => {
    // The other direction: it used to work, then the page was unpublished.
    await logAt('transfer', 3, '2026-02-01T10:00:00.000Z');
    await logAt('transfer', 0, '2026-02-05T10:00:00.000Z');

    const zero = await zeroResultSearchTerms(db.db, { since: WINDOW });
    expect(zero.map((t) => t.query)).toEqual(['transfer']);
  });
});

describe('searchLogStats', () => {
  it('counts searches, distinct terms and failures', async () => {
    await logAt('nursing', 4, '2026-02-01T10:00:00.000Z');
    await logAt('Nursing', 4, '2026-02-01T11:00:00.000Z');
    await logAt('basket weaving', 0, '2026-02-01T12:00:00.000Z');

    const stats = await searchLogStats(db.db, { since: WINDOW });
    expect(stats).toMatchObject({ total: 3, terms: 2, zeroResult: 1 });
    expect(stats.since).toBe('2026-02-01T10:00:00.000Z');
  });

  it('answers zeroes for an empty log rather than throwing', async () => {
    // Which is what every deployment looks like on the day this ships.
    await expect(searchLogStats(db.db, { since: WINDOW })).resolves.toMatchObject({
      total: 0,
      terms: 0,
      zeroResult: 0,
      since: null,
    });
  });
});

describe('purgeSearchLogBefore', () => {
  it('drops by age and reports how much went', async () => {
    await logAt('old', 1, '2025-06-01T00:00:00.000Z');
    await logAt('recent', 1, '2026-02-01T00:00:00.000Z');

    expect(await purgeSearchLogBefore(db.db, at('2026-01-01T00:00:00.000Z'))).toBe(1);

    const left = await db.db.selectFrom('search_queries').select('query').execute();
    expect(left.map((r) => r.query)).toEqual(['recent']);
  });
});
