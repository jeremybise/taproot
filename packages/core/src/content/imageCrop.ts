/**
 * Hotspot and crop resolution.
 *
 * The model is Sanity's, and the reason to copy it is that it separates two decisions editors
 * actually make separately: *what part of this image matters* (the hotspot) and *what part of it is
 * worth showing at all* (the crop). Both are stored normalised, independent of pixels, so one asset
 * drives a 16:9 hero, a square thumbnail, and a 3:4 portrait card — each computed on demand rather
 * than pre-generated and stored per shape.
 *
 * The alternative — baking a crop per use — means every new template needs a person to re-crop
 * every image, and an image reused in a shape nobody anticipated is simply wrong.
 *
 * Nothing here touches pixels. `resolveCrop` returns a rectangle in normalised source coordinates,
 * which the admin preview turns into CSS and a delivery layer turns into image-CDN parameters.
 */

/** Focal point in normalised source coordinates. Defaults to the centre. */
export interface Hotspot {
  x: number;
  y: number;
}

/** Insets from each edge, normalised. `{ top: 0.1 }` discards the top tenth of the image. */
export interface Crop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A rectangle in normalised source coordinates: `{0,0,1,1}` is the whole image. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The columns as they come off a media row, any of which may be null. */
export interface MediaCropSource {
  width?: number | null;
  height?: number | null;
  hotspot_x?: number | null;
  hotspot_y?: number | null;
  crop_top?: number | null;
  crop_right?: number | null;
  crop_bottom?: number | null;
  crop_left?: number | null;
}

export const DEFAULT_HOTSPOT: Hotspot = { x: 0.5, y: 0.5 };
export const NO_CROP: Crop = { top: 0, right: 0, bottom: 0, left: 0 };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Read the hotspot off a media row, falling back to the centre.
 *
 * Centre rather than "unset" because every consumer needs *a* focal point, and making each one
 * decide would guarantee they disagreed.
 */
export function hotspotOf(media: MediaCropSource): Hotspot {
  return {
    x: typeof media.hotspot_x === 'number' ? clamp01(media.hotspot_x) : DEFAULT_HOTSPOT.x,
    y: typeof media.hotspot_y === 'number' ? clamp01(media.hotspot_y) : DEFAULT_HOTSPOT.y,
  };
}

/**
 * Read the crop off a media row, discarding a nonsensical one.
 *
 * Opposite insets summing to 1 or more would leave a zero-width region, and everything downstream
 * divides by that. A stored crop that bad can only come from a bug or a hand-written API call;
 * treating it as "no crop" keeps a broken value from turning into a broken page.
 */
export function cropOf(media: MediaCropSource): Crop {
  const crop = {
    top: clamp01(media.crop_top ?? 0),
    right: clamp01(media.crop_right ?? 0),
    bottom: clamp01(media.crop_bottom ?? 0),
    left: clamp01(media.crop_left ?? 0),
  };

  return crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1 ? NO_CROP : crop;
}

/** The cropped region as a rectangle, before any target shape is applied. */
export function cropRect(crop: Crop): CropRect {
  return {
    x: crop.left,
    y: crop.top,
    width: 1 - crop.left - crop.right,
    height: 1 - crop.top - crop.bottom,
  };
}

/**
 * The region of the source to show for a target aspect ratio.
 *
 * Two steps, in this order:
 *
 *  1. Take the crop. Everything outside it is discarded — the editor has said it is not part of the
 *     picture, so no target shape may reach back into it.
 *  2. Inside that, take the largest rectangle of the requested aspect ratio and slide it so the
 *     hotspot sits at its centre, clamped to stay within the crop.
 *
 * Clamping rather than letting the frame overhang is what makes the result always a real region of
 * a real image. A hotspot near an edge pulls the frame as far as it can and then stops, which is
 * the behaviour an editor expects from "keep this face in shot".
 *
 * `targetAspect` is width ÷ height. When the source's pixel dimensions are unknown the crop is
 * assumed to already be the right shape and is returned as-is — the honest answer, since without
 * dimensions there is no way to know how a normalised rectangle maps to proportions.
 */
