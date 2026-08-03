import { deriveAccent, formatOklch, hexToOklch, listMedia, loadBranding } from '@taprootcms/core';
import type { Database, ResolvedBranding, ThemeMode } from '@taprootcms/core';
import type { Kysely } from 'kysely';

import { toMediaOption, type MediaOption } from './mediaOptions.js';

/**
 * Branding as the layouts need it: the resolved settings, the logo, and the CSS to stamp.
 *
 * One module for all three because five screens read it — the admin shell and the four
 * unauthenticated pages — and a copy of "how do I turn a hex into the accent tokens" on each of
 * them is five chances for the sign-in screen to be a different green from the admin behind it.
 * Same reason `theme.ts` exists for the light/dark choice.
 */

export interface AdminBranding extends ResolvedBranding {
  logo: MediaOption | null;
  /** The `<style>` body to stamp in `<head>`, or null when nothing has been themed. */
  accentCss: string | null;
}

export async function adminBranding(
  db: Kysely<Database>,
  storage: { publicUrl(key: string): string },
): Promise<AdminBranding> {
  const branding = await loadBranding(db);
  return {
    ...branding,
    logo: await brandingLogo(db, storage, branding.logoMediaId),
    accentCss: accentCss(branding),
  };
}

async function brandingLogo(
  db: Kysely<Database>,
  storage: { publicUrl(key: string): string },
  id: string | null,
): Promise<MediaOption | null> {
  if (!id) return null;
  // The logo is one row by id, not the library's first page — an asset uploaded long ago is still
  // the logo, and `mediaOptions` would not have it.
  const { media } = await listMedia(db, { ids: [id], limit: 1 });
  return media[0] ? toMediaOption(media[0], storage) : null;
}

/**
 * The accent override, as one unlayered `:root` rule.
 *
 * **Unlayered on purpose, and this has bitten before.** Tailwind's `@theme` block compiles into
 * `@layer theme`, and cascade layers beat specificity outright — a rule that lands in any layer
 * loses to a utility, and a rule in the same layer would depend on source order that Astro decides.
 * Unlayered styles outrank every layer, which is the same lesson the preview-width rule in
 * `admin.css` records. Verify by reading the computed value, never by finding the element.
 *
 * `light-dark()` rather than two blocks under `data-theme`, because that is how every token in
 * `admin.css` is written: `color-scheme` alone selects the palette, and the theme switcher has
 * nothing to switch if a palette is pinned by a selector instead.
 *
 * Null when nothing has been themed, so an untouched admin renders exactly the stylesheet as
 * written — no generated properties to read past, and no round-trip between a hex and the
 * `oklch()` it was converted from.
 */
export function accentCss(branding: ResolvedBranding): string | null {
  if (branding.usesDefaultAccent) return null;

  const light = accentTokens(branding.resolvedAccent.light, 'light');
  const dark = accentTokens(branding.resolvedAccent.dark, 'dark');
  if (!light || !dark) return null;

  const pair = (name: keyof typeof light) =>
    `  --color-${name}: light-dark(${light[name]}, ${dark[name]});`;

  return [
    ':root {',
    pair('accent'),
    pair('accent-hover'),
    pair('accent-content'),
    pair('accent-subtle'),
    '}',
  ].join('\n');
}

/**
 * One chosen colour becomes four.
 *
 * Only `accent` is the operator's; the other three are derived, because each of them is a question
 * with a right answer — a button label has to be readable on the button, and asking somebody to
 * choose it is offering them a way to get it wrong. `deriveAccent` is in core beside the contrast
 * maths so the settings screen's warnings describe the colours this emits.
 */
function accentTokens(hex: string, mode: ThemeMode): Record<string, string> | null {
  const parsed = hexToOklch(hex);
  if (!parsed) return null;

  const tokens = deriveAccent(parsed, mode);
  return {
    accent: formatOklch(tokens.accent),
    'accent-hover': formatOklch(tokens.hover),
    'accent-content': formatOklch(tokens.content),
    'accent-subtle': formatOklch(tokens.subtle),
  };
}
