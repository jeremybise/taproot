import type { Compilable, CompiledQuery, Kysely } from 'kysely';

import type { Database } from './schema.js';
import type { D1DatabaseLike } from './dialects/d1.js';
import { toSqlParameters } from './values.js';

/**
 * A write that must land atomically, expressed as a list of statements rather than a callback.
 *
 * D1 has no interactive transactions, so a `db.transaction(async trx => …)` API cannot be
 * implemented portably. What D1 *does* have is `batch()`, which runs a statement list atomically.
 * Expressing atomic writes as a list is therefore the largest common denominator across all three
 * backends, and it is the shape the rest of Taproot is written against.
 *
 * The constraint this imposes is real and worth stating plainly: **you cannot read your own writes
 * mid-batch, and you cannot branch on an intermediate result.** Do the reads first, compute the
 * full statement list, then submit it. In practice this is not limiting for the operations Taproot
 * needs — a cascading path move, for example, reads the subtree with one recursive CTE, computes
 * every new path in memory, and writes them as one batch.
 */
export type BatchStatement = Compilable;

export interface BatchTarget {
  db: Kysely<Database>;
  /** Present only when running on D1; when set, `batchWrite` uses the native atomic batch. */
  d1?: D1DatabaseLike;
}

/**
 * Execute a list of statements atomically on whichever backend is configured.
 *
 * - **D1** — compiled and handed to the native `batch()`, which is atomic.
 * - **SQLite / Postgres** — wrapped in a real transaction, which rolls back on any failure.
 *
 * An empty list is a no-op rather than an error, so callers can build statement lists
 * conditionally without guarding every call site.
 */
export async function batchWrite(target: BatchTarget, statements: BatchStatement[]): Promise<void> {
  if (statements.length === 0) return;

  if (target.d1) {
    const prepared = statements.map((statement) => {
      const compiled = statement.compile() as CompiledQuery;
      return target.d1!.prepare(compiled.sql).bind(...toSqlParameters(compiled.parameters));
    });

    const results = await target.d1.batch(prepared);
    const failed = results.findIndex((result) => !result.success);
    if (failed !== -1) {
      throw new Error(`D1 batch failed at statement ${failed + 1} of ${results.length}.`);
    }
    return;
  }

  await target.db.transaction().execute(async (trx) => {
    for (const statement of statements) {
      const compiled = statement.compile() as CompiledQuery;
      await trx.executeQuery(compiled);
    }
  });
}