export function resolveCrop(
  media: MediaCropSource,
  targetAspect: number,
  hotspotOverride?: Hotspot,
  cropOverride?: Crop,
): CropRect {
  const crop = cropOverride ?? cropOf(media);
  const region = cropRect(crop);
  const hotspot = hotspotOverride ?? hotspotOf(media);

  const sourceWidth = media.width ?? 0;
  const sourceHeight = media.height ?? 0;
  if (!(sourceWidth > 0 && sourceHeight > 0) || !(targetAspect > 0)) return region;

  // Aspect of the cropped region in real pixels, which is what the target has to be fitted into.
  const regionAspect = (region.width * sourceWidth) / (region.height * sourceHeight);

  let width = region.width;
  let height = region.height;

  if (regionAspect > targetAspect) {
    // Too wide: keep the full height and narrow the width.
    width = (region.height * sourceHeight * targetAspect) / sourceWidth;
  } else {
    // Too tall: keep the full width and shorten the height.
    height = (region.width * sourceWidth) / targetAspect / sourceHeight;
  }

  return {
    x: clampWithin(hotspot.x - width / 2, region.x, region.x + region.width - width),
    y: clampWithin(hotspot.y - height / 2, region.y, region.y + region.height - height),
    width,
    height,
  };
}

/**
 * Clamp, tolerating an inverted range.
 *
 * Floating-point rounding can leave `max` a hair below `min` when the fitted rectangle is the full
 * region; without this the result would jump to the wrong edge on an image that needed no
 * adjustment at all.
 */
function clampWithin(value: number, min: number, max: number): number {
  if (max <= min) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * CSS that renders exactly `rect` filling its container, as a background image.
 *
 * Background rather than `object-fit: cover` with `object-position`: object-position can only slide
 * the *whole* image within the container's overflow, so it can express a hotspot but not a crop —
 * the cropped-away edges would still be on screen. Scaling the background up by the inverse of the
 * rectangle and then positioning it is the only pure-CSS way to show a sub-region of an image.
 *
 * The position percentages are the standard background-position identity: a background scaled
 * larger than its box positions by the fraction of the *overflow*, so `x / (1 - width)` is the
 * offset that puts the rectangle's left edge at the container's left edge. When the rectangle
 * spans the full axis there is no overflow to divide by, and any value is equivalent.
 *
 * This is how the admin previews four crops of one file without generating a single image. A
 * delivery layer would pass the same rectangle to an image CDN instead.
 */
export interface CropBackground {
  backgroundSize: string;
  backgroundPosition: string;
}

export function cropBackground(rect: CropRect): CropBackground {
  const pct = (value: number) => `${(value * 100).toFixed(3)}%`;

  const freeX = 1 - rect.width;
  const freeY = 1 - rect.height;

  return {
    backgroundSize: `${pct(1 / rect.width)} ${pct(1 / rect.height)}`,
    backgroundPosition: `${pct(freeX <= 0 ? 0.5 : clamp01(rect.x / freeX))} ${pct(
      freeY <= 0 ? 0.5 : clamp01(rect.y / freeY),
    )}`,
  };
}

/**
 * The aspect ratios the editor previews.
 *
 * The point of showing several at once is that an editor picking a focal point is making one
 * decision that plays out in every shape the image will ever appear in — and they cannot judge it
 * from a single frame. These are the common ones; a host site with unusual shapes can pass its own.
 */
export const PREVIEW_ASPECTS: { label: string; ratio: number; hint: string }[] = [
  { label: 'Wide', ratio: 16 / 9, hint: 'Hero banners' },
  { label: 'Social card', ratio: 1200 / 630, hint: 'Shared links' },
  { label: 'Square', ratio: 1, hint: 'Thumbnails and avatars' },
  { label: 'Portrait', ratio: 3 / 4, hint: 'Cards and profiles' },
];
