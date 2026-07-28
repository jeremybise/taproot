import {
  CompiledQuery,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';

import { toSqlParameters } from '../values.js';

/**
 * Minimal structural types for `node:sqlite`.
 *
 * Declared here rather than imported so this module type-checks without `@types/node`'s sqlite
 * definitions being present, and so the shape we depend on is documented in one place.
 */
interface NodeSqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...params: unknown[]): IterableIterator<unknown>;
  columns(): unknown[];
}

interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export interface NodeSqliteDialectConfig {
  /** File path, or `:memory:`. */
  location: string;
  /**
   * Pragmas applied once at startup. The defaults are what you want for a web app on local disk:
   * WAL for concurrent readers, `foreign_keys` because SQLite leaves them off by default, and a
   * busy timeout so a concurrent writer waits instead of immediately failing.
   */
  pragmas?: Record<string, string | number>;
}

const DEFAULT_PRAGMAS: Record<string, string | number> = {
  journal_mode: 'WAL',
  foreign_keys: 'ON',
  busy_timeout: 5000,
  synchronous: 'NORMAL',
};

/**
 * A Kysely dialect over Node's built-in `node:sqlite` module.
 *
 * Deliberately not `better-sqlite3`: the built-in module means Taproot has zero native
 * dependencies, so `npm install` never needs a C++ toolchain and there is no Node-only binary
 * that can accidentally be pulled into the Cloudflare Workers bundle.
 *
 * Only the driver is custom — the adapter, introspector, and query compiler are Kysely's own
 * SQLite implementations, so generated SQL is identical to the D1 path.
 */
export class NodeSqliteDialect implements Dialect {
  readonly #config: NodeSqliteDialectConfig;

  constructor(config: NodeSqliteDialectConfig) {
    this.#config = config;
  }

  createDriver(): Driver {
    return new NodeSqliteDriver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class NodeSqliteDriver implements Driver {
  readonly #config: NodeSqliteDialectConfig;
  #db?: NodeSqliteDatabase;
  #connection?: DatabaseConnection;
  /**
   * `node:sqlite` is synchronous and single-connection, so concurrent Kysely calls would otherwise
   * interleave and corrupt transaction boundaries. Serialising on a promise chain keeps
   * `begin`/`commit` paired correctly without needing a real connection pool.
   */
  #mutex = Promise.resolve();

  constructor(config: NodeSqliteDialectConfig) {
    this.#config = config;
  }

  async init(): Promise<void> {
    // The specifier is held in a variable so bundlers cannot statically resolve it. Without this,
    // building the Cloudflare Workers bundle fails trying to resolve `node:sqlite`, which Workers
    // does not provide — even though this code path never runs there.
    const specifier = 'node:sqlite';
    const { DatabaseSync } = (await import(/* @vite-ignore */ specifier)) as {
      DatabaseSync: new (location: string) => NodeSqliteDatabase;
    };

    this.#db = new DatabaseSync(this.#config.location);

    const pragmas = { ...DEFAULT_PRAGMAS, ...this.#config.pragmas };
    for (const [key, value] of Object.entries(pragmas)) {
      // Pragma names and values are library-controlled, never user input.
      this.#db.exec(`PRAGMA ${key} = ${value}`);
    }

    this.#connection = new NodeSqliteConnection(this.#db);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.#connection) {
      throw new Error('NodeSqliteDriver.init() must complete before acquiring a connection.');
    }
    // Wait for any in-flight query to finish, then take the lock for this caller.
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#mutex;
    this.#mutex = this.#mutex.then(() => next);
    await previous;
    (this.#connection as NodeSqliteConnection).setRelease(release);
    return this.#connection;
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    (connection as NodeSqliteConnection).release();
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    if (settings.isolationLevel && settings.isolationLevel !== 'serializable') {
      throw new Error(
        `SQLite only supports the 'serializable' isolation level, got '${settings.isolationLevel}'.`,
      );
    }
    await connection.executeQuery(CompiledQuery.raw('BEGIN'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('COMMIT'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'));
  }

  async savepoint(connection: DatabaseConnection, name: string): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw(`SAVEPOINT ${quoteIdentifier(name)}`));
  }

  async rollbackToSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
    await connection.executeQuery(
      CompiledQuery.raw(`ROLLBACK TO SAVEPOINT ${quoteIdentifier(name)}`),
    );
  }

  async releaseSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw(`RELEASE SAVEPOINT ${quoteIdentifier(name)}`));
  }

  async destroy(): Promise<void> {
    this.#db?.close();
    this.#db = undefined;
    this.#connection = undefined;
  }
}

class NodeSqliteConnection implements DatabaseConnection {
  readonly #db: NodeSqliteDatabase;
  #release?: () => void;

  constructor(db: NodeSqliteDatabase) {
    this.#db = db;
  }

  setRelease(release: () => void): void {
    this.#release = release;
  }

  release(): void {
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const stmt = this.#db.prepare(compiledQuery.sql);
    const parameters = toSqlParameters(compiledQuery.parameters);

    // `columns()` is empty for statements that return no rows (plain INSERT/UPDATE/DELETE, DDL)
    // and non-empty for SELECT or anything with a RETURNING clause. It never throws, which makes
    // it a safer discriminator than parsing the SQL text.
    if (stmt.columns().length > 0) {
      return { rows: stmt.all(...parameters) as R[] };
    }

    const result = stmt.run(...parameters);
    return {
      rows: [],
      numAffectedRows: BigInt(result.changes),
      insertId: BigInt(result.lastInsertRowid),
    };
  }

  async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    const stmt = this.#db.prepare(compiledQuery.sql);
    const parameters = toSqlParameters(compiledQuery.parameters);
    for (const row of stmt.iterate(...parameters)) {
      yield { rows: [row as R] };
    }
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
