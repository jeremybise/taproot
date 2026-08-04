import { reindexValues } from '@taprootcms/core';

import { openDb } from './_db.ts';

/**
 * Rebuild the derived value index for every content item.
 *
 * **Run this once after `0019_item_values`, on any database with content already in it.** The
 * migration creates the table empty, and a migration cannot fill it: it would need every content
 * type's field definitions and a walk over each item's stored JSON, which is application knowledge
 * rather than schema knowledge. Until this has run, every `query` field that filters or orders by a
 * field value answers as though nothing matched — content is not lost, it is just invisible to
 * listings.
 *
 * Safe to run again at any time. It rebuilds from `content_items.data`, which is the source of
 * truth, so the worst a second run costs is the time.
 */
const { handle, target } = await openDb();

console.log(`Reindexing ${target}`);

try {
  const { items } = await reindexValues(handle, (done, total) => {
    // Progress rather than silence: this walks every item, and on a real site that is long enough
    // that a quiet terminal reads as a hang.
    if (done % 50 === 0 || done === total) console.log(`  ${done}/${total}`);
  });

  console.log(`Done — ${items} ${items === 1 ? 'item' : 'items'} reindexed.`);
} catch (error) {
  console.error('\nReindex failed:', error instanceof Error ? error.message : error);
  await handle.destroy();
  process.exit(1);
}

await handle.destroy();
