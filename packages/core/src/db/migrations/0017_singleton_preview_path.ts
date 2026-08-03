import type { Kysely } from 'kysely';

/**
 * Where a singleton renders on the public site, so it can be previewed.
 *
 * A singleton's `path` is the synthetic `/__singleton/{api_id}`, which is an addressing convenience
 * and not a URL anybody requests — so the preview pane refused singletons outright, on the correct
 * reasoning that framing that path would show a page nobody will ever see. What the reasoning
 * missed is that a singleton frequently *does* have a page: a homepage assembled from blocks is
 * rendered at `/` by the consumer's `index.astro`, and the only thing Taproot lacked was a way to
 * be told so.
 *
 * Null is the default and means "no page", which keeps the safe answer the one you get by not
 * thinking about it — a global settings singleton holding an address and social links has no URL
 * of its own, and offering it a preview would frame the site's front page and call it the
 * settings record.
 *
 * Only `singleton` uses it. A `page` or `collection` item already knows where it lives, and
 * `previewPathFor` returns `item.path` for both rather than reading this column — one column
 * meaning one thing, the same way `url_prefix` is nulled for every kind that is not a collection.
 *
 * Nothing about *delivery* changes. The consumer still asks `resolve` for `/__singleton/{api_id}`,
 * which is what the preview token is a capability over; this column only says which address the
 * admin should frame. Making it a delivery route would be Taproot asserting how a site routes,
 * which is the same thing the `termHref` callback exists to avoid.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_types').addColumn('preview_path', 'text').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_types').dropColumn('preview_path').execute();
}
