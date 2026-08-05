import { describe, expect, it, vi } from 'vitest';

import { isResizable, resizeImage, type ImagesBindingLike } from './images.js';

const BYTES = new Uint8Array([1, 2, 3]);

/** A binding that records what it was asked for and hands back a plausible result. */
function fakeBinding(): ImagesBindingLike & { calls: { transform: unknown[]; output: unknown[] } } {
  const calls = { transform: [] as unknown[], output: [] as unknown[] };

  const transformer = {
    transform(options: unknown) {
      calls.transform.push(options);
      return transformer;
    },
    async output(options: unknown) {
      calls.output.push(options);
      return {
        image: () => new ReadableStream(),
        contentType: () => 'image/webp',
      };
    },
  };

  return { calls, input: () => transformer };
}

describe('resizeImage', () => {
  it('resizes and re-encodes when asked', async () => {
    const images = fakeBinding();
    const result = await resizeImage(images, BYTES, 'image/png', { width: 640, format: 'webp' });

    expect(result?.contentType).toBe('image/webp');
    expect(images.calls.transform).toEqual([{ width: 640, fit: 'scale-down' }]);
    expect(images.calls.output).toEqual([{ format: 'image/webp' }]);
  });

  /**
   * `variantWidthsFor` already declines to offer a rung above the source, but that is a claim about
   * what a cooperating consumer asks for — this route answers whatever arrives in a URL, and
   * enlarging produces a bigger file carrying no more detail.
   */
  it('never enlarges, whatever the URL asked for', async () => {
    const images = fakeBinding();
    await resizeImage(images, BYTES, 'image/jpeg', { width: 1920 });

    expect(images.calls.transform).toEqual([{ width: 1920, fit: 'scale-down' }]);
  });

  /**
   * The crop is resolved from the stored hotspot and crop with the same `resolveCrop` the admin
   * preview uses, then applied as a pixel `trim` *before* the resize — two chained calls because
   * the order is the point. A 1600×454 source in a 4:3 well keeps a 605px-wide slice.
   */
  it('crops to the resolved rectangle before scaling', async () => {
    const images = fakeBinding();
    await resizeImage(images, BYTES, 'image/jpeg', { width: 640, ratio: 1.33 }, {
      width: 1600,
      height: 454,
      hotspot_x: 0.5,
      hotspot_y: 0.5,
    });

    expect(images.calls.transform).toHaveLength(2);
    const [trim, resize] = images.calls.transform as [
      { trim: { left: number; top: number; width: number; height: number } },
      { width: number },
    ];
    expect(trim.trim.height).toBe(454);
    expect(trim.trim.width).toBe(Math.round(454 * 1.33));
    // Centred, because the hotspot is centred.
    expect(trim.trim.left).toBe(Math.round((1600 - Math.round(454 * 1.33)) / 2));
    expect(resize).toEqual({ width: 640, fit: 'scale-down' });
  });

  it('skips the crop when the source dimensions were never read', async () => {
    // A normalised rectangle cannot become pixels without them, and guessing would crop visibly
    // wrongly rather than not at all.
    const images = fakeBinding();
    await resizeImage(images, BYTES, 'image/jpeg', { width: 640, ratio: 1.33 }, {
      width: null,
      height: null,
    });

    expect(images.calls.transform).toEqual([{ width: 640, fit: 'scale-down' }]);
  });

  it('serves the original when nothing was asked for', async () => {
    const images = fakeBinding();
    expect(await resizeImage(images, BYTES, 'image/png', {})).toBeUndefined();
    expect(images.calls.transform).toEqual([]);
  });

  it('serves the original when there is no binding at all', async () => {
    // A Node deployment, or a Worker whose operator never added the binding. Both are supported
    // states: the page gets heavier, never broken.
    expect(await resizeImage(undefined, BYTES, 'image/png', { width: 640 })).toBeUndefined();
  });

  /**
   * The failure that matters most. An allowance reached, an unsupported source, a transient error —
   * every one of them has to produce the stored image rather than a 500, because an image is the
   * part of a page a visitor most visibly loses.
   */
  it('falls back to the original when the transform throws, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const images: ImagesBindingLike = {
      input: () => {
        throw new Error('transformations exceeded');
      },
    };

    expect(await resizeImage(images, BYTES, 'image/png', { width: 640 })).toBeUndefined();
    expect(error).toHaveBeenCalled();

    error.mockRestore();
  });

  it('falls back when the output promise rejects, not only when input throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const transformer = {
      transform: () => transformer,
      output: () => Promise.reject(new Error('nope')),
    };

    expect(
      await resizeImage({ input: () => transformer }, BYTES, 'image/png', { width: 640 }),
    ).toBeUndefined();
    expect(error).toHaveBeenCalled();

    error.mockRestore();
  });
});

describe('isResizable', () => {
  it('accepts the raster formats a resizer improves', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/avif']) {
      expect(isResizable(mime)).toBe(true);
    }
  });

  /**
   * SVG is resolution-independent, so rasterising it to a fixed width throws that away — and it is
   * the one type here whose bytes are also a script vector, so leaving it on the untouched path
   * keeps it under exactly the headers the route already sets. A GIF resize would flatten an
   * animation to its first frame, which is a content change rather than an optimisation.
   */
  it('leaves SVG, GIF and non-images alone', () => {
    for (const mime of ['image/svg+xml', 'image/gif', 'application/pdf', 'video/mp4']) {
      expect(isResizable(mime)).toBe(false);
    }
  });
});
