/**
 * The endpoint a site mounts so its *browser* can search.
 *
 * **The API key is why this exists.** Every other delivery read happens in frontmatter, on the
 * server, where `TAPROOT_API_KEY` is safe. The moment a site wants a suggestion list, a filter that
 * updates without a reload, or anything else that searches after the page has rendered, it needs a
 * same-origin endpoint — because the alternative is putting a `content:read` key into a script
 * bundle, where it is public and cannot be scoped down any further than "read all published
 * content". Every site that wants interactive search has to write this file, and every one of them
 * would write the same one.
 *
 * A handler you mount, not a route an integration injects, exactly as `createTaprootPurgeHandler`
 * is and for the same reason: `@taprootcms/astro` is a plain library, so the site owns the file, the
 * path, and the runtime.
 *
 * ```ts
 * // src/pages/api/search.ts
 * import { createTaprootSearchHandler } from '@taprootcms/astro';
 * import { taproot } from '../../taproot.ts';
 *
 * export const prerender = false;
 * export const GET = createTaprootSearchHandler({ client: taproot });
 * ```
 *
 * It is a **proxy and nothing more**: same parameters as `taproot.search`, same response shape. In
 * particular it does not highlight — the browser calls `highlightTerms` from
 * `@taprootcms/core/pure`, which is importless and a few hundred bytes, and returning marked-up HTML
 * from an endpoint would put a string that has to be trusted where a fetch can reach it. That is the
 * property `<TaprootExcerpt>` protects on the server, and it must not be given away here.
 */

import type { SearchOptions, SearchResult, TaprootClient } from './index.js';

/** The one method this needs, named structurally so a test can pass a stub. */
type Searcher = Pick<TaprootClient, 'search'>;

export interface TaprootSearchHandlerOptions {
  /** The client from `createTaprootClient`. */
  client: Searcher;
  /**
   * Pin the endpoint to one content type, ignoring any `type` the caller asks for.
   *
   * Left unset, the request's `type` is honoured, which is what a page with a type facet wants.
   * Setting it is how a site mounts a suggestion box over just its events without that being a
   * parameter anybody can change.
   */
  type?: string;
  /** Results per request when the caller names none. Small, because the caller here is a keystroke. */
  limit?: number;
  /**
   * The most a caller may ask for.
   *
   * The delivery API caps at 100 regardless; this is lower because a same-origin endpoint with no
   * key is a more open door than one, and no interactive control needs fifty suggestions.
   */
  maxLimit?: number;
  /**
   * Shortest query that is answered at all. Below it the endpoint returns no results, not an error.
   *
   * One by default, meaning "anything non-empty". Worth raising for a type-ahead: the last token
   * carries FTS5's `*`, so a single letter is a prefix match against most of the site — correct,
   * useless to read, and the most expensive query the index can be asked.
   */
  minLength?: number;
  /**
   * `cache-control` for a successful answer.
   *
   * Public and briefly cacheable by default, which is the right trade for this specific shape: the
   * query is in the URL so two visitors cannot be served each other's results, a type-ahead asks
   * the same prefixes over and over, and the site's own purge handler flushes everything when
   * content changes — so the stale window is bounded by a content edit rather than by the TTL.
   *
   * Set it to `no-store` for an endpoint that must never be shared.
   */
  cacheControl?: string;
}

export interface TaprootSearchHandlerResponse {
  results: SearchResult[];
  total: number;
  /** What the server searched for — trimmed, and what a highlighter must be given. */
  query: string;
}

const DEFAULT_CACHE_CONTROL = 'public, max-age=0, s-maxage=60';

/**
 * Bounded and floored, so `?limit=abc`, `?limit=-1` and `?limit=1e9` all land somewhere sane.
 *
 * **Absent is checked before the conversion**, because `Number(null)` is `0` and `Number('')` is `0`
 * — both finite, so a missing parameter would sail past a `Number.isFinite` guard and clamp to the
 * *minimum* instead of falling back to the default. That is how an endpoint asked for no particular
 * limit ends up returning exactly one result, which reads as a broken search rather than a broken
 * default.
 */
function clampedInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;

  return Math.min(Math.max(Math.floor(value), min), max);
}

export function createTaprootSearchHandler(options: TaprootSearchHandlerOptions) {
  const {
    client,
    type: pinnedType,
    limit: defaultLimit = 10,
    maxLimit = 25,
    minLength = 1,
    cacheControl = DEFAULT_CACHE_CONTROL,
  } = options;

  return async function GET(context: { request: Request }): Promise<Response> {
    const params = new URL(context.request.url).searchParams;
    const query = (params.get('q') ?? '').trim();

    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheControl,
      /**
       * A JSON view of other pages' content at an unbounded set of URLs — the same reason a site
       * marks its own search page `noindex`, and worth stating here because a crawler that found
       * this would be running a text query per request.
       */
      'x-robots-tag': 'noindex, nofollow',
    };

    const answer = (body: TaprootSearchHandlerResponse): Response =>
      new Response(JSON.stringify(body), { status: 200, headers });

    /**
     * Too short is an empty result, not a 400.
     *
     * The caller is a keystroke: a box being typed into passes through every prefix of the word on
     * its way to a real query, so an error status is the *normal* case for the first character or
     * two. A client would have to special-case it to avoid painting an error the visitor caused by
     * typing correctly.
     */
    if (query.length < minLength) return answer({ results: [], total: 0, query });

    const search: SearchOptions = {
      type: pinnedType ?? params.get('type') ?? undefined,
      limit: clampedInt(params.get('limit'), defaultLimit, 1, maxLimit),
      offset: clampedInt(params.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
    };

    try {
      const found = await client.search(query, search);
      return answer({ results: found.results, total: found.total, query: found.query });
    } catch (error) {
      /**
       * The CMS being unreachable is reported as a failure, and reported without detail.
       *
       * 502 rather than 500 because the fault is upstream, and a bare code rather than the delivery
       * error's message because that message is written for whoever reads a build log — it names
       * the API key as a likely cause, which is true and is not something to say to a browser.
       */
      console.error('[taproot] search request failed', error);

      return new Response(JSON.stringify({ error: 'search_unavailable' }), {
        status: 502,
        headers: { ...headers, 'cache-control': 'no-store' },
      });
    }
  };
}
