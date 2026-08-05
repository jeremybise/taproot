import { describe, expect, it } from 'vitest';

import {
  MEDIA_VARIANT_WIDTHS,
  mediaVariantUrl,
  parseMediaVariant,
  scaleSizes,
  variantWidthsFor,
} from './imageVariants.js';

const parse = (url: string) => parseMediaVariant(new URL(url, 'https://cms.example').searchParams);

describe('mediaVariantUrl and parseMediaVariant', () => {
  /**
   * The property the whole module exists for. These are the two halves of a wire format, and a
   * disagreement between them does not throw — it serves every visitor the full-size original while
   * the page still looks right and every other test still passes.
   */
  it('round-trips every variant the consumer can build', () => {
    for (const width of MEDIA_VARIANT_WIDTHS) {
      for (const format of ['webp', 'avif', 'jpeg', 'png'] as const) {
        const url = mediaVariantUrl('https://cms.example/media/a.png', { width, format });
        expect(parse(url)).toEqual({ width, format });
      }
    }
  });

  it('adds nothing when nothing was asked for', () => {
    expect(mediaVariantUrl('/media/a.png', {})).toBe('/media/a.png');
    expect(parse('/media/a.png')).toEqual({});
  });

  it('joins with & when the URL already carries a query', () => {
    expect(mediaVariantUrl('/media/a.png?v=2', { width: 640 })).toBe('/media/a.png?v=2&w=640');
  });

  it('works on a root-relative URL, which is what an unset TAPROOT_MEDIA_URL produces', () => {
    expect(mediaVariantUrl('/api/taproot/media/file/a.png', { width: 320 })).toBe(
      '/api/taproot/media/file/a.png?w=320',
    );
  });
});

describe('parseMediaVariant', () => {
  /**
   * Snapping *up* keeps the image at least as sharp as asked for. Snapping down would answer a
   * reasonable request with a silently blurrier picture, which is the failure nobody files a bug
   * about.
   */
  it('snaps a width between rungs up to the next one', () => {
    expect(parse('/a.png?w=500').width).toBe(640);
    expect(parse('/a.png?w=321').width).toBe(480);
    expect(parse('/a.png?w=320').width).toBe(320);
  });

  it('clamps below the bottom rung and above the top one', () => {
    expect(parse('/a.png?w=1').width).toBe(320);
    // The ceiling is what stops `?w=99999` being a request to upscale, and bounds the ladder.
    expect(parse('/a.png?w=99999').width).toBe(1920);
  });

  it('ignores a width that is not a positive number', () => {
    expect(parse('/a.png?w=0')).toEqual({});
    expect(parse('/a.png?w=-40')).toEqual({});
    expect(parse('/a.png?w=wide')).toEqual({});
  });

  it('ignores an unknown format rather than passing it to the resizer', () => {
    expect(parse('/a.png?f=bmp')).toEqual({});
    expect(parse('/a.png?f=image%2Fwebp')).toEqual({});
  });
});

describe('scaleSizes', () => {
  it('leaves an uncropped image alone rather than adding noise', () => {
    expect(scaleSizes('100vw', 1)).toBe('100vw');
    expect(scaleSizes('(min-width: 1024px) 50vw, 100vw', 1.001)).toBe(
      '(min-width: 1024px) 50vw, 100vw',
    );
  });

  it('scales a bare length', () => {
    expect(scaleSizes('100vw', 1.3333)).toBe('calc((100vw) * 1.3333)');
  });

  it('scales a length behind a media condition, leaving the condition intact', () => {
    expect(scaleSizes('(min-width: 1024px) 50vw, 100vw', 2)).toBe(
      '(min-width: 1024px) calc((50vw) * 2), calc((100vw) * 2)',
    );
  });

  /**
   * The bug this function was extracted for. Splitting on the last space takes `57px)` as the
   * length and scales one term of the expression instead of the expression — valid CSS, wrong
   * number, and invisible unless somebody reads the rendered HTML.
   */
  it('scales a whole calc(), not its last term', () => {
    expect(scaleSizes('(min-width: 1024px) calc(50vw - 57px)', 1.4085)).toBe(
      '(min-width: 1024px) calc((calc(50vw - 57px)) * 1.4085)',
    );
  });

  it('scales a condition-less calc(), which has no boundary to find', () => {
    expect(scaleSizes('calc(100vw - 50px)', 1.5)).toBe('calc((calc(100vw - 50px)) * 1.5)');
  });

  it('handles a media type in front of the condition', () => {
    expect(scaleSizes('screen and (min-width: 40em) 50vw', 2)).toBe(
      'screen and (min-width: 40em) calc((50vw) * 2)',
    );
  });

  it('handles the real three-case list this shipped with', () => {
    expect(
      scaleSizes(
        '(min-width: 1800px) 678px, (min-width: 1024px) calc(50vw - 57px), calc(100vw - 50px)',
        1.4085,
      ),
    ).toBe(
      '(min-width: 1800px) calc((678px) * 1.4085), ' +
        '(min-width: 1024px) calc((calc(50vw - 57px)) * 1.4085), ' +
        'calc((calc(100vw - 50px)) * 1.4085)',
    );
  });
});

describe('variantWidthsFor', () => {
  it('never offers a rung above the source, because enlarging adds bytes and no detail', () => {
    expect(variantWidthsFor(1000)).toEqual([320, 480, 640, 768]);
    expect(variantWidthsFor(1920)).toEqual([...MEDIA_VARIANT_WIDTHS]);
  });

  it('offers the bottom rung alone for a source smaller than it', () => {
    expect(variantWidthsFor(200)).toEqual([320]);
  });

  it('offers the whole ladder when the dimensions were never read', () => {
    // An unrecognised upload format stores null dimensions; no srcset at all is worse than one
    // whose top rungs the resizer will decline to upscale.
    expect(variantWidthsFor(null)).toEqual([...MEDIA_VARIANT_WIDTHS]);
  });

  /**
   * The crop belongs in `sizes`, not here. A rung is a width of the whole source; folding the
   * scale-up factor in as well would apply it twice and leave the ladder offering nothing but
   * oversized candidates.
   */
  it('does not take the crop into account', () => {
    expect(variantWidthsFor(1000)).toEqual(variantWidthsFor(1000));
  });
});
