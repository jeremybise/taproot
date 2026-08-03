import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createUser } from '../auth/users.js';
import type { User } from '../db/schema.js';
import {
  BrandingError,
  DEFAULT_ACCENT,
  DEFAULT_TITLE,
  getBranding,
  resolveBranding,
  updateBranding,
} from './branding.js';
import { accentContrast, deriveAccent, formatOklch, hexToOklch, oklchToHex } from './color.js';

/**
 * The configurable accent, and the rule that makes it safe to configure.
 *
 * The feature's whole claim is that an operator chooses one colour and the readable parts are
 * worked out rather than asked for. That claim is only worth anything if it holds for colours
 * nobody tried by hand, which is what the hue sweep below is: a derivation that quietly stopped
 * choosing the right button label would otherwise ship, because the default green would still look
 * fine on the one screen anybody checked.
 */

let handle: TaprootDb;
let admin: User;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
  admin = await createUser(handle.db, { email: 'admin@campus.edu', name: 'Admin', role: 'admin' });
});

afterEach(async () => {
  await handle.destroy();
});

describe('the defaults are the stylesheet', () => {
  /**
   * The accent in `admin.css` is `oklch(52% 0.15 155)` and `oklch(70% 0.15 155)` — and **neither is
   * inside sRGB**, which is why `DEFAULT_ACCENT` cannot be the same colour exactly. A hex is an
   * sRGB triple; converting an out-of-gamut oklch to one clips it, and clipping is not reversible.
   * On an ordinary display the browser has already clipped the CSS to the same place, so what the
   * picker shows and what the admin renders look identical; on a wide-gamut display the CSS is very
   * slightly more saturated.
   *
   * None of that reaches the stylesheet, because choosing the default is stored as *nothing* and no
   * override is emitted. What has to hold is only this: the hex is the same colour to the eye, and
   * it derives the same shape of token set.
   */
  it('is the nearest sRGB colour to the accent in admin.css', () => {
    const light = hexToOklch(DEFAULT_ACCENT.light)!;
    const dark = hexToOklch(DEFAULT_ACCENT.dark)!;

    // Tolerances rather than equality, and stated rather than derived from a digit count: the gap
    // is the gamut clip, and it is under a lightness point, four degrees of hue, and 0.02 chroma.
    for (const [hex, css] of [
      [light, { l: 52, c: 0.15, h: 155 }],
      [dark, { l: 70, c: 0.15, h: 155 }],
    ] as const) {
      expect(Math.abs(hex.l - css.l)).toBeLessThan(1);
      expect(Math.abs(hex.h - css.h)).toBeLessThan(4);
      expect(Math.abs(hex.c - css.c)).toBeLessThan(0.02);
    }
  });

  it('derives the same token set the stylesheet writes by hand', () => {
    // Structure, not digits: white on the light accent, the near-black on the dark one, hover six
    // points away from the label, and the tint pinned. Those are the four decisions `admin.css`
    // made by hand, and an operator who picks the built-in colour has to get all four back.
    const lightAccent = hexToOklch(DEFAULT_ACCENT.light)!;
    const light = deriveAccent(lightAccent, 'light');
    expect(formatOklch(light.content)).toBe('oklch(99% 0 0)');
    expect(light.hover.l).toBeCloseTo(lightAccent.l - 6, 5);
    expect(light.subtle.l).toBe(95);
    expect(light.subtle.c).toBe(0.04);

    const darkAccent = hexToOklch(DEFAULT_ACCENT.dark)!;
    const dark = deriveAccent(darkAccent, 'dark');
    expect(dark.content.l).toBe(18);
    expect(dark.content.c).toBe(0.02);
    expect(dark.hover.l).toBeCloseTo(darkAccent.l + 6, 5);
    expect(dark.subtle.l).toBe(28);
    expect(dark.subtle.c).toBe(0.05);
  });
});

describe('hex and oklch round-trip', () => {
  it('comes back to the colour it started as', () => {
    for (const hex of ['#000000', '#ffffff', '#2f9e68', '#7c3aed', '#b91c1c', '#0ea5e9']) {
      expect(oklchToHex(hexToOklch(hex)!)).toBe(hex);
    }
  });

  it('expands three-digit shorthand', () => {
    expect(oklchToHex(hexToOklch('#fff')!)).toBe('#ffffff');
    expect(hexToOklch('#f0a')).toEqual(hexToOklch('#ff00aa'));
  });

  it('refuses anything that is not a hex colour', () => {
    // The value is interpolated into a `<style>` element, so "unparseable" has to mean "rejected"
    // rather than "passed through".
    for (const value of ['red', 'rgb(1,2,3)', '#12345', 'oklch(50% 0.1 20)', '', '#ff00aa;}']) {
      expect(hexToOklch(value)).toBeNull();
    }
  });

  it('gives a grey no hue', () => {
    // `atan2(0, 0)` is 0, which is red — a grey accent would tint every derived token the moment
    // its chroma stopped being exactly zero.
    expect(hexToOklch('#808080')!.h).toBe(0);
    expect(hexToOklch('#808080')!.c).toBeLessThan(0.001);
  });
});

