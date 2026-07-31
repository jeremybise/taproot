import type { Kysely } from 'kysely';

/**
 * When a scheduled item should go live.
 *
 * Distinct from `published_at`, which records when something *went* live and is written at the
 * moment it happens. Reusing that column for both would make "published two hours ago" and "goes
 * live in two hours" the same value, and the only thing telling them apart would be a status that
 * the scheduler is in the middle of changing.
 *
 * Indexed with `status`, because the only query is "scheduled items whose time has come" and it
 * runs on a timer against every row in the table. Without the index that is a scan, on a schedule,
 * forever.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_items').addColumn('publish_at', 'text').execute();

  await db.schema
    .createIndex('content_items_publish_at_idx')
    .on('content_items')
    .columns(['status', 'publish_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('content_items_publish_at_idx').execute();
  await db.schema.alterTable('content_items').dropColumn('publish_at').execute();
}
