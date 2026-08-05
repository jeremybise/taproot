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

/**
 * Deduplication, which is about concurrency and deliberately not about caching.
 *
 * A layout and a component both asking for the main menu is the ordinary case, and two round trips
 * for one answer is the cost. The line this holds is the second test: once a request has settled the
 * next one goes to the network, because keeping the body would mean re-implementing expiry and
 * revalidation in front of a cache that already does both — and would have no bound at all on the
 * one staleness the ETag cannot detect.
 */
describe('request deduplication', () => {
  function countingClient() {
    let calls = 0;
    const client = createTaprootClient({
      url: 'https://cms.example.edu',
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ items: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    return { client, calls: () => calls };
  }

  it('makes one request when the same resource is asked for concurrently', async () => {
    const { client, calls } = countingClient();

    await Promise.all([client.menu('main'), client.menu('main'), client.menu('main')]);

    expect(calls()).toBe(1);
  });

  it('does not deduplicate different resources', async () => {
    const { client, calls } = countingClient();

    await Promise.all([client.menu('main'), client.menu('footer')]);

    expect(calls()).toBe(2);
  });

  it('goes back to the network once a request has settled, because this is not a cache', async () => {
    const { client, calls } = countingClient();

    await client.menu('main');
    await client.menu('main');

    expect(calls()).toBe(2);
  });
});
