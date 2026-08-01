/**
 * The admin's colour theme.
 *
 * One module for the cookie name, the three choices, and how a stored value maps to markup — the
 * same reason `status.ts` exists. The layout stamps the attribute, the switcher renders the
 * buttons, and the API route writes the cookie; three places that have to agree on one vocabulary.
 */

/**
 * Deliberately not `httpOnly`. This is a display preference rather than a credential, and leaving
 * it readable is what would let a future no-reload switch update the same value the server reads,
 * instead of introducing a second source of truth that can disagree with this one.
 */
export const THEME_COOKIE_NAME = 'taproot_theme';

export type ThemeChoice = 'light' | 'dark' | 'system';

/** Render order for the switcher: the two explicit choices, then deferring to the OS. */
export const THEME_CHOICES: readonly { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/**
 * What a stored cookie value means.
 *
 * Anything unrecognised resolves to `system` — no cookie, a stale value, something hand-edited in
 * devtools. That is the behaviour the admin had before a switcher existed, so the failure mode of
 * a bad value is the old default rather than a broken screen.
 */
export function resolveTheme(cookieValue: string | undefined): ThemeChoice {
  return cookieValue === 'light' || cookieValue === 'dark' ? cookieValue : 'system';
}

/**
 * The `data-theme` value for `<html>`, or `undefined` to leave the attribute off entirely.
 *
 * `system` renders no attribute rather than `data-theme="system"`. The CSS reads "no attribute" as
 * "follow the OS", so a third value would need a rule that does nothing — and worse, it would make
 * the absent state and the chosen state two different states that can drift. A browser that has
 * never touched the switcher and one that explicitly chose System must render identically.
 */
export function themeAttribute(choice: ThemeChoice): 'light' | 'dark' | undefined {
  return choice === 'system' ? undefined : choice;
}
