import { Kysely } from 'kysely';

import type { Database } from './schema.js';
import type { BatchTarget, BatchStatement } from './batch.js';
import { batchWrite } from './batch.js';
import type { D1DatabaseLike } from './dialects/d1.js';

/**
 * Where Taproot's data lives. One codebase, three backends:
 * SQLite for local development, D1 in production, Postgres for Node deployments.
 */
export type DbConfig =
  | { driver: 'sqlite'; location: string }
  | { driver: 'd1'; database: D1DatabaseLike }
  | { driver: 'postgres'; connectionString: string; max?: number };

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

    case 'postgres': {
      // Postgres is wired but is not the tested target for Phase 0; SQLite and D1 are.
      // `pg` is an optional peer dependency, so it is only required if this branch is taken.
      const { PostgresDialect } = await import('kysely');
      const specifier = 'pg';
      const pg = (await import(/* @vite-ignore */ specifier)) as {
        default?: { Pool: new (opts: unknown) => unknown };
        Pool?: new (opts: unknown) => unknown;
      };
      const Pool = pg.Pool ?? pg.default?.Pool;
      if (!Pool) {
        throw new Error(
          "The 'postgres' driver requires the optional peer dependency `pg`. Run `npm install pg`.",
        );
      }
      return new Kysely<Database>({
        dialect: new PostgresDialect({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pool: new Pool({
            connectionString: config.connectionString,
            max: config.max ?? 10,
          }) as any,
        }),
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
 * the binding is the only thing that can work. Otherwise `DATABASE_URL` selects Postgres, and
 * everything else falls back to a local SQLite file so `npm run dev` needs no configuration.
 */
export function dbConfigFromEnv(
  env: Record<string, string | undefined>,
  bindings?: { DB?: D1DatabaseLike },
): DbConfig {
  if (bindings?.DB) {
    return { driver: 'd1', database: bindings.DB };
  }

  const url = env.DATABASE_URL;
  if (url && (url.startsWith('postgres://') || url.startsWith('postgresql://'))) {
    return { driver: 'postgres', connectionString: url };
  }

  return { driver: 'sqlite', location: env.TAPROOT_SQLITE_PATH ?? './data/taproot.sqlite' };
}
