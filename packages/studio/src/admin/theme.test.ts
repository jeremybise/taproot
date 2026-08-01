import { describe, expect, it } from 'vitest';

import { resolveTheme, themeAttribute, THEME_CHOICES } from './theme.js';

/**
 * The rule these protect is the one that is invisible when broken: "System" and "never chose
 * anything" have to resolve to the same markup. If `system` ever started rendering an attribute,
 * every screen would still look right in testing — the CSS would simply stop following the OS,
 * and only a user who changes their OS theme at dusk would ever notice.
 */

describe('theme resolution', () => {
  it('reads the two explicit choices', () => {
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('falls back to system for anything it does not recognise', () => {
    // A missing cookie, a value from an older release, and something hand-edited in devtools all
    // have to land on the pre-switcher behaviour rather than on a broken screen.
    expect(resolveTheme(undefined)).toBe('system');
    expect(resolveTheme('')).toBe('system');
    expect(resolveTheme('system')).toBe('system');
    expect(resolveTheme('DARK')).toBe('system');
    expect(resolveTheme('midnight')).toBe('system');
  });

  it('renders no data-theme attribute for system', () => {
    expect(themeAttribute('system')).toBeUndefined();
    expect(themeAttribute('light')).toBe('light');
    expect(themeAttribute('dark')).toBe('dark');
  });

  it('offers exactly the choices the resolver understands', () => {
    // Adding a choice to the switcher without teaching `resolveTheme` about it would render a
    // button that silently resolves back to system every time it is pressed.
    for (const choice of THEME_CHOICES) {
      expect(resolveTheme(choice.value)).toBe(choice.value);
    }
  });
});
