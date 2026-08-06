import { describe, expect, it } from 'vitest';

import { PURGE_PATH, PURGE_SECRET_HEADER } from '../pure.js';

/**
 * The shared vocabulary both sides of the purge loop spell.
 *
 * These are constants, so there is not much behaviour to assert — but the one property that matters
 * cannot be seen by reading either side, and shipped broken for a release.
 */
describe('the purge route convention', () => {
  /**
   * **Astro does not route anything under a path segment starting with `_`.**
   *
   * `PURGE_PATH` was `/_taproot/purge` in 0.1.28, which meant the endpoint a site mounted at the
   * documented location silently did not exist: `src/pages/_taproot/purge.ts` is excluded from
   * routing by convention, so the file type-checked, the build succeeded with no warning, and every
   * purge the CMS sent would have 404'd — queued as a failure, retried to the ceiling, and reported
   * on Settings → System as a problem with no visible cause. It was found by grepping the built
   * bundle for the handler and not finding it, which is not a thing anyone does twice.
   *
   * Checked per segment rather than on the whole string, because `/taproot/_purge` fails exactly the
   * same way and reads as fine.
   */
  it('has no path segment Astro would exclude from routing', () => {
    const segments = PURGE_PATH.split('/').filter(Boolean);

    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(segment.startsWith('_')).toBe(false);
    }
  });

  it('is an absolute path, since it is joined against a site origin', () => {
    expect(PURGE_PATH.startsWith('/')).toBe(true);
  });

  /**
   * Lowercase because `Headers` lookups are case-insensitive but *string* comparisons in a consumer's
   * own middleware are not, and this constant is the thing a site would compare against by hand.
   */
  it('names the secret header in lowercase', () => {
    expect(PURGE_SECRET_HEADER).toBe(PURGE_SECRET_HEADER.toLowerCase());
  });
});
