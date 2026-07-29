/**
 * Choices that belong to this site rather than to Taproot.
 *
 * Kept in one file so a site builder has somewhere obvious to look, instead of finding routing
 * decisions scattered through templates.
 */

/**
 * Taxonomies whose terms get a public archive page at `/{taxonomy}/{term}`.
 *
 * Taproot deliberately has no opinion here. Most taxonomies on a real site classify content
 * without deserving a page each — a review status, an internal owner, an audience segment — and
 * publishing archives for those would leak editorial structure into the site's URL space. Others,
 * like Departments here, genuinely want one.
 *
 * Two things read this and must agree, which is why it is a constant rather than a check written
 * twice: the catch-all route that serves these pages, and the menu resolver that links to them.
 * A taxonomy absent from this set produces menu entries with no href, which the admin reports as
 * "the site publishes no page for this term" rather than as a broken link.
 */
export const PUBLIC_TERM_TAXONOMIES = new Set(['department']);
