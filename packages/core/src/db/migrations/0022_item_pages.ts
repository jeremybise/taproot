import { sql, type Kysely } from 'kysely';

/**
 * Whether a collection's items have pages of their own.
 *
 * A staff directory is the case this exists for: the people are real content items — created,
 * edited, versioned, classified by department, listed on `/directory` — and none of them wants a URL.
 * Without this the CMS insists otherwise: `/people/marguerite-okafor` resolves, a consumer's
 * catch-all renders a bare field dump at it, the admin offers a "view page" link to a page nobody
 * designed, and site search returns it.
 *
 * **A column rather than a fourth kind.** `kind` answers *how are this type's instances addressed*,
 * and a routeless collection is addressed exactly as a collection is — flat, under a `url_prefix`,
 * one row per item, with a list screen and a create button. What changes is only whether that
 * address is a public URL. Making it a kind would fork every screen that switches on kind to say the
 * same thing twice.
 *
 * **The path stays.** An item still has one, still unique and still indexed: it is how the admin
 * addresses the row, how a preview token is scoped, and what the item would go back to having if
 * somebody turns pages on later. What the flag governs is whether anything is served at it.
 *
 * Default 1, so every existing collection keeps the behaviour it has today, and meaningful only for
 * `collection` — the write paths force it to 1 for every other kind, exactly as they null
 * `url_prefix` for a page and `preview_path` for anything that is not a singleton. A `page` is a node
 * in the site tree and its whole identity is its position in it; there is nothing coherent to turn
 * off.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table content_types add column item_pages integer not null default 1
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_types').dropColumn('item_pages').execute();
}
