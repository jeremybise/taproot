import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { hexToOklch, type ThemeMode } from './color.js';

/**
 * What the CMS calls itself, and what colour it is.
 *
 * One row, because there is one deployment and one site — the same decision recorded in SCOPE under
 * "no multi-site". A key/value table would carry a JSON blob nobody can constrain and a read that
 * cannot say which keys exist; named columns get the shape checked by the same schema everything
 * else here is checked by.
 *
 * Every value is nullable and every null means "the default", which is not the same as an empty
 * string. That distinction is what lets the settings screen show the built-in title greyed out as a
 * placeholder rather than as a value someone has to delete, and it is why clearing the field puts
 * "Taproot" back instead of leaving a nameless admin.
 */

/** The name in the sidebar and the browser tab when nobody has chosen one. */
export const DEFAULT_TITLE = 'Taproot';

/**
 * The accent as it is written in `admin.css`, in the form a colour input speaks.
 *
 * The stylesheet's own values are `oklch(52% 0.15 155)` and `oklch(70% 0.15 155)`, and **neither is
 * inside sRGB** — so these hexes are the nearest displayable colour rather than the same one. That
 * costs nothing where it matters: choosing the default is stored as null and emits no override, so
 * the CSS keeps its exact value; a browser on an ordinary display has already clipped it to the
 * same place these hexes name. What they buy is a picker that opens showing the green the admin
 * actually is, rather than an arbitrary one.
 */
export const DEFAULT_ACCENT: Record<ThemeMode, string> = {
  light: '#008140',
  dark: '#3bb974',
};

/**
 * A starting point per hue, each pair measured rather than chosen by eye.
 *
 * Presets exist because the honest answer to "will this colour work?" is a contrast table, and
 * reading one before you have anything to compare it against is not how anybody picks a colour.
 * These are somewhere to start from and then adjust.
 *
 * Every one of them **passes every check in both palettes**, with at least the margin the built-in
 * green has — `branding.test.ts` asserts it against the same `accentContrast` the settings screen
 * renders, so a change to the derivation cannot quietly leave a preset failing. They were found by
 * searching lightness and chroma per hue rather than picked, and validated on the *hex*: a colour
 * that passes in OKLCh and clips out of sRGB on the way to a hex has not passed.
 *
 * A pair, not a hue, because light and dark need genuinely different lightnesses — the same reason
 * the accent is two settings rather than one.
 */
export interface AccentPreset {
  name: string;
  light: string;
  dark: string;
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  // First, and exactly `DEFAULT_ACCENT`, so choosing it is the same as choosing nothing.
  { name: 'Green', light: DEFAULT_ACCENT.light, dark: DEFAULT_ACCENT.dark },
  { name: 'Teal', light: '#007a80', dark: '#00babe' },
  { name: 'Blue', light: '#006ed5', dark: '#009fff' },
  { name: 'Indigo', light: '#5e56de', dark: '#8483ff' },
  { name: 'Violet', light: '#8b44c9', dark: '#b671f9' },
  { name: 'Pink', light: '#bc267f', dark: '#ed58a9' },
  { name: 'Red', light: '#c9222b', dark: '#fc5855' },
  { name: 'Amber', light: '#b34e00', dark: '#e37a00' },
];

/** The single row, as stored. Null everywhere means nothing has ever been configured. */
export interface BrandingSettings {
  title: string | null;
  logoMediaId: string | null;
  accentLight: string | null;
  accentDark: string | null;
}

export interface ResolvedBranding extends BrandingSettings {
  /** Never empty — the default stands in. */
  resolvedTitle: string;
  resolvedAccent: Record<ThemeMode, string>;
  /**
   * True while both accents are the stylesheet's own.
   *
   * The layout emits no override at all in that case, so an admin nobody has themed renders exactly
   * the CSS as written — no generated custom properties to read past in devtools, and no rounding
   * between a hex and the `oklch()` it came from.
   */
  usesDefaultAccent: boolean;
}

/** The row id. There is only ever one; the check constraint in the migration says so too. */
const ROW_ID = 'site';

