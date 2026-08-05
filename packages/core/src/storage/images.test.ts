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
