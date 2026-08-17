import { sql, type Kysely } from 'kysely';

/**
 * Adds `content_types.book_root`. **Superseded by `0037_drop_book_columns`, which drops it.**
 *
 * It marked a content type whose items were the root of a "book" — a subtree treated as one
 * document, with an outline and yearly editions. That feature was removed; this migration stays
 * because Kysely refuses to migrate a database that has executed a migration the registry no longer
 * lists, so the pair has to be add-then-drop rather than a deletion. Nothing reads this column.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table content_types add column book_root integer not null default 0
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_types').dropColumn('book_root').execute();
}
