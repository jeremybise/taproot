import { describe, expect, it, vi, afterEach } from 'vitest';

import { createTaprootSearchHandler } from './search.js';
import type { SearchResponse } from './index.js';

/**
 * The consumer's search endpoint: a proxy that exists so an API key never reaches a browser.
 *
 * What gets tested here is the bounding, because that is the whole of what this adds over calling
 * the client directly. The endpoint is same-origin, unauthenticated, and reachable by anybody who
 * can load the site, so every number a caller supplies has to land somewhere sane and a short query
 * must not become the most expensive read the index can serve.
 */

const emptyResponse: SearchResponse = { results: [], total: 0, query: '' };

function clientReturning(response: Partial<SearchResponse> = {}) {
  return {
    search: vi.fn(async (query: string) => ({ ...emptyResponse, ...response, query })),
  };
}

const get = (url: string) => ({ request: new Request(url) });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createTaprootSearchHandler', () => {
  it('proxies the query and answers the delivery shape', async () => {
    const client = clientReturning({
      results: [
        {
          id: 'a',
          title: 'Financial Aid',
          slug: 'financial-aid',
          path: '/financial-aid',
          status: 'published',
          publishedAt: null,
          updatedAt: '2026-01-01T00:00:00Z',
          excerpt: 'Apply for financial aid',
        },
      ],
      total: 1,
    });

    const GET = createTaprootSearchHandler({ client });
    const response = await GET(get('https://site.example/api/search?q=financial'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ total: 1, query: 'financial' });
    expect(client.search).toHaveBeenCalledWith('financial', expect.objectContaining({ limit: 10 }));
  });

  it('never asks for more than maxLimit, whatever the caller sends', async () => {
    const client = clientReturning();
    const GET = createTaprootSearchHandler({ client, maxLimit: 25 });

    await GET(get('https://site.example/api/search?q=aid&limit=5000'));
    expect(client.search).toHaveBeenCalledWith('aid', expect.objectContaining({ limit: 25 }));
  });

  it('lands on a real number for a limit or offset that is not one', async () => {
    // `NaN` here would go onto the wire as `limit=NaN`, which is a 400 from the delivery API for
    // input a visitor produced by editing their own URL.
    const client = clientReturning();
    const GET = createTaprootSearchHandler({ client });

    await GET(get('https://site.example/api/search?q=aid&limit=abc&offset=-40'));
    expect(client.search).toHaveBeenCalledWith('aid', expect.objectContaining({ limit: 10, offset: 0 }));
  });

  it('uses the default limit when none is given, rather than the floor', async () => {
    /**
     * `Number(null)` is `0` and `Number('')` is `0` — both finite, so an absent parameter walks past
     * a `Number.isFinite` guard and clamps to the minimum. This shipped that way for one test run:
     * an endpoint asked for no particular limit returned exactly one result, which reads as a broken
     * search rather than a broken default.
     */
    for (const query of ['q=aid', 'q=aid&limit=', 'q=aid&offset=']) {
      const client = clientReturning();
      await createTaprootSearchHandler({ client, limit: 8 })(
        get(`https://site.example/api/search?${query}`),
      );
      expect(client.search).toHaveBeenCalledWith('aid', expect.objectContaining({ limit: 8, offset: 0 }));
    }
  });

  it('answers a too-short query with no results rather than an error', async () => {
    /**
     * The caller is a keystroke. A box being typed into passes through every prefix on its way to a
     * real query, so a 400 for one character is the *normal* case and a client would have to
     * special-case it to avoid painting an error the visitor caused by typing correctly.
     */
    const client = clientReturning();
    const GET = createTaprootSearchHandler({ client, minLength: 3 });

    const response = await GET(get('https://site.example/api/search?q=ai'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [], total: 0, query: 'ai' });
    expect(client.search).not.toHaveBeenCalled();
  });

  it('does not search at all for a blank query', async () => {
    const client = clientReturning();
    const GET = createTaprootSearchHandler({ client });

    await GET(get('https://site.example/api/search?q=%20%20'));
    expect(client.search).not.toHaveBeenCalled();
  });

  it('honours a caller-supplied type, and refuses to when the endpoint is pinned', async () => {
    const open = clientReturning();
    await createTaprootSearchHandler({ client: open })(
      get('https://site.example/api/search?q=aid&type=event'),
    );
    expect(open.search).toHaveBeenCalledWith('aid', expect.objectContaining({ type: 'event' }));

    // Pinned is how a site mounts a suggestion box over one type without that being a parameter
    // anybody can rewrite.
    const pinned = clientReturning();
    await createTaprootSearchHandler({ client: pinned, type: 'person' })(
      get('https://site.example/api/search?q=aid&type=event'),
    );
    expect(pinned.search).toHaveBeenCalledWith('aid', expect.objectContaining({ type: 'person' }));
  });

  it('reports an unreachable CMS as 502, without repeating what it was told', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = {
      search: vi.fn(async () => {
        throw new Error('The Taproot server refused the API key. Check TAPROOT_API_KEY…');
      }),
    };

    const response = await createTaprootSearchHandler({ client })(
      get('https://site.example/api/search?q=aid'),
    );

    expect(response.status).toBe(502);
    // The delivery error names the API key as a likely cause. True, and not something to say to a
    // browser — it is written for whoever reads a build log.
    const body = await response.text();
    expect(body).not.toContain('TAPROOT_API_KEY');
    expect(JSON.parse(body)).toEqual({ error: 'search_unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('is cacheable by default and never indexable', async () => {
    const response = await createTaprootSearchHandler({ client: clientReturning() })(
      get('https://site.example/api/search?q=aid'),
    );

    expect(response.headers.get('cache-control')).toContain('s-maxage');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });
});
