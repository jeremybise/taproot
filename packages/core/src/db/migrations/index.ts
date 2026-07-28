import type { Migration, MigrationProvider } from 'kysely/migration';
import { Migrator } from 'kysely/migration';
import type { Kysely } from 'kysely';

import type { Database } from '../schema.js';
import * as m0001 from './0001_init.js';

/**
 * The migration registry.
 *
 * Deliberately a static import map rather than Kysely's `FileMigrationProvider`: filesystem
 * discovery cannot work inside a Cloudflare Worker, where there is no `fs` and the bundle is a
 * single file. An explicit map is the only form that works identically in Node, in a Worker, and
 * in the migration CLI — which is what keeps one migration source of truth across all three.
 *
 * Keys are ordered lexicographically by Kysely, so the zero-padded numeric prefix is load-bearing.
 * Add new migrations here; never renumber or edit one that has shipped.
 */
export const migrations: Record<string, Migration> = {
  '0001_init': m0001,
};

export class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

export function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    provider: new StaticMigrationProvider(),
  });
}

export interface MigrationOutcome {
  applied: string[];
  error?: unknown;
}

/**
 * Apply all pending migrations.
 *
 * Returns the list of migrations that ran rather than logging, so callers (CLI, tests, a future
 * admin screen) can present the result however they like.
 */
export async function migrateToLatest(db: Kysely<Database>): Promise<MigrationOutcome> {
  const migrator = createMigrator(db);
  const { error, results } = await migrator.migrateToLatest();

  const applied = (results ?? [])
    .filter((r) => r.status === 'Success')
    .map((r) => r.migrationName);

  return error ? { applied, error } : { applied };
}
