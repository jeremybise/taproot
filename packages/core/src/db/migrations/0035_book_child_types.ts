import { sql, type Kysely } from 'kysely';

/**
 * Adds `content_types.book_child_types`. **Superseded by `0037_drop_book_columns`, which drops it.**
 *
 * It held the content type ids a book's outline offered to create. That feature was removed; this
 * migration stays for the reason `0034_books` does — Kysely refuses to migrate a database that has
 * executed a migration the registry no longer lists. Nothing reads this column.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table content_types add column book_child_types text
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_types').dropColumn('book_child_types').execute();
}