export async function getBranding(db: Kysely<Database>): Promise<BrandingSettings> {
  const row = await db
    .selectFrom('settings')
    .select(['title', 'logo_media_id', 'accent_light', 'accent_dark'])
    .where('id', '=', ROW_ID)
    .executeTakeFirst();

  return {
    title: row?.title ?? null,
    logoMediaId: row?.logo_media_id ?? null,
    accentLight: row?.accent_light ?? null,
    accentDark: row?.accent_dark ?? null,
  };
}

/**
 * Fill in the defaults, and drop anything unusable.
 *
 * A stored accent that is not a hex colour resolves to the default rather than reaching the
 * stylesheet: the value goes into a `<style>` element, so "whatever is in the column" is not a
 * thing to interpolate. `updateBranding` validates on the way in as well — this is the second half
 * of that, for a row written before a rule existed or edited in a database console.
 */
export function resolveBranding(settings: BrandingSettings): ResolvedBranding {
  const accent = {
    light: usableHex(settings.accentLight) ?? DEFAULT_ACCENT.light,
    dark: usableHex(settings.accentDark) ?? DEFAULT_ACCENT.dark,
  };

  return {
    ...settings,
    resolvedTitle: settings.title?.trim() || DEFAULT_TITLE,
    resolvedAccent: accent,
    usesDefaultAccent:
      accent.light === DEFAULT_ACCENT.light && accent.dark === DEFAULT_ACCENT.dark,
  };
}

export async function loadBranding(db: Kysely<Database>): Promise<ResolvedBranding> {
  return resolveBranding(await getBranding(db));
}

export class BrandingError extends Error {}

export interface BrandingInput {
  /** Empty or whitespace clears it back to the default. */
  title?: string | null;
  logoMediaId?: string | null;
  accentLight?: string | null;
  accentDark?: string | null;
}

export const MAX_TITLE_LENGTH = 60;

/**
 * Write the one row.
 *
 * An upsert rather than a read-then-branch: two requests arriving together would both find no row
 * and both insert, and the loser of that race is a primary-key violation on a screen that was doing
 * nothing unusual. `ON CONFLICT` behaves identically on both drivers.
 */
export async function updateBranding(
  db: Kysely<Database>,
  input: BrandingInput,
  actorId: string | null,
): Promise<BrandingSettings> {
  const title = normaliseTitle(input.title);
  const accentLight = normaliseAccent(input.accentLight, 'light');
  const accentDark = normaliseAccent(input.accentDark, 'dark');
  const logoMediaId = input.logoMediaId?.trim() || null;
  const now = new Date().toISOString();

  const values = {
    title,
    logo_media_id: logoMediaId,
    accent_light: accentLight,
    accent_dark: accentDark,
    updated_at: now,
    updated_by: actorId,
  };

  await db
    .insertInto('settings')
    .values({ id: ROW_ID, ...values })
    .onConflict((conflict) => conflict.column('id').doUpdateSet(values))
    .execute();

  return { title, logoMediaId, accentLight, accentDark };
}

function normaliseTitle(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new BrandingError(`The title cannot be longer than ${MAX_TITLE_LENGTH} characters.`);
  }
  return trimmed;
}

/**
 * Stored lowercase, six digits, with the hash.
 *
 * One spelling in the column is what makes `usesDefaultAccent` a string comparison rather than a
 * colour comparison — `#FFF` and `#ffffff` are the same colour and would otherwise both have to be
 * recognised as the default separately.
 */
function normaliseAccent(value: string | null | undefined, mode: ThemeMode): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const parsed = hexToOklch(trimmed);
  if (!parsed) {
    throw new BrandingError(
      `The ${mode} accent must be a hex color such as #2f9e68. Received: ${trimmed}`,
    );
  }

  const expanded =
    trimmed.replace('#', '').length === 3
      ? trimmed
          .replace('#', '')
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : trimmed.replace('#', '');

  return `#${expanded.toLowerCase()}`;
}

function usableHex(value: string | null): string | null {
  return value && hexToOklch(value) ? value.toLowerCase() : null;
}
