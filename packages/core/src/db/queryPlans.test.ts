import { CompiledQuery, Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from './schema.js';
import { NodeSqliteDialect } from './dialects/node-sqlite.js';
import { migrateToLatest } from './migrations/index.js';
import { purgeStaleResetTokens } from '../auth/passwordReset.js';
import { purgeExpiredAttempts } from '../auth/throttle.js';
import { purgeExpiredSessions } from '../auth/session.js';
import { purgeExpiredPreviewTokens } from '../content/preview.js';
import { listBlockTypes } from '../content/types.js';
import { listItemSummaries } from '../content/items.js';

/**
 * Query plans for the predicates that run whether or not anybody visits.
 *
 * These are the four housekeeping deletes on the five-minute sweep plus the one type lookup on the
 * public read path. Every one of them is a filter that has to be served by an index, and none of
 * them has a result anybody looks at — which is exactly why an unindexed one can sit there for
 * phases. D1 bills rows *scanned* rather than rows returned, so a delete that matches nothing is
 * not free: it is the whole table, 288 times a day, forever.
 *
 * **This asserts the plan, not the timing.** A test that measured duration would pass on an empty
 * table however the query was written, which is the failure this is here to prevent: adding an
 * index to each side of `purgeStaleResetTokens`' `or` changed its plan by nothing at all, and the
 * migration, the index, and every existing test were green while the scan stayed exactly where it
 * was. The query had to be split into two statements to spend those indexes, and nothing but the
 * plan can tell the two versions apart.
 *
 * Verified at 20,000 rows as well as empty: the `or` form plans as `SCAN` at both sizes and each
 * half plans as a covering-index seek at both, so an empty fixture distinguishes the shapes
 * correctly and there is no need to populate one here.
 */

let db: Kysely<Database>;
let executed: { sql: string; parameters: readonly unknown[] }[] = [];

beforeEach(async () => {
  executed = [];
  db = new Kysely<Database>({
    dialect: new NodeSqliteDialect({ location: ':memory:' }),
    log: (event) => {
      if (event.level === 'query') {
        executed.push({ sql: event.query.sql, parameters: event.query.parameters });
      }
    },
  });

  const result = await migrateToLatest(db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await db.destroy();
});

/**
 * Run the caller, then explain every statement it actually issued.
 *
 * Explaining the *generated* SQL rather than a hand-written copy is the point — a rewrite of the
 * query is what this is guarding against, and a test holding its own copy of the SQL would keep
 * passing after the real one changed.
 */
async function plansFor(run: () => Promise<unknown>): Promise<string[]> {
  executed = [];
  await run();
  const statements = [...executed];
  expect(statements.length).toBeGreaterThan(0);

  const plans: string[] = [];
  for (const statement of statements) {
    const explained = await db.executeQuery<{ detail: string }>(
      CompiledQuery.raw(`explain query plan ${statement.sql}`, [...statement.parameters]),
    );
    plans.push(explained.rows.map((row) => row.detail).join(' | '));
  }
  return plans;
}

describe('housekeeping sweep query plans', () => {
  it('purges expired login attempts through an index', async () => {
    const plans = await plansFor(() => purgeExpiredAttempts(db));

    /**
     * `login_attempts_identifier_idx` is `(identifier, created_at)` and cannot serve a filter on
     * `created_at` alone — the column is in an index, just not in a position that helps, which is
     * the easiest version of this bug to miss on inspection.
     */
    expect(plans.every((plan) => !plan.includes('SCAN'))).toBe(true);
    expect(plans.join(' ')).toContain('login_attempts_created_at_idx');
  });

  it('purges stale reset tokens as two indexed statements, never one scan', async () => {
    const plans = await plansFor(() => purgeStaleResetTokens(db));

    // Two statements, because `expires_at < ? or used_at is not null` plans as a scan with both
    // columns indexed. If this ever collapses back to one, the `or` is back and so is the scan.
    expect(plans).toHaveLength(2);
    expect(plans.every((plan) => !plan.includes('SCAN'))).toBe(true);
    expect(plans.join(' ')).toContain('password_reset_tokens_expires_idx');
    expect(plans.join(' ')).toContain('password_reset_tokens_used_idx');
  });

  it('purges expired sessions through an index', async () => {
    const plans = await plansFor(() => purgeExpiredSessions(db));
    expect(plans.every((plan) => !plan.includes('SCAN'))).toBe(true);
  });

  it('purges expired preview tokens through an index', async () => {
    const plans = await plansFor(() => purgeExpiredPreviewTokens(db));
    expect(plans.every((plan) => !plan.includes('SCAN'))).toBe(true);
  });
});

describe('public read path query plans', () => {
  it('looks up block types through an index rather than scanning content_types', async () => {
    const plans = await plansFor(() => listBlockTypes(db));

    /**
     * `listContentTypes` is deliberately not asserted here. It asks `kind != 'block'`, and an
     * inequality is not seekable by any index — so it scans with `content_types_kind_idx` in place
     * and will keep scanning. Asserting it would either fail forever or have to allow a scan, and
     * an allowance is how the interesting case stops being checked.
     */
    expect(plans.every((plan) => !plan.includes('SCAN'))).toBe(true);
    expect(plans.join(' ')).toContain('content_types_kind_idx');
  });
});

/**
 * The subtree filter, which is the one predicate here that runs on a *read* path rather than a
 * sweep — and the one whose wrong implementation is invisible.
 *
 * `like 'path%'` returns exactly the same rows as the range form and plans as a full scan, because
 * SQLite's LIKE optimisation needs a `NOCASE` index or `case_sensitive_like` and `content_items`
 * has a plain BINARY unique index while **D1 refuses PRAGMA**. So the correct-looking version is a
 * table scan on every year-scoped listing and every book's table of contents, and nothing but the
 * plan can tell the two apart. Same lesson `0020_perf_indexes` paid for with the `or`.
 */
describe('subtree filter query plans', () => {
  it('seeks the path index rather than scanning the table', async () => {
    const plans = await plansFor(() =>
      listItemSummaries(db, { pathPrefix: '/catalog/2026-27', limit: 50 }),
    );

    expect(plans.every((plan) => !plan.includes('SCAN content_items'))).toBe(true);
    expect(plans.join(' ')).toContain('content_items_path_unique');
  });

  /**
   * Asserted against the alternative, not just in isolation.
   *
   * A test that only says "the range seeks" would still pass if somebody swapped in a `like` and
   * the planner happened to cope. Explaining both here records *why* the range form exists, and
   * fails loudly the day SQLite changes its mind about either.
   */
  it('confirms the like form it replaced would scan', async () => {
    const explained = await db.executeQuery<{ detail: string }>(
      CompiledQuery.raw(
        "explain query plan select id from content_items where path like ?",
        ['/catalog/2026-27/%'],
      ),
    );

    expect(explained.rows.map((row) => row.detail).join(' | ')).toContain('SCAN');
  });
});
