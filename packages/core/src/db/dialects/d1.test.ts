import { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import type { Database } from '../schema.js';
import { migrateToLatest } from '../migrations/index.js';
import { D1Dialect, type D1DatabaseLike, type D1PreparedStatement, type D1Result } from './d1.js';

// `node:sqlite` behind a variable specifier, as node-sqlite.ts reaches it — nothing in this repo
// may let a bundler resolve it statically.
const specifier = 'node:sqlite';
const { DatabaseSync } = (await import(/* @vite-ignore */ specifier)) as {
  DatabaseSync: new (location: string) => {
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
      columns(): unknown[];
    };
    close(): void;
  };
};

/**
 * A stand-in for D1 that answers like the real thing, **including its authorizer**.
 *
 * D1 refuses anything touching `PRAGMA` with `not authorized: SQLITE_AUTH` (error 7500), over the
 * binding and the HTTP API alike. Reproducing that refusal is the whole point of this fake: it is
 * the one D1 behaviour that a real SQLite will never exhibit, and it is what made
 * `npm run db:migrate:remote` fail on its first statement with zero migrations applied.
 */
class FakeD1 implements D1DatabaseLike {
  readonly statements: string[] = [];
  readonly #db = new DatabaseSync(':memory:');

  prepare(sql: string): D1PreparedStatement {
    this.statements.push(sql);
    if (/\bpragma/i.test(sql)) {
      throw new Error('D1_ERROR: not authorized: SQLITE_AUTH');
    }
    return this.#statement(sql, []);
  }

  #statement(sql: string, params: unknown[]): D1PreparedStatement {
    const db = this.#db;
    return {
      bind: (...values: unknown[]) => this.#statement(sql, values),
      all: async <T,>(): Promise<D1Result<T>> => {
        const stmt = db.prepare(sql);
        // Same discriminator NodeSqliteConnection uses: empty for DDL and plain writes.
        if (stmt.columns().length > 0) {
          return { results: stmt.all(...params) as T[], success: true, meta: {} };
        }
        const result = stmt.run(...params);
        return {
          results: [],
          success: true,
          meta: {
            changes: Number(result.changes),
            last_row_id: Number(result.lastInsertRowid),
          },
        };
      },
    };
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const statement of statements) {
      results.push(await statement.all<T>());
    }
    return results;
  }

  close(): void {
    this.#db.close();
  }
}

function d1Kysely(database: D1DatabaseLike): Kysely<Database> {
  return new Kysely<Database>({ dialect: new D1Dialect({ database }) });
}

describe('the D1 stand-in', () => {
  it('refuses PRAGMA the way D1 does, so the migration test is not vacuous', () => {
    const fake = new FakeD1();
    expect(() => fake.prepare('select * from pragma_table_info("users")')).toThrow(/SQLITE_AUTH/);
    fake.close();
  });
});

describe('migrating a D1 database', () => {
  it('applies every migration without ever issuing a PRAGMA', async () => {
    const fake = new FakeD1();
    const db = d1Kysely(fake);

    const { applied, error } = await migrateToLatest(db);

    expect(error).toBeUndefined();
    expect(applied.length).toBeGreaterThan(0);

    // The regression itself. Kysely's SqliteIntrospector reads column metadata through
    // `pragma_table_info`, and Migrator introspects *before* creating its bookkeeping tables — so
    // inheriting the stock introspector meant D1 failed on the first statement, every time.
    const pragmas = fake.statements.filter((sql) => /\bpragma/i.test(sql));
    expect(pragmas).toEqual([]);

    await db.destroy();
    fake.close();
  });

  it('really created the schema, rather than reporting success over an empty database', async () => {
    const fake = new FakeD1();
    const db = d1Kysely(fake);

    const { error } = await migrateToLatest(db);
    expect(error).toBeUndefined();

    // A round trip through the dialect: if the migration had not run, this would throw.
    await db
      .insertInto('content_types')
      .values({
        id: 'ct1',
        api_id: 'page',
        name: 'Page',
        name_plural: 'Pages',
        kind: 'page',
        url_prefix: null,
        description: null,
        position: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })
      .execute();

    const rows = await db.selectFrom('content_types').select('api_id').execute();
    expect(rows.map((r) => r.api_id)).toEqual(['page']);

    await db.destroy();
    fake.close();
  });
});
