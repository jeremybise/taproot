/**
 * The URL vocabulary for a resized media variant.
 *
 * Its own pure module for the reason `cacheTags.ts` is one: both sides of the wire have to spell
 * these identically, and a mismatch is **silent**. The consumer asks for `?w=640`, the route reads
 * `width`, every visitor is served the full-size original, and every test still passes — the same
 * failure shape as a purge that reports success and clears nothing. The route parses with
 * `parseMediaVariant` and the consumer builds with `mediaVariantUrl`, so there is one spelling.
 *
 * Nothing here imports anything, which is what lets `pure.ts` hand it to a consumer that must never
 * see Kysely.
 */

/** Target width in pixels. Snapped to `MEDIA_VARIANT_WIDTHS` on the way in — see `parseMediaVariant`. */
export const MEDIA_VARIANT_WIDTH = 'w';

/** Output format. Absent means "whatever was uploaded". */
export const MEDIA_VARIANT_FORMAT = 'f';

/**
 * The width ladder, and the only widths the route will ever produce.
 *
 * **A fixed ladder is a cost control, not a style preference.** Cloudflare bills a *unique
 * transformation* per distinct combination of source image and parameters, with 5,000 free per
 * month, and a URL that accepts any integer is a URL where one crawler walking `?w=1` upward burns
 * the month's allowance and fills the edge cache with thousands of near-identical entries. Snapping
 * to a closed set bounds both: eight widths per image, whatever anybody asks for.
 *
 * The values are the common CSS breakpoints doubled up at the small end, where the difference
 * between 320 and 480 is most of a phone's payload.
 */
export const MEDIA_VARIANT_WIDTHS = [320, 480, 640, 768, 1024, 1280, 1536, 1920] as const;

/**
 * Formats the route will encode to.
 *
 * **Negotiating on `Accept` was rejected.** The obvious design is `f=auto` and let the CDN pick
 * AVIF or WebP per browser — but this route's responses are stored in Cloudflare's cache keyed on
 * the URL, and `Vary` is honoured there only for `Accept-Encoding`. A negotiated format would mean
 * the first visitor's format being served to everyone after them, which is the same class of bug as
 * the admin HTML that got cached. The format is therefore part of the URL or it does not happen.
 */
export const MEDIA_VARIANT_FORMATS = ['webp', 'avif', 'jpeg', 'png'] as const;

export type MediaVariantFormat = (typeof MEDIA_VARIANT_FORMATS)[number];

export interface MediaVariant {
  width?: number;
  format?: MediaVariantFormat;
}

/** True when this variant asks for nothing, so the route can serve the stored bytes untouched. */
export function isIdentityVariant(variant: MediaVariant): boolean {
  return variant.width === undefined && variant.format === undefined;
}

/**
 * Add variant parameters to a media URL.
 *
 * Takes and returns a string rather than a `URL` because `DeliveryMedia.url` may be absolute or
 * root-relative depending on whether `TAPROOT_MEDIA_URL` is set, and `new URL(relative)` throws.
 * Appending textually works for both and keeps this dependency-free.
 */
export function mediaVariantUrl(url: string, variant: MediaVariant): string {
  const params: string[] = [];
  if (variant.width !== undefined) params.push(`${MEDIA_VARIANT_WIDTH}=${variant.width}`);
  if (variant.format !== undefined) params.push(`${MEDIA_VARIANT_FORMAT}=${variant.format}`);
  if (params.length === 0) return url;

  return `${url}${url.includes('?') ? '&' : '?'}${params.join('&')}`;
}

/**
 * Read variant parameters off a request, discarding anything not on the ladder.
 *
 * **Snapping up rather than rejecting.** A width between two rungs is a caller that reasoned about
 * layout rather than about this list, and refusing it would serve them a full-size original — the
 * expensive answer to a reasonable request. Snapping *up* keeps the image at least as sharp as
 * asked for; snapping down would silently blur it. Anything past the top rung lands on the top
 * rung, which is also what stops `?w=99999` from being a way to ask for an upscale.
 */
export function parseMediaVariant(params: URLSearchParams): MediaVariant {
  const variant: MediaVariant = {};

  const rawWidth = params.get(MEDIA_VARIANT_WIDTH);
  if (rawWidth !== null) {
    const width = Number.parseInt(rawWidth, 10);
    if (Number.isFinite(width) && width > 0) {
      variant.width =
        MEDIA_VARIANT_WIDTHS.find((rung) => rung >= width) ??
        MEDIA_VARIANT_WIDTHS[MEDIA_VARIANT_WIDTHS.length - 1];
    }
  }

  const rawFormat = params.get(MEDIA_VARIANT_FORMAT);
  if (rawFormat !== null) {
    const format = MEDIA_VARIANT_FORMATS.find((known) => known === rawFormat);
    if (format) variant.format = format;
  }

  return variant;
}

/**
 * The rungs worth offering for one image.
 *
 * **Never offer a rung above the source's own width.** Asking a resizer to enlarge produces a
 * bigger file carrying no more detail, and a retina browser will pick it happily.
 *
 * A rung is a width of the **whole source**, not of the part that ends up on screen — which is why
 * the crop does not appear here. `TaprootImage` shows a sub-rectangle blown up to fill its box, so
 * a 640px-wide variant puts only `640 × rect.width` pixels behind the visible area. That factor is
 * carried by `sizes` instead, where the browser applies it while choosing; folding it in here as
 * well would apply it twice and offer nothing but oversized rungs.
 *
 * `naturalWidth` null — an upload whose header bytes could not be read — returns the whole ladder
 * rather than nothing, because the alternative is no `srcset` at all for that asset.
 */
export function variantWidthsFor(naturalWidth: number | null): number[] {
  const rungs = MEDIA_VARIANT_WIDTHS.filter((rung) => naturalWidth === null || rung <= naturalWidth);

  // A source smaller than the bottom rung: offer that rung alone rather than an empty srcset, and
  // let the upscale guard in the route decline to enlarge it.
  return rungs.length > 0 ? [...rungs] : [MEDIA_VARIANT_WIDTHS[0]];
}
