import { sql, type Kysely } from 'kysely';

/**
 * Scope the root-level slug index to the content type, which is what the code always meant.
 *
 * `0001_init` created two partial indexes because SQLite has no `NULLS NOT DISTINCT`, and the
 * null-parent half came out as `(slug) WHERE parent_id IS NULL` — one flat namespace shared by
 * **every** root item on the site. But `parent_id` is null for far more than root pages:
 * `createItem` forces it null for every kind except `page`, so every collection item and every
 * singleton lands in that namespace too.
 *
 * The application never believed that. `siblingSlugs` scopes the null-parent case by
 * `content_type_id` — collection items are siblings of their own type, not of the front page — so
 * `uniqueSlug` never disambiguated across types and the write went straight into the index. Measured
 * against the seeded database: a new `event` slugged `about` finds zero sibling slugs, so the slug is
 * left alone, and collides with the root page `/about`. On D1 the whole batch fails and the only
 * thing the editor is told is `D1 batch failed at statement 1 of N`.
 *
 * That is not hypothetical on a college site. The seed already carries `/financial-aid` and
 * `/events/financial-aid-night`; an event or news item titled "Financial Aid" slugifies straight onto
 * the page.
 *
 * **Nothing is lost by narrowing it.** `content_items_path_unique` is the constraint that actually
 * matters, and it already implies slug uniqueness inside every namespace that is addressable: a root
 * page is `/{slug}`, a collection item is `/{url_prefix}/{slug}`, and two of either sharing a slug
 * would collide on `path` regardless. This index was never the thing keeping URLs distinct — it was
 * only ever colliding rows that address different URLs.
 *
 * `terms` had this right from the start: `terms_root_slug_unique` is `(taxonomy_id, slug) WHERE
 * parent_id IS NULL`. This is the same fix one table along.
 *
 * Strictly weaker than what it replaces, so no existing row can violate it and there is nothing to
 * backfill.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`drop index content_items_root_slug_unique`.execute(db);

  await sql`
    CREATE UNIQUE INDEX content_items_root_slug_unique
    ON content_items (content_type_id, slug)
    WHERE parent_id IS NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index content_items_root_slug_unique`.execute(db);

  // Recreating the original, over-broad form. Note this can fail on a database that has since taken
  // advantage of the wider namespace — which is the point of the migration, not a flaw in the revert.
  await sql`
    CREATE UNIQUE INDEX content_items_root_slug_unique
    ON content_items (slug)
    WHERE parent_id IS NULL
  `.execute(db);
}
