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
  try {
    rmSync(`${location}${suffix}`, { force: true });
  } catch (error) {
    /**
     * Windows holds an exclusive lock on an open SQLite file, so a running dev server makes the
     * delete fail with EPERM. On Linux and macOS the unlink succeeds and the running server keeps
     * writing to a file nobody can find any more, which is worse but silent.
     *
     * Either way the fix is the same, and a raw EPERM stack does not suggest it.
     */
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY') {
      console.error(
        `Cannot delete ${location} — something still has it open.\n\n` +
          'The dev server is the usual culprit. Astro 7 daemonises it, so it can be running even ' +
          'with no terminal attached:\n\n' +
          '  npm run astro --workspace=@taprootcms/web -- dev stop\n\n' +
          'then run db:reset again.',
      );
      process.exit(1);
    }
    throw error;
  }
}

console.log(`Removed ${location}`);

// Re-seed by importing, so this stays one process and one code path.
await import('./seed.ts');
