import {
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
} from 'kysely';

import { toSqlParameters } from '../values.js';

/**
 * Structural types for the D1 Workers binding.
 *
 * Declared locally rather than imported from `@cloudflare/workers-types` so `@taprootcms/core` can be
 * consumed without that package installed, and so the exact surface we rely on is documented.
 */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: {
    changes?: number;
    last_row_id?: number;
    rows_read?: number;
    rows_written?: number;
    duration?: number;
  };
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/**
 * A Kysely dialect over the Cloudflare D1 Workers binding.
 *
 * Written in-tree rather than depending on the community `kysely-d1` package, which was last
 * published in April 2025 and is unmaintained. Since D1 is the v1 production target, an
 * unmaintained dependency on the critical path is not a good trade — and the driver is small,
 * because everything except the driver is Kysely's own SQLite implementation.
 */
export class D1Dialect implements Dialect {
  readonly #db: D1DatabaseLike;

  constructor(config: { database: D1DatabaseLike }) {
    this.#db = config.database;
  }

  createDriver(): Driver {
    return new D1Driver(this.#db);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new D1Adapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

/**
 * D1 rejects `BEGIN`/`COMMIT` — Cloudflare's reasoning being that one Worker request anywhere in
 * the world could otherwise block the whole database. Reporting `supportsTransactionalDdl: false`
 * is what lets Kysely's `Migrator` run migrations statement-by-statement instead of wrapping them
 * in a transaction that D1 would reject.
 */
class D1Adapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean {
    return false;
  }
}

class D1Driver implements Driver {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async init(): Promise<void> {
    // The binding is already live; nothing to open.
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return new D1Connection(this.#db);
  }

  async releaseConnection(): Promise<void> {
    // D1 statements are independent; there is no connection to hand back.
  }

  async beginTransaction(): Promise<never> {
    throw new Error(
      'D1 does not support interactive transactions (BEGIN/COMMIT). Use the portable ' +
        '`batchWrite()` helper from @taprootcms/core/db, which maps to D1\'s atomic batch() and to a ' +
        'real transaction on SQLite and Postgres.',
    );
  }

  async commitTransaction(): Promise<never> {
    throw new Error('D1 does not support interactive transactions. Use `batchWrite()` instead.');
  }

  async rollbackTransaction(): Promise<never> {
    throw new Error('D1 does not support interactive transactions. Use `batchWrite()` instead.');
  }

  async destroy(): Promise<void> {
    // The runtime owns the binding's lifecycle.
  }
}

class D1Connection implements DatabaseConnection {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const parameters = toSqlParameters(compiledQuery.parameters);
    const result = await this.#db.prepare(compiledQuery.sql).bind(...parameters).all<R>();

    if (!result.success) {
      throw new Error(`D1 query failed: ${compiledQuery.sql}`);
    }

    return {
      rows: result.results ?? [],
      numAffectedRows: BigInt(result.meta.changes ?? 0),
      insertId: BigInt(result.meta.last_row_id ?? 0),
    };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error(
      'D1 does not support streaming results. Use pagination (limit/offset) instead.',
    );
  }
}