describe('the derived tokens are readable for any colour', () => {
  /**
   * Every hue at three lightnesses, in both palettes. What is being proven is narrow and important:
   * the pairs marked `derived` are the ones an operator cannot influence, so they must pass for
   * every input. The two that are not derived — the accent as text, and as an outline — depend on
   * the colour chosen and are reported to the operator instead.
   */
  it('passes every derived pair across the hue circle', () => {
    const failures: string[] = [];

    for (const mode of ['light', 'dark'] as const) {
      for (let hue = 0; hue < 360; hue += 15) {
        for (const lightness of [35, 55, 75]) {
          for (const chroma of [0.02, 0.12, 0.25]) {
            const accent = { l: lightness, c: chroma, h: hue };
            for (const check of accentContrast(accent, mode)) {
              if (check.derived && !check.passes) {
                failures.push(
                  `${mode} ${formatOklch(accent)} — ${check.label} at ${check.ratio.toFixed(2)}:1`,
                );
              }
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('reports the accent as text failing when the colour is too pale for it', () => {
    // The honest half. A pale yellow cannot be link text on white, and no derivation can make it
    // so without handing back a colour nobody chose.
    const paleYellow = hexToOklch('#f5e663')!;
    const asText = accentContrast(paleYellow, 'light').find(
      (check) => check.label === 'Accent as text',
    )!;

    expect(asText.passes).toBe(false);
    expect(asText.derived).toBe(false);
  });
});

describe('storing it', () => {
  it('starts with nothing set, and resolves to the built-in identity', async () => {
    const stored = await getBranding(handle.db);
    expect(stored).toEqual({
      title: null,
      logoMediaId: null,
      accentLight: null,
      accentDark: null,
    });

    const resolved = resolveBranding(stored);
    expect(resolved.resolvedTitle).toBe(DEFAULT_TITLE);
    expect(resolved.usesDefaultAccent).toBe(true);
  });

  it('writes and reads back one row, however many times it is saved', async () => {
    await updateBranding(handle.db, { title: 'Campus CMS' }, admin.id);
    await updateBranding(handle.db, { title: 'Campus CMS', accentLight: '#7C3AED' }, admin.id);

    expect(await getBranding(handle.db)).toEqual({
      title: 'Campus CMS',
      logoMediaId: null,
      // Normalised on the way in, so `usesDefaultAccent` can be a string comparison.
      accentLight: '#7c3aed',
      accentDark: null,
    });

    const rows = await handle.db.selectFrom('settings').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('treats a blank title as "use the default" rather than as an empty name', async () => {
    await updateBranding(handle.db, { title: 'Campus CMS' }, admin.id);
    await updateBranding(handle.db, { title: '   ' }, admin.id);

    const stored = await getBranding(handle.db);
    expect(stored.title).toBeNull();
    expect(resolveBranding(stored).resolvedTitle).toBe(DEFAULT_TITLE);
  });

  it('expands shorthand so one colour has one spelling', async () => {
    await updateBranding(handle.db, { accentDark: '#F0A' }, admin.id);
    expect((await getBranding(handle.db)).accentDark).toBe('#ff00aa');
  });

  it('refuses a colour it cannot parse', async () => {
    await expect(updateBranding(handle.db, { accentLight: 'darkgreen' }, admin.id)).rejects.toThrow(
      BrandingError,
    );
  });

  it('refuses a title longer than the field allows', async () => {
    await expect(updateBranding(handle.db, { title: 'x'.repeat(61) }, admin.id)).rejects.toThrow(
      BrandingError,
    );
  });

  it('falls back to the default for a stored value that is not a colour', () => {
    /**
     * The second half of validating on write. A row edited in a database console, or written before
     * a rule existed, must not reach the stylesheet — the resolved value is interpolated into a
     * `<style>` element.
     */
    const resolved = resolveBranding({
      title: null,
      logoMediaId: null,
      accentLight: 'red; } body { display: none',
      accentDark: null,
    });

    expect(resolved.resolvedAccent.light).toBe(DEFAULT_ACCENT.light);
    expect(resolved.usesDefaultAccent).toBe(true);
  });

  it('keeps the settings row when the logo is deleted', async () => {
    /**
     * `on delete set null`, not cascade. Deleting the image used as the logo has to put the ◆ back,
     * not take the title and both accents with it.
     */
    const now = new Date().toISOString();
    await handle.db
      .insertInto('media')
      .values({
        id: 'media-1',
        filename: 'logo.svg',
        storage_key: 'logo.svg',
        mime_type: 'image/svg+xml',
        size_bytes: 100,
        alt_text: '',
        title: null,
        width: null,
        height: null,
        hotspot_x: null,
        hotspot_y: null,
        crop_top: null,
        crop_right: null,
        crop_bottom: null,
        crop_left: null,
        uploaded_by: admin.id,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await updateBranding(handle.db, { title: 'Campus CMS', logoMediaId: 'media-1' }, admin.id);
    await handle.db.deleteFrom('media').where('id', '=', 'media-1').execute();

    expect(await getBranding(handle.db)).toEqual({
      title: 'Campus CMS',
      logoMediaId: null,
      accentLight: null,
      accentDark: null,
    });
  });
});
