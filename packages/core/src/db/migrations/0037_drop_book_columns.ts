import type { Kysely } from 'kysely';

/**
 * Remove the two book columns, because books are gone.
 *
 * `book_root` (`0034_books`) and `book_child_types` (`0035_book_child_types`) supported a "book" —
 * a subtree treated as one document, with an outline, a reading order and yearly editions. The
 * feature was removed; what it brought that was useful without it stayed, and none of that reads
 * either column: `pathPrefix` narrows a listing to a branch, `duplicateSubtree` copies a subtree,
 * `bulkSubtree` publishes or de-indexes one, and `hide_from_nav` (`0036`) keeps a type out of the
 * sidebar.
 *
 * **The two migrations that added them stay in the registry, and that is not tidiness.** Kysely's
 * `Migrator` throws `corrupted migrations: previously executed migration <name> is missing` when a
 * database has run a migration the registry no longer lists — so deleting either file would break
 * `db:migrate` on every deployment that had already applied it, including any local dev database.
 * An add-then-drop pair costs a fresh clone two statements and needs no manual repair anywhere.
 *
 * Nothing was derived from either column, so there is no `npm run db:reindex` step, and no data is
 * lost that anything still reads.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_types').dropColumn('book_root').execute();
  await db.schema.alterTable('content_types').dropColumn('book_child_types').execute();
}

/**
 * Restores the columns, not the feature.
 *
 * Both come back at their original defaults — `0` and `null` — which is what every row held for any
 * type that was not a book root. There is no way to recover which types were, because the values
 * were dropped; that is accepted rather than worked around, since nothing reads them.
 */
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('content_types')
    .addColumn('book_root', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable('content_types').addColumn('book_child_types', 'text').execute();
}
