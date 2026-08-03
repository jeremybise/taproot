import { describe, expect, it } from 'vitest';

import { createTaprootClient } from './index.js';

/**
 * The client is constructed at module scope in every site that follows the handbook, so a bad
 * configuration surfaces here rather than in a route — before a request exists to attach the failure
 * to. What it says at that moment is the whole of what the person deploying gets.
 */
describe('createTaprootClient', () => {
  /**
   * The deployed-Worker case, which is what this guard exists for.
   *
   * `url` is typed `string`, so this cast is the point rather than a convenience: the value is
   * undefined at runtime while the type says otherwise, because it came from an environment variable
   * that nothing filled in. Reproducing it needs the same lie the runtime tells.
   */
  it('refuses an undefined url instead of throwing from `.replace`', () => {
    expect(() => createTaprootClient({ url: undefined as unknown as string })).toThrow(
      /createTaprootClient was given no `url`/,
    );
  });

  // An empty environment variable is the same failure as an absent one, and would otherwise build a
  // client whose every request went to a relative path on the site's own origin.
  it('refuses an empty url', () => {
    expect(() => createTaprootClient({ url: '' })).toThrow(/no `url`/);
  });

  /**
   * The guard is deliberately narrower than "the options look wrong".
   *
   * A key is optional against a local studio, where a signed-in session reaches the delivery API —
   * which is what lets a developer open a delivery URL in a browser to see what their site receives.
   * Guarding it here would break that with a message about a credential nobody needs yet.
   */
  it('accepts a url with no api key', () => {
    expect(() => createTaprootClient({ url: 'http://localhost:4321' })).not.toThrow();
  });

  it('trims a trailing slash so a path is not appended to a doubled one', async () => {
    let seen = '';
    const client = createTaprootClient({
      url: 'https://cms.example.edu/',
      fetch: async (input) => {
        seen = String(input);
        return new Response(JSON.stringify({ kind: 'not_found' }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await client.resolve('/about');

    expect(seen).toContain('https://cms.example.edu/api/taproot/delivery/resolve?');
    expect(seen).not.toContain('//api/taproot');
  });
});
