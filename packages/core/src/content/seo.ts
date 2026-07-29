import type { ContentTypeRow } from '../db/schema.js';
import type { ContentItem, SeoData } from './items.js';

/**
 * SEO resolution: what a page actually claims to be, once fallbacks are applied.
 *
 * The point of putting this in core rather than in the template is that the admin's preview and
 * the public page must agree. A preview that resolves its own fallbacks is a preview of something
 * nobody will ever see — the failure mode is silent and only shows up in a social-media share
 * weeks later. Both callers go through `resolveSeo`.
 */

/**
 * Lengths at which the previews warn.
 *
 * These are guidance, not limits, and the UI must say so. Google truncates by *pixel width*, not
 * character count, and the width depends on the glyphs — so no character count is ever exactly
 * right, and enforcing one with `maxLength` would block a legitimate title that happens to be
 * narrow. Nothing here is validated server-side for the same reason; over-length content is a
 * quality warning, not an error worth refusing a save over.
 */
export const SEO_GUIDANCE = {
  /** Roughly where a search result title starts being cut off. */
  titleChars: 60,
  /** Roughly where a search result description starts being cut off. */
  descriptionChars: 160,
} as const;

export interface ResolvedSeo {
  /** What goes in `<title>` and the search-result heading. Never empty — falls back to the title. */
  title: string;
  /** Meta description, or null when the editor has written none. */
  description: string | null;
  /** Media id for the social card, after the item → content type fallback. */
  ogImageId: string | null;
  /** Where that image came from, so the editor can be told it is inheriting rather than unset. */
  ogImageSource: 'item' | 'contentType' | 'none';
  /** Whether the page asks not to be indexed. */
  noIndex: boolean;
}

/**
 * A trimmed value, or null when there is nothing but whitespace.
 *
 * SEO fields are stored as written, so `"  "` reaches here and would otherwise resolve as a
 * present-but-blank title, overriding the item's real one with nothing.
 */
function present(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveSeo(
  item: { title: string; seo: SeoData },
  contentType?: Pick<ContentTypeRow, 'default_og_image_id'> | null,
): ResolvedSeo {
  const ownImage = present(item.seo.ogImageId);
  const typeImage = present(contentType?.default_og_image_id);

  return {
    title: present(item.seo.metaTitle) ?? item.title,
    // No fallback to an excerpt of the body. A description assembled from the first sentence of a
    // page reads like a machine wrote it, which is exactly what a search result should not do —
    // and search engines already do a better job of choosing a snippet than a truncation would.
    description: present(item.seo.metaDescription),
    ogImageId: ownImage ?? typeImage,
    ogImageSource: ownImage ? 'item' : typeImage ? 'contentType' : 'none',
    noIndex: item.seo.noIndex === true,
  };
}

/**
 * Trim text the way a search result does, at a word boundary with an ellipsis.
 *
 * Used only by the preview. Nothing truncates what is stored — the editor's words are kept whole
 * and the preview shows what a search engine is likely to do with them.
 */
export function truncateForPreview(text: string, limit: number): string {
  if (text.length <= limit) return text;

  const cut = text.slice(0, limit);

  // The cut already landed on a word boundary, so there is no broken word to back away from.
  // Without this, a title that fits exactly loses its last whole word for no reason.
  if (text[limit] === ' ') return `${cut.trimEnd()}…`;

  const lastSpace = cut.lastIndexOf(' ');

  /**
   * Break at the last space, unless doing so would throw away more than half the allowance.
   *
   * The guard covers a word longer than the limit, where `lastSpace` is -1 or sits near the start
   * — breaking there would show a couple of characters and claim the rest was cut off, which is a
   * worse lie than the mid-word cut search engines themselves sometimes make.
   */
  const breakAt = lastSpace > limit * 0.5 ? lastSpace : limit;

  return `${cut.slice(0, breakAt).trimEnd()}…`;
}

/**
 * The absolute URL a page will be shared and indexed under.
 *
 * Takes the site origin as an argument rather than reading configuration: core has no idea what
 * host it is deployed behind, and a canonical URL guessed from a request header is how staging
 * environments end up claiming to be production.
 */
export function canonicalUrl(origin: string, path: string): string {
  return new URL(path, origin.endsWith('/') ? origin : `${origin}/`).toString();
}

/** Convenience for the common case of resolving straight off a hydrated item. */
export function resolveItemSeo(
  item: ContentItem,
  contentType?: Pick<ContentTypeRow, 'default_og_image_id'> | null,
): ResolvedSeo {
  return resolveSeo(item, contentType);
}
