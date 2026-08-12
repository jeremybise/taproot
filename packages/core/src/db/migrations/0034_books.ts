import { sql, type Kysely } from 'kysely';

/**
 * Whether items of this type are the root of a book.
 *
 * A book is a document rather than a section of a site — a course catalog, a student handbook, a
 * policy manual — and what makes it one is that it has an *outline*: a reading order, a table of
 * contents, and previous/next between its sections. The catalog this was built for runs to 188
 * sections across 13 top-level chapters and is reissued every year.
 *
 * **A subtree, not a new entity.** Taproot already stores everything a book needs: a `page` tree is
 * an outline, `path` is materialised, and `depth` and `position` give the ordering. A `books` table
 * would create a second place for a section's position to live — the same objection that killed
 * regions in Phase 2, a departments entity in Phase 3, and a separate table for block types.
 *
 * **A column rather than a fifth kind**, exactly as `item_pages` is. `kind` answers *how are this
 * type's instances addressed*, and a book root is addressed precisely as a page is: nested under a
 * parent, at its own path, in the site tree. What the flag adds is that the subtree beneath it is
 * treated as one document. A kind would fork every screen that switches on kind to say the same
 * thing twice.
 *
 * **Editions are deliberately not modelled.** An edition is a sibling subtree produced by copying —
 * `/catalog/2026-27` and `/catalog/2027-28` are two books, and the "Catalog" that owns them is their
 * shared parent, an ordinary page whose children `resolveDelivery` already returns. So a year
 * switcher and an archived-year banner need no new delivery surface, and `year_label`, `is_current`
 * and `archived` stay ordinary user-defined fields. Freezing a published year falls out of the
 * copies being different rows, which is the property the whole feature exists to give.
 *
 * Default 0, so no existing deployment gains a book it did not ask for, and meaningful only for
 * `page` — the write paths force it to 0 for every other kind, exactly as they null `url_prefix` for
 * a page and `preview_path` for anything that is not a singleton. A `collection` is flat under a
 * `url_prefix` and a `singleton` has one item, so neither has a tree to outline.
 *
 * Nothing is derived from this column, so there is no `npm run db:reindex` step.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table content_types add column book_root integer not null default 0
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_types').dropColumn('book_root').execute();
}
