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
 * Target aspect ratio, width ÷ height. Present means "crop this for me".
 *
 * The route resolves the asset's stored crop and hotspot against it with the same `resolveCrop` the
 * admin preview and the CSS path use, so the three cannot disagree about what the picture is. The
 * alternative — sending the rectangle itself — puts four free parameters in a URL that is a cache
 * key and a billing key, and makes the client the authority on a calculation the server can already
 * do from the row it is about to read anyway.
 */
export const MEDIA_VARIANT_RATIO = 'ar';

/**
 * A stamp of the hotspot and crop the variant was cropped against. Only meaningful beside `ar`.
 *
 * **Purely a cache key — `parseMediaVariant` deliberately does not read it.** The route resolves the
 * rectangle from the `media` row it is already loading, so the stamp changes nothing about the bytes
 * it produces; what it changes is the *address* those bytes live at. Without it, `?ar=` responses
 * carried `immutable` for a year while their content depended on columns an editor edits, so a moved
 * focal point left the old crop cached with nothing able to clear it: the route emits no `cache-tag`
 * to purge by, and no purge reaches a browser cache regardless. `cropStamp` in `imageCrop.ts`
 * computes it and says more about why.
 */
export const MEDIA_VARIANT_STAMP = 'c';

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
  /** Width ÷ height. Quantised by `parseMediaVariant`; see `RATIO_STEPS`. */
  ratio?: number;
  /**
   * Cache-busting stamp of the crop this was resolved against — `cropStamp(asset)`.
   *
   * Set it only alongside `ratio`: a plain `?w=` variant depends on the stored bytes alone, which a
   * storage key already identifies, so stamping one would re-mint every uncropped image on the site
   * to fix a staleness it cannot have.
   */
  stamp?: string;
}

/**
 * Ratios are rounded to hundredths and clamped, for the reason the width ladder is closed: a URL
 * that accepts any float is a URL where a crawler mints unbounded unique transformations against a
 * 5,000-a-month allowance. Hundredths is far finer than an eye can see at these sizes, and the
 * residual mismatch between a box at `16/9` and an image cropped at `1.78` is absorbed by the
 * `object-fit: cover` the server-cropped path renders with anyway.
 */
const RATIO_STEPS = 100;
const RATIO_MIN = 0.2;
const RATIO_MAX = 5;

/** True when this variant asks for nothing, so the route can serve the stored bytes untouched. */
export function isIdentityVariant(variant: MediaVariant): boolean {
  return (
    variant.width === undefined && variant.format === undefined && variant.ratio === undefined
  );
}

