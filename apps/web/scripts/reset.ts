import { rmSync } from 'node:fs';

import { loadEnv, sqlitePath } from './_env.ts';

/**
 * Wipe the local database and re-seed.
 *
 * Deletes the SQLite file outright rather than running migrations down: during development the
 * schema changes faster than the down-migrations are worth maintaining, and a clean file is a
 * guaranteed-consistent starting point.
 *
 * Refuses to touch a remote database — losing production content to a stray `--remote` is not a
 * mistake worth leaving available.
 */
if (process.argv.includes('--remote')) {
  console.error(
    'db:reset only ever operates on the local SQLite database. To rebuild a deployed D1 ' +
      'database, drop and recreate it with wrangler deliberately — see DEPLOYMENT.md.',
  );
  process.exit(1);
}

const env = loadEnv();
const location = sqlitePath(env);

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  rmSync(`${location}${suffix}`, { force: true });
}

console.log(`Removed ${location}`);

// Re-seed by importing, so this stays one process and one code path.
await import('./seed.ts');
