import { migrateToLatest } from '@taproot/core';

import { openDb } from './_db.ts';

const { handle, target } = await openDb();

console.log(`Migrating ${target}`);

const { applied, error } = await migrateToLatest(handle.db);

for (const name of applied) {
  console.log(`  applied ${name}`);
}

if (error) {
  console.error('\nMigration failed:', error instanceof Error ? error.message : error);
  await handle.destroy();
  process.exit(1);
}

console.log(applied.length === 0 ? 'Already up to date.' : `Done — ${applied.length} applied.`);
await handle.destroy();
