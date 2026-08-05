import type { Migration, MigrationProvider } from 'kysely/migration';
import { Migrator } from 'kysely/migration';
import type { Kysely } from 'kysely';

import type { Database } from '../schema.js';
import * as m0001 from './0001_init.js';
import * as m0002 from './0002_revisions.js';
import * as m0003 from './0003_taxonomies.js';
import * as m0004 from './0004_menus.js';
import * as m0005 from './0005_content_type_position.js';
import * as m0006 from './0006_content_type_og_image.js';
import * as m0007 from './0007_reusable_blocks.js';
import * as m0008 from './0008_password_auth.js';
import * as m0009 from './0009_two_factor.js';
import * as m0010 from './0010_audit_log.js';
import * as m0011 from './0011_scheduling.js';
import * as m0012 from './0012_releases.js';
import * as m0013 from './0013_api_keys.js';
import * as m0014 from './0014_preview_tokens.js';
import * as m0015 from './0015_preview_draft.js';
import * as m0016 from './0016_settings.js';
import * as m0017 from './0017_singleton_preview_path.js';
import * as m0018 from './0018_field_visibility.js';
import * as m0019 from './0019_item_values.js';
import * as m0020 from './0020_perf_indexes.js';

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
  '0002_revisions': m0002,
  '0003_taxonomies': m0003,
  '0004_menus': m0004,
  '0005_content_type_position': m0005,
  '0006_content_type_og_image': m0006,
  '0007_reusable_blocks': m0007,
  '0008_password_auth': m0008,
  '0009_two_factor': m0009,
  '0010_audit_log': m0010,
  '0011_scheduling': m0011,
  '0012_releases': m0012,
  '0013_api_keys': m0013,
  '0014_preview_tokens': m0014,
  '0015_preview_draft': m0015,
  '0016_settings': m0016,
  '0017_singleton_preview_path': m0017,
  '0018_field_visibility': m0018,
  '0019_item_values': m0019,
  '0020_perf_indexes': m0020,
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
