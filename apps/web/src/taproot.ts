import { createTaprootClient } from '@taprootcms/astro';

/**
 * This site's connection to its CMS.
 *
 * One module so there is one place a site builder looks for it, and so the credentials are read
 * once rather than in every route.
 *
 * `TAPROOT_API_KEY` is optional against a local studio, where a signed-in session reaches the
 * delivery API too — which is what makes opening a delivery URL in a browser to see what this site
 * receives possible while debugging. A deployed site needs a real key.
 */
export const taproot = createTaprootClient({
  url: import.meta.env.TAPROOT_API_URL ?? process.env.TAPROOT_API_URL ?? 'http://localhost:4321',
  apiKey: import.meta.env.TAPROOT_API_KEY ?? process.env.TAPROOT_API_KEY,
});

/**
 * Taxonomies whose terms get a public archive page at `/{taxonomy}/{term}`.
 *
 * Taproot deliberately has no opinion here, and after the split that is no longer a convention — it
 * is enforced by the boundary. The delivery API returns term targets *unresolved*, because a
 * `termHref` callback cannot cross an HTTP boundary, so this set is the only thing that decides
 * which terms become links. Most taxonomies on a real site classify content without deserving a
 * page each — a review status, an internal owner, an audience segment — and publishing archives for
 * those would leak editorial structure into the site's URL space.
 *
 * Two things read this and must agree, which is why it is a constant rather than a check written
 * twice: the catch-all route that serves these pages, and the menu resolver that links to them.
 */
export const PUBLIC_TERM_TAXONOMIES = new Set(['department']);

/** This site's answer to "where does a term live", handed to `applyTermHrefs`. */
export function termHref(term: { taxonomyApiId: string; slug: string }): string | null {
  return PUBLIC_TERM_TAXONOMIES.has(term.taxonomyApiId)
    ? `/${term.taxonomyApiId}/${term.slug}`
    : null;
}
