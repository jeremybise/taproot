import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HOTSPOT,
  NO_CROP,
  cropBackground,
  cropOf,
  cropRect,
  hotspotOf,
  cropFrame,
  resolveCrop,
} from './imageCrop.js';

/** A landscape source, so width and height are never interchangeable by accident. */
const landscape = { width: 1600, height: 900 };
/** A portrait source, which catches maths that only works one way round. */
const portrait = { width: 900, height: 1600 };

const round = (value: number, places = 4) => Number(value.toFixed(places));

describe('reading stored values', () => {
  it('defaults the hotspot to the centre', () => {
    // Every consumer needs a focal point; letting each decide would guarantee they disagreed.
    expect(hotspotOf({})).toEqual(DEFAULT_HOTSPOT);
  });

  it('clamps a hotspot outside the image', () => {
    expect(hotspotOf({ hotspot_x: 1.4, hotspot_y: -0.2 })).toEqual({ x: 1, y: 0 });
  });

  it('defaults to no crop', () => {
    expect(cropOf({})).toEqual(NO_CROP);
  });

  it('discards a crop that leaves nothing', () => {
    // Opposite insets summing to 1 give a zero-width region, and everything downstream divides by
    // it. Falling back to no crop keeps a bad stored value from becoming a broken page.
    expect(cropOf({ crop_left: 0.6, crop_right: 0.5 })).toEqual(NO_CROP);
    expect(cropOf({ crop_top: 0.5, crop_bottom: 0.5 })).toEqual(NO_CROP);
  });

  it('keeps a crop that leaves something', () => {
    expect(cropOf({ crop_left: 0.25, crop_right: 0.25 })).toEqual({
      top: 0,
      right: 0.25,
      bottom: 0,
      left: 0.25,
    });
  });

  it('turns a crop into a rectangle', () => {
    // Rounded rather than compared exactly: `1 - 0.4 - 0.2` is not 0.4 in binary floating point,
    // and nothing downstream cares about the sixteenth decimal place.
    const rect = cropRect({ top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 });

    expect(round(rect.x)).toBe(0.4);
    expect(round(rect.y)).toBe(0.1);
    expect(round(rect.width)).toBe(0.4);
    expect(round(rect.height)).toBe(0.6);
  });
});

