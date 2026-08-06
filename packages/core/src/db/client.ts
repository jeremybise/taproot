import { Kysely } from 'kysely';

import type { Database } from './schema.js';
import type { BatchTarget, BatchStatement } from './batch.js';
import { batchWrite } from './batch.js';
import type { D1DatabaseLike } from './dialects/d1.js';

/**
 * Where Taproot's data lives. One dialect, two drivers: `node:sqlite` locally, D1 in production.
 *
 * **Not two dialects.** Both go through Kysely's `SqliteQueryCompiler`, so the SQL is byte-identical
 * and there is no branch anywhere in query building — what differs is the driver underneath (a real
 * transaction here, `batch()` there; see `batchWrite`). That is why the local driver is not a
 * portability layer and dropping it would buy nothing: 31 test files and every CLI script run on it,
 * and workerd has no `node:sqlite`, which is exactly why dev renders on Node.
 *
 * A Postgres driver was wired here from Phase 0 and removed once it was clear nothing tested it,
 * nothing documented it, and no deployment used it — while the *promise* of it was what ruled out
 * FTS5 for search (`0021_item_text`), since a second real dialect means two index implementations
 * that have to agree. Committing to Cloudflare is what bought real ranking; see `0025_item_text_fts`.
 */
export type DbConfig =
  | { driver: 'sqlite'; location: string }
  | { driver: 'd1'; database: D1DatabaseLike };

export type DbDriver = DbConfig['driver'];

/**
 * A live database handle.
 *
 * Carries the D1 binding alongside the Kysely instance so `batch()` can reach the native atomic
 * batch when running on D1 — see `batchWrite` for why atomic writes are expressed as statement
 * lists rather than transaction callbacks.
 */
export interface TaprootDb extends BatchTarget {
  readonly db: Kysely<Database>;
  readonly d1?: D1DatabaseLike;
  readonly driver: DbDriver;
  /** Run statements atomically on whichever backend is configured. */
  batch(statements: BatchStatement[]): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * Create a database handle from configuration.
 *
 * Dialect modules are loaded by dynamic import so that a bundle built for one target never pulls
 * in another's driver — the Workers bundle must not reach `node:sqlite`, and Node must not reach
 * the D1 binding types.
 */
export async function createDb(config: DbConfig): Promise<TaprootDb> {
  const db = await createKysely(config);

  const handle: TaprootDb = {
    db,
    driver: config.driver,
    ...(config.driver === 'd1' ? { d1: config.database } : {}),
    batch(statements) {
      return batchWrite(handle, statements);
    },
    async destroy() {
      await db.destroy();
    },
  };

  return handle;
}

async function createKysely(config: DbConfig): Promise<Kysely<Database>> {
  switch (config.driver) {
    case 'sqlite': {
      const { NodeSqliteDialect } = await import('./dialects/node-sqlite.js');
      return new Kysely<Database>({
        dialect: new NodeSqliteDialect({ location: config.location }),
      });
    }

    case 'd1': {
      const { D1Dialect } = await import('./dialects/d1.js');
      return new Kysely<Database>({
        dialect: new D1Dialect({ database: config.database }),
      });
    }

    default: {
      const exhaustive: never = config;
      throw new Error(`Unknown database driver: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Build a `DbConfig` from environment variables.
 *
 * Precedence is deliberate: an explicit D1 binding always wins, because in a Workers deployment
 * the binding is the only thing that can work. Everything else falls back to a local SQLite file so
 * `npm run dev` needs no configuration.
 */
export function dbConfigFromEnv(
  env: Record<string, string | undefined>,
  bindings?: { DB?: D1DatabaseLike },
): DbConfig {
  if (bindings?.DB) {
    return { driver: 'd1', database: bindings.DB };
  }

  /**
   * A Postgres `DATABASE_URL` throws rather than being ignored.
   *
   * Same rule `TAPROOT_DEV_AUTH` follows: silently dropping a variable an operator deliberately set
   * leaves them believing they configured something. Falling through to the SQLite default would be
   * the worst version of it — a deployment that starts cleanly, serves happily, and writes every
   * page into a local file nobody is backing up, while the connection string sits in the dashboard
   * looking honoured.
   */
  const url = env.DATABASE_URL;
  if (url && (url.startsWith('postgres://') || url.startsWith('postgresql://'))) {
    throw new Error(
      'DATABASE_URL names a Postgres database, and Taproot no longer has a Postgres driver. ' +
        'Deploy on Cloudflare D1 (bind it as `DB`), or unset DATABASE_URL to use a local SQLite ' +
        'file via TAPROOT_SQLITE_PATH.',
    );
  }

  return { driver: 'sqlite', location: env.TAPROOT_SQLITE_PATH ?? './data/taproot.sqlite' };
}
