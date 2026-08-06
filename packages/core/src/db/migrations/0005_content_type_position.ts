import type { Kysely } from 'kysely';

/**
 * Sort order for content types, which is what orders them in the admin sidebar.
 *
 * Each content type is its own sidebar entry rather than a filter on one shared list, so the
 * order stops being cosmetic — it decides what an editor reaches first every day. That is a
 * judgement about a particular site, not something a CMS can guess from names.
 *
 * Defaults to 0 rather than being backfilled per row. Reads order by `position` then `name`, so a
 * site that never touches the order keeps today's alphabetical listing, and one that does gets
 * real positions written for every type at once. That avoids a backfill needing `ROW_NUMBER`,
 * which a migration has no cheap portable form for and which nothing needs.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('content_types')
    .addColumn('position', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_types').dropColumn('position').execute();
}