describe('resolveCrop', () => {
  it('returns the whole image when it already matches the target', () => {
    const rect = resolveCrop(landscape, 16 / 9);

    expect(round(rect.x)).toBe(0);
    expect(round(rect.y)).toBe(0);
    expect(round(rect.width)).toBe(1);
    expect(round(rect.height)).toBe(1);
  });

  it('narrows a wide source to a square', () => {
    // 1600x900 as a square takes a 900px-wide slice: 900/1600 of the width, full height.
    const rect = resolveCrop(landscape, 1);

    expect(round(rect.width)).toBe(round(900 / 1600));
    expect(round(rect.height)).toBe(1);
  });

  it('shortens a tall source to a square', () => {
    const rect = resolveCrop(portrait, 1);

    expect(round(rect.width)).toBe(1);
    expect(round(rect.height)).toBe(round(900 / 1600));
  });

  it('centres the frame on the hotspot', () => {
    const rect = resolveCrop({ ...landscape, hotspot_x: 0.25, hotspot_y: 0.5 }, 1);

    // The frame is 0.5625 wide; centred on 0.25 it would start at -0.0206, so it clamps to 0.
    expect(round(rect.x)).toBe(0);

    const right = resolveCrop({ ...landscape, hotspot_x: 0.5 }, 1);
    expect(round(right.x)).toBe(round((1 - 900 / 1600) / 2));
  });

  it('clamps the frame inside the image rather than letting it overhang', () => {
    // "Keep this face in shot" means pull as far as possible and stop, not slide off the edge.
    const rect = resolveCrop({ ...landscape, hotspot_x: 1 }, 1);

    expect(round(rect.x + rect.width)).toBe(1);
    expect(rect.x).toBeGreaterThanOrEqual(0);
  });

  it('never reaches outside the crop', () => {
    // The crop is the editor saying "this is not part of the picture". No target shape may reach
    // back into it.
    const media = {
      ...landscape,
      crop_left: 0.25,
      crop_right: 0.25,
      hotspot_x: 0,
    };
    const rect = resolveCrop(media, 1);

    expect(rect.x).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(rect.x + rect.width).toBeLessThanOrEqual(0.75 + 1e-9);
  });

  it('fits the target inside the cropped region, not the original', () => {
    // Cropping to the middle half of a 1600x900 image leaves 800x900 — taller than wide, so a
    // square frame is limited by width now even though the source was landscape.
    const media = { ...landscape, crop_left: 0.25, crop_right: 0.25 };
    const rect = resolveCrop(media, 1);

    expect(round(rect.width)).toBe(0.5);
    expect(round(rect.height)).toBe(round((0.5 * 1600) / 900));
  });

  it('returns the crop unchanged when dimensions are unknown', () => {
    // Without pixel dimensions there is no way to know how a normalised rectangle maps to
    // proportions, so claiming to have fitted a shape would be a lie.
    const rect = resolveCrop({ crop_left: 0.1, crop_right: 0.1 }, 16 / 9);

    expect(round(rect.width)).toBe(0.8);
    expect(round(rect.height)).toBe(1);
  });

  it('always returns a rectangle inside the image', () => {
    const aspects = [16 / 9, 1, 3 / 4, 21 / 9, 0.5];
    const hotspots = [0, 0.15, 0.5, 0.85, 1];

    for (const source of [landscape, portrait]) {
      for (const ratio of aspects) {
        for (const hx of hotspots) {
          for (const hy of hotspots) {
            const rect = resolveCrop({ ...source, hotspot_x: hx, hotspot_y: hy }, ratio);

            expect(rect.x).toBeGreaterThanOrEqual(-1e-9);
            expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
            expect(rect.x + rect.width).toBeLessThanOrEqual(1 + 1e-9);
            expect(rect.y + rect.height).toBeLessThanOrEqual(1 + 1e-9);
            expect(rect.width).toBeGreaterThan(0);
            expect(rect.height).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('accepts overrides so the editor can preview before saving', () => {
    const rect = resolveCrop(landscape, 1, { x: 1, y: 0.5 }, NO_CROP);
    expect(round(rect.x + rect.width)).toBe(1);
  });
});

describe('cropBackground', () => {
  it('shows the whole image at natural scale when nothing is cropped', () => {
    expect(cropBackground({ x: 0, y: 0, width: 1, height: 1 })).toEqual({
      backgroundSize: '100.000% 100.000%',
      backgroundPosition: '50.000% 50.000%',
    });
  });

  it('scales by the inverse of the rectangle', () => {
    // Showing half the width means the background is twice as wide as the box.
    expect(cropBackground({ x: 0, y: 0, width: 0.5, height: 0.25 }).backgroundSize).toBe(
      '200.000% 400.000%',
    );
  });

  it('pins a left-edge rectangle to 0% and a right-edge one to 100%', () => {
    expect(cropBackground({ x: 0, y: 0, width: 0.5, height: 1 }).backgroundPosition).toBe(
      '0.000% 50.000%',
    );
    expect(cropBackground({ x: 0.5, y: 0, width: 0.5, height: 1 }).backgroundPosition).toBe(
      '100.000% 50.000%',
    );
  });

  it('positions by the fraction of the overflow, not of the image', () => {
    // The identity that makes background-position work: a rectangle starting a quarter of the way
    // across, occupying half the width, sits halfway through the remaining overflow.
    expect(cropBackground({ x: 0.25, y: 0, width: 0.5, height: 1 }).backgroundPosition).toBe(
      '50.000% 50.000%',
    );
  });

  it('round-trips a resolved crop into CSS without leaving the image', () => {
    for (const ratio of [16 / 9, 1, 3 / 4]) {
      for (const hx of [0, 0.5, 1]) {
        const rect = resolveCrop({ ...landscape, hotspot_x: hx }, ratio);
        const css = cropBackground(rect);

        for (const value of [css.backgroundPosition, css.backgroundSize]) {
          for (const part of value.split(' ')) {
            expect(Number.parseFloat(part)).not.toBeNaN();
          }
        }
        // A background can never need to be smaller than its box; that would letterbox.
        for (const part of css.backgroundSize.split(' ')) {
          expect(Number.parseFloat(part)).toBeGreaterThanOrEqual(100 - 1e-6);
        }
      }
    }
  });
});

describe('cropFrame', () => {
  it('leaves an uncropped image at natural size and origin', () => {
    expect(cropFrame({ x: 0, y: 0, width: 1, height: 1 })).toEqual({
      width: '100.000%',
      height: '100.000%',
      left: '0.000%',
      top: '0.000%',
    });
  });

  it('scales by the inverse of the rectangle and offsets in the scaled space', () => {
    // Showing the right-hand half means an image twice as wide, slid left by its own half-width —
    // which in the scaled element's own percentage terms is 100%, not 50%.
    expect(cropFrame({ x: 0.5, y: 0, width: 0.5, height: 1 })).toEqual({
      width: '200.000%',
      height: '100.000%',
      left: '-100.000%',
      top: '0.000%',
    });
  });

  it('never divides by a zero-sized rectangle', () => {
    // Cannot arise from `resolveCrop`, whose insets are refused past 0.9 — but this is exported,
    // and Infinity here would blank the image rather than fail loudly.
    expect(cropFrame({ x: 0, y: 0, width: 0, height: 0 })).toEqual({
      width: '100.000%',
      height: '100.000%',
      left: '0.000%',
      top: '0.000%',
    });
  });

  it('keeps the image undistorted for every orientation and target ratio', () => {
    /**
     * The property the whole component rests on.
     *
     * Scaling width and height by their own inverses only lands back on the image's natural
     * proportions because `resolveCrop` returns a rectangle whose *real-pixel* aspect is the
     * target. If that ever stopped holding, every cropped image on every site would stretch, and
     * it is the kind of wrong that looks like a CSS bug rather than a maths one.
     */
    const sources = [
      { width: 1600, height: 900 },
      { width: 900, height: 1600 },
      { width: 1200, height: 1200 },
    ];
    const ratios = [16 / 9, 1200 / 630, 1, 3 / 4, 16 / 5];

    for (const source of sources) {
      for (const ratio of ratios) {
        for (const hotspot of [0, 0.5, 1]) {
          const media = { ...source, hotspot_x: hotspot, hotspot_y: hotspot };
          const frame = cropFrame(resolveCrop(media, ratio));

          const pct = (value: string) => Number.parseFloat(value) / 100;
          // The rendered element's aspect, given a container of `ratio`.
          const rendered = (ratio * pct(frame.width)) / pct(frame.height);

          expect(rendered).toBeCloseTo(source.width / source.height, 3);
        }
      }
    }
  });
});
