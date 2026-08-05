import { cropRectPixels, type MediaCropSource } from '../content/imageCrop.js';
import {
  isIdentityVariant,
  type MediaVariant,
  type MediaVariantFormat,
} from '../content/imageVariants.js';

/**
 * Structural type for the Cloudflare Images binding — only the surface actually used, declared
 * locally so `@taprootcms/core` does not need `@cloudflare/workers-types` installed downstream.
 * Same reason and same shape as `R2BucketLike`.
 */
export interface ImagesBindingLike {
  input(stream: ReadableStream | ArrayBuffer | Uint8Array): ImageTransformerLike;
}

export interface ImageTransformerLike {
  transform(options: {
    width?: number;
    height?: number;
    fit?: string;
    trim?: { top?: number; left?: number; width?: number; height?: number };
  }): ImageTransformerLike;
  output(options: { format?: string; quality?: number }): Promise<ImageResultLike>;
}

export interface ImageResultLike {
  image(): ReadableStream;
  contentType(): string;
}

/** Our short format names to the MIME types the binding wants. */
const OUTPUT_MIME: Record<MediaVariantFormat, string> = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/**
 * Formats worth handing to the resizer.
 *
 * SVG is deliberately absent: it is already resolution-independent, rasterising it to a fixed width
 * throws that away, and it is the one image type on this route whose bytes are also a script vector
 * — leaving it on the untouched path keeps it under exactly the headers the route already sets for
 * it. GIF is absent because a resize would flatten an animation to its first frame, which is a
 * silent content change rather than an optimisation.
 */
const RESIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

export function isResizable(mimeType: string): boolean {
  return RESIZABLE.has(mimeType);
}

/**
 * Resize stored bytes, or answer `undefined` to mean "serve what you already have".
 *
 * **Every failure here is a fallback, never an error.** A transform that throws — an unsupported
 * source, a monthly transformation allowance reached, a binding that is not present because the
 * deployment is Node or the operator has not added it — must produce the original image rather than
 * a broken one. An image is the part of a page a visitor most visibly loses, and no resize is worth
 * a 500 on it. The caller gets `undefined` and serves the stored object exactly as it did before
 * this existed, which is also what makes the whole feature safe to ship to deployments that cannot
 * use it.
 *
 * `fit: 'scale-down'` is what stops an enlargement. `variantWidthsFor` already declines to offer a
 * rung above the source, but that is a claim about what a *cooperating* consumer asks for, and this
 * route answers whatever arrives in a URL.
 */
export async function resizeImage(
  images: ImagesBindingLike | undefined,
  bytes: Uint8Array,
  sourceMimeType: string,
  variant: MediaVariant,
  source?: MediaCropSource,
): Promise<{ bytes: ReadableStream; contentType: string } | undefined> {
  if (!images) return undefined;
  if (!isResizable(sourceMimeType)) return undefined;
  if (isIdentityVariant(variant)) return undefined;

  try {
    let pipeline = images.input(bytes);

    /**
     * Crop first, then scale — two `transform` calls because the order is the point, and chaining
     * is how the binding lets you state it.
     *
     * The rectangle comes from `resolveCrop`, the same function the admin's preview frames and the
     * CSS path use, so a picture cropped here is the picture the editor was shown. Reaching for
     * `fit: 'crop'` with a `gravity` focal point instead would have been fewer lines and would
     * quietly ignore the crop an editor dragged, honouring only the hotspot.
     */
    if (variant.ratio !== undefined && source) {
      const rect = cropRectPixels(source, variant.ratio);
      if (rect) pipeline = pipeline.transform({ trim: rect });
    }

    if (variant.width !== undefined) {
      pipeline = pipeline.transform({ width: variant.width, fit: 'scale-down' });
    }

    const result = await pipeline.output(
      variant.format ? { format: OUTPUT_MIME[variant.format] } : {},
    );

    return { bytes: result.image(), contentType: result.contentType() };
  } catch (error) {
    /**
     * Logged rather than swallowed, because the difference between "this deployment has no binding"
     * and "every transform is failing" is invisible from the outside: both serve correct images at
     * the wrong size, and the page looks fine while the bill or the allowance says otherwise.
     */
    console.error('[taproot] image transform failed; serving the original', error);
    return undefined;
  }
}
