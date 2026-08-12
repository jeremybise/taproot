import { describe, expect, it, vi } from 'vitest';

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
 * Search, whose whole job on this side is turning arguments into a query string.
 *
 * Worth pinning because the failure mode is silent in the direction that matters: a parameter the
 * server does not read is not an error, it is a search that quietly ignores what the site asked for
 * — the same class of mismatch `imageVariants` exists to prevent for `?w=`.
 */
describe('search', () => {
  function urlCapturingClient(payload: unknown = { results: [], total: 0, query: '' }) {
    let seen = '';
    const client = createTaprootClient({
      url: 'https://cms.example.edu',
      apiKey: 'tpr_test',
      fetch: async (input, init) => {
        seen = String(input);
        // The key travels as a bearer token on every delivery request, search included.
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tpr_test');
        return new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    return { client, seen: () => seen };
  }

  it('sends the term as `q`, and the options the endpoint reads', async () => {
    const { client, seen } = urlCapturingClient();

    await client.search('financial aid', { type: 'page', sort: 'newest', limit: 5, offset: 10 });

    const url = new URL(seen());
    expect(url.pathname).toBe('/api/taproot/delivery/search');
    expect(url.searchParams.get('q')).toBe('financial aid');
    expect(url.searchParams.get('type')).toBe('page');
    expect(url.searchParams.get('sort')).toBe('newest');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('offset')).toBe('10');
  });

  it('omits what was not asked for, so the server keeps its own defaults', async () => {
    const { client, seen } = urlCapturingClient();

    await client.search('aid');

    const url = new URL(seen());
    expect([...url.searchParams.keys()]).toEqual(['q']);
  });

  /**
   * A blank term is forwarded rather than short-circuited here. The server answers it with no
   * results, and having one implementation of that rule means a site cannot get a different answer
   * depending on which end it asked.
   */
  it('forwards a blank term instead of deciding for the server', async () => {
    const { client, seen } = urlCapturingClient();

    await client.search('   ');

    expect(new URL(seen()).searchParams.get('q')).toBe('   ');
  });
});

/**
 * `searchPage`, which is the boilerplate every search route would otherwise write for itself.
 *
 * It is tested harder than its size suggests because all of it is arithmetic over strings and
 * numbers taken straight from a URL — the category this repo has been caught by twice already
 * (`scaleSizes` splitting a `calc()` on its last space; a page/offset conversion is the same shape).
 * Written in a template it would be reachable by no suite anybody owns.
 */
describe('searchPage', () => {
  function pagingClient(total: number) {
    let seen = '';
    const client = createTaprootClient({
      url: 'https://cms.example.edu',
      fetch: async (input) => {
        seen = String(input);
        return new Response(JSON.stringify({ results: [], total, query: 'aid' }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    return { client, url: () => new URL(seen) };
  }

  it('turns a page number into an offset', async () => {
    const { client, url } = pagingClient(0);

    await client.searchPage(new URL('https://site.example/search?q=aid&page=3'), { perPage: 10 });

    expect(url().searchParams.get('limit')).toBe('10');
    expect(url().searchParams.get('offset')).toBe('20');
  });

  /**
   * The bug this caught, and the class of bug rather than the instance.
   *
   * `searchPage` used to forward `type` and `sort` by name. `under` was added to `SearchOptions`
   * later, `SearchPageOptions` inherits from it, so passing `under` type-checked perfectly and was
   * dropped on the floor — the search returned results, just unscoped, with nothing anywhere
   * reporting a problem. Asserted for every narrowing option at once, so the next one added to
   * `SearchOptions` is covered without anybody remembering to come back here.
   */
  it('forwards every narrowing option to the search, not just the ones it names', async () => {
    const { client, url } = pagingClient(0);

    await client.searchPage(new URL('https://site.example/search?q=aid'), {
      perPage: 10,
      type: 'page',
      sort: 'title',
      under: '/catalog/2026-27',
    });

    expect(url().searchParams.get('type')).toBe('page');
    expect(url().searchParams.get('sort')).toBe('title');
    expect(url().searchParams.get('under')).toBe('/catalog/2026-27');
  });

  it('does not leak its own paging vocabulary onto the request', async () => {
    // `perPage`, `queryParam` and `pageParam` are this function's own arguments — the delivery API
    // has never heard of them, and a spread that forwarded them would put three junk parameters on
    // every search URL.
    const { client, url } = pagingClient(0);

    await client.searchPage(new URL('https://site.example/search?q=aid'), {
      perPage: 10,
      queryParam: 'term',
      pageParam: 'p',
    });

    expect(url().searchParams.has('perPage')).toBe(false);
    expect(url().searchParams.has('queryParam')).toBe(false);
    expect(url().searchParams.has('pageParam')).toBe(false);
  });

  it('lands on page one for every way `?page=` can be nonsense', async () => {
    // `offset=NaN` is what the naive version puts on the wire, and the delivery API answers 400 —
    // a broken search page produced by a visitor editing their own URL.
    for (const raw of ['abc', '-3', '0', '', '2.7']) {
      const { client, url } = pagingClient(0);
      const found = await client.searchPage(
        new URL(`https://site.example/search?q=aid&page=${raw}`),
      );

      const offset = url().searchParams.get('offset');
      expect(Number(offset)).not.toBeNaN();
      // `2.7` floors to page two; everything else is below one and clamps up.
      expect(found.page).toBe(raw === '2.7' ? 2 : 1);
    }
  });

  it('counts pages from the total, and reports zero when nothing matched', async () => {
    const empty = pagingClient(0);
    await expect(
      empty.client.searchPage(new URL('https://site.example/search?q=aid')),
    ).resolves.toMatchObject({ pageCount: 0, prevHref: null, nextHref: null });

    // 21 results at 10 a page is three, not two — the partial last page counts.
    const many = pagingClient(21);
    await expect(
      many.client.searchPage(new URL('https://site.example/search?q=aid'), { perPage: 10 }),
    ).resolves.toMatchObject({ pageCount: 3 });
  });

  it('offers next on a final page that is exactly full, and not past the end', async () => {
    // Derived from `total`, not from `results.length` — twenty results at ten a page would otherwise
    // offer a third page that does not exist.
    const { client } = pagingClient(20);

    const second = await client.searchPage(
      new URL('https://site.example/search?q=aid&page=2'),
      { perPage: 10 },
    );

    expect(second.nextHref).toBeNull();
    expect(second.prevHref).toBe('/search?q=aid');
  });

  it('keeps parameters it knows nothing about when building a page link', async () => {
    /**
     * The bug that only appears once a site adds its second control: a `type` facet chosen on page
     * one silently reverts on page two, because the pager rebuilt the query string from the term
     * alone. Sites write that version because it is the obvious one.
     */
    const { client } = pagingClient(50);

    const found = await client.searchPage(
      new URL('https://site.example/search?q=aid&type=event&campus=abingdon'),
      { perPage: 10 },
    );

    const next = new URL(found.nextHref!, 'https://site.example');
    expect(next.searchParams.get('type')).toBe('event');
    expect(next.searchParams.get('campus')).toBe('abingdon');
    expect(next.searchParams.get('page')).toBe('2');
  });

  it('gives page one no page parameter, so it has one canonical URL', async () => {
    // Otherwise `/search?q=aid` and `/search?q=aid&page=1` are two URLs for one result set — two
    // cache entries, and two things for a visitor to bookmark.
    const { client } = pagingClient(50);

    const found = await client.searchPage(new URL('https://site.example/search?q=aid&page=2'));

    expect(found.hrefFor(1)).toBe('/search?q=aid');
  });

  it('builds links against the route it was called from, not a hardcoded path', async () => {
    const { client } = pagingClient(50);

    const found = await client.searchPage(
      new URL('https://site.example/about/find?q=aid'),
      { perPage: 10 },
    );

    expect(found.nextHref).toBe('/about/find?q=aid&page=2');
  });

  it('reads a term from a differently named parameter when a site asks it to', async () => {
    const { client, url } = pagingClient(0);

    const found = await client.searchPage(new URL('https://site.example/search?query=aid&p=2'), {
      queryParam: 'query',
      pageParam: 'p',
      perPage: 5,
    });

    expect(url().searchParams.get('q')).toBe('aid');
    expect(url().searchParams.get('offset')).toBe('5');
    expect(found.hrefFor(3)).toContain('p=3');
  });

  it('trims the term before searching, as the server would', async () => {
    const { client, url } = pagingClient(0);

    await client.searchPage(new URL('https://site.example/search?q=%20%20aid%20%20'));

    expect(url().searchParams.get('q')).toBe('aid');
  });

  it('works when destructured off the client', async () => {
    // `const { searchPage } = taproot` is an ordinary thing to write, and would break at runtime if
    // this reached its sibling through `this`.
    const { client } = pagingClient(0);
    const { searchPage } = client;

    await expect(searchPage(new URL('https://site.example/search?q=aid'))).resolves.toMatchObject({
      page: 1,
    });
  });
});

/**
 * Listings, whose job on this side is turning options into a query string.
 *
 * The failure mode is silent in the direction that matters: a parameter the server does not read is
 * a filter the site asked for and did not get, with a 200 either way.
 */
describe('items', () => {
  function urlCapturingClient() {
    let seen = '';
    const client = createTaprootClient({
      url: 'https://cms.example.edu',
      fetch: async (input) => {
        seen = String(input);
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    return { client, url: () => new URL(seen) };
  }

  it('asks for data with `include`, and asks for nothing extra by default', async () => {
    const { client, url } = urlCapturingClient();

    await client.items({ type: 'person', data: true, sort: 'title' });
    expect(url().searchParams.get('include')).toBe('data');
    expect(url().searchParams.get('sort')).toBe('title');

    await client.items({ type: 'person' });
    expect(url().searchParams.get('include')).toBeNull();
  });

  it('repeats `term` rather than joining, because a slug may contain a comma', async () => {
    const { client, url } = urlCapturingClient();

    await client.items({ taxonomy: 'department', term: ['sciences', 'admissions'] });

    expect(url().searchParams.getAll('term')).toEqual(['sciences', 'admissions']);
  });

  it('takes a single term as a bare string, which is what an archive route has', async () => {
    const { client, url } = urlCapturingClient();

    await client.items({ taxonomy: 'department', term: 'sciences' });

    expect(url().searchParams.getAll('term')).toEqual(['sciences']);
  });

  it('builds the terms endpoint from the taxonomy, escaping what it is given', async () => {
    const { client, url } = urlCapturingClient();

    await client.terms('department', { counts: true, type: 'person' });

    expect(url().pathname).toBe('/api/taproot/delivery/taxonomy/department/terms');
    expect(url().searchParams.get('counts')).toBe('1');
    // The type the facet sits beside, so its numbers describe the same rows the grid shows.
    expect(url().searchParams.get('type')).toBe('person');
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

/**
 * `logSearch`, whose only real failure mode is being refused.
 *
 * A key without `search:write` is the most likely misconfiguration there is — `content:read` is
 * what every existing key has, and scopes are fixed when a key is created — and it produces a 401
 * that resolves perfectly happily. Without a check the symptom is a report that stays empty
 * forever with nothing anywhere explaining why.
 */
describe('logSearch', () => {
  it('posts the entry to the log endpoint', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const client = createTaprootClient({
      url: 'https://cms.example.edu',
      apiKey: 'tpr_test',
      fetch: async (input, init) => {
        seen = { url: String(input), init };
        return new Response(null, { status: 204 });
      },
    });

    await client.logSearch({ query: 'nursing', resultCount: 4, source: 'page' });

    expect(seen?.url).toBe('https://cms.example.edu/api/taproot/search-log');
    expect(seen?.init?.method).toBe('POST');
    expect(JSON.parse(String(seen?.init?.body))).toEqual({
      query: 'nursing',
      resultCount: 4,
      source: 'page',
    });
  });

  it('names the missing scope when the write is refused', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.join(' '));
    });

    const client = createTaprootClient({
      url: 'https://cms.example.edu',
      apiKey: 'tpr_test',
      fetch: async () => new Response(null, { status: 401 }),
    });

    await client.logSearch({ query: 'nursing', resultCount: 1, source: 'page' });

    expect(errors.join(' ')).toMatch(/search:write/);
    spy.mockRestore();
  });

  it('never throws, whatever happens', async () => {
    // A failed report must not fail a page render — the visitor already has their results.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createTaprootClient({
      url: 'https://cms.example.edu',
      fetch: async () => {
        throw new Error('network down');
      },
    });

    await expect(
      client.logSearch({ query: 'nursing', resultCount: 1, source: 'page' }),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