/** Round a ratio onto the grid the route will accept, so both sides agree on the cache key. */
export function quantizeRatio(ratio: number): number | undefined {
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;

  const clamped = Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio));
  return Math.round(clamped * RATIO_STEPS) / RATIO_STEPS;
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
  if (variant.ratio !== undefined) {
    // Quantised on the way out as well as in, so the URL a consumer builds is the one the route
    // would have derived — otherwise every candidate misses the cache by a rounding difference.
    const ratio = quantizeRatio(variant.ratio);
    if (ratio !== undefined) params.push(`${MEDIA_VARIANT_RATIO}=${ratio}`);
  }
  if (variant.format !== undefined) params.push(`${MEDIA_VARIANT_FORMAT}=${variant.format}`);
  /*
   * Last, and only when a ratio came with it. Alone it would change an address without changing the
   * bytes at it, which is a cache entry bought for nothing; `MediaVariant.stamp` says why an
   * uncropped variant has no staleness to fix.
   */
  if (variant.stamp !== undefined && variant.ratio !== undefined) {
    params.push(`${MEDIA_VARIANT_STAMP}=${variant.stamp}`);
  }
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

  const rawRatio = params.get(MEDIA_VARIANT_RATIO);
  if (rawRatio !== null) {
    const ratio = quantizeRatio(Number.parseFloat(rawRatio));
    if (ratio !== undefined) variant.ratio = ratio;
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
/**
 * Rescale a `sizes` list from container widths to element widths.
 *
 * A caller describes the box they placed; `TaprootImage` blows the `<img>` up by `1 / rect.width`
 * so the crop fills that box, and the browser picks a candidate against the **element's** width.
 * Unscaled, every cropped image is chosen one rung too soft — on exactly the layouts where the crop
 * was doing the most work.
 *
 * **Splitting a `sizes` entry on its last space is wrong, and wrong in a way that still parses.**
 * An entry is an optional media condition followed by a length, and the length may itself be a
 * `calc()` full of spaces: on `(min-width: 1024px) calc(50vw - 57px)` the naive split takes `57px)`
 * as the length and emits `calc(50vw - calc(57px) * 1.4)`, which is valid CSS computing the wrong
 * number — it scales one term instead of the expression. Shipped exactly that and found it only by
 * reading rendered HTML.
 *
 * So the boundary is found structurally: the last `)` that closes back to depth zero **and is
 * followed by whitespace** ends the condition, because a length's own trailing `)` is at the end of
 * the entry with nothing after it. No such `)` means the whole entry is the length, which covers a
 * bare `100vw` and a condition-less `calc(100vw - 50px)` alike.
 */
export function scaleSizes(sizes: string, factor: number): string {
  // A factor of one is the uncropped case, and rewriting it would only add noise to the markup.
  if (Math.abs(factor - 1) < 0.005) return sizes;

  const scaled = Number(factor.toFixed(4));

  return sizes
    .split(',')
    .map((entry) => {
      const trimmed = entry.trim();

      let depth = 0;
      let boundary = -1;
      for (let i = 0; i < trimmed.length; i++) {
        const char = trimmed[i];
        if (char === '(') depth++;
        else if (char === ')') {
          depth--;
          if (depth === 0 && /\s/.test(trimmed[i + 1] ?? '')) boundary = i;
        }
      }

      const condition = boundary === -1 ? '' : trimmed.slice(0, boundary + 1);
      const length = boundary === -1 ? trimmed : trimmed.slice(boundary + 1).trim();

      // Parenthesised so the whole length is multiplied, whatever it is made of.
      const expression = `calc((${length}) * ${scaled})`;
      return condition ? `${condition} ${expression}` : expression;
    })
    .join(', ');
}

export function variantWidthsFor(naturalWidth: number | null): number[] {
  if (naturalWidth === null) return [...MEDIA_VARIANT_WIDTHS];

  const rungs = MEDIA_VARIANT_WIDTHS.filter((rung) => rung <= naturalWidth);

  // A source smaller than the bottom rung: offer that rung alone rather than an empty srcset, and
  // let the upscale guard in the route decline to enlarge it.
  if (rungs.length === 0) return [MEDIA_VARIANT_WIDTHS[0]];

  /**
   * The ceiling earns a rung of its own when the ladder stops short of it — **and only when the
   * ladder can actually express it.**
   *
   * The rungs are round numbers and a real image is not: a 3.5:1 photo cropped to 4:3 leaves 605
   * usable pixels, whose largest rung is 480 — so a quarter of the detail that exists would never
   * be offered, and on a retina screen that is the difference between sharp and not. Deterministic
   * per asset and ratio, so it adds exactly one cache entry rather than opening the width up.
   *
   * The second condition is the half that shipped missing. `parseMediaVariant` clamps anything
   * above the top rung *to* the top rung, so a source **wider** than the whole ladder can never be
   * requested at its own width — offering it anyway mints a second URL that is byte-identical to
   * the top candidate while claiming in its `w` descriptor to be wider. Measured in production:
   * `?w=2000` and `?w=1920` both answered 128,232 bytes on a 2000px source, and 62 of that
   * library's 107 images sit above the ladder — so nearly every photograph carried a duplicate
   * rung, a second edge-cache entry, and a candidate the browser would size its choice against
   * wrongly. The tests reached 1920 and stopped, which is why the whole above-the-ladder case was
   * unexamined.
   */
  const top = rungs[rungs.length - 1] ?? 0;
  // `?? 0`, matching `top` above. Unreachable — the ladder is a non-empty literal — and it fails
  // towards *not* offering a ceiling, which is the direction this whole condition exists to guard.
  const ladderTop = MEDIA_VARIANT_WIDTHS[MEDIA_VARIANT_WIDTHS.length - 1] ?? 0;

  return top < naturalWidth && naturalWidth < ladderTop ? [...rungs, naturalWidth] : [...rungs];
}
