import { PREVIEW_PARAM } from '@taprootcms/core/pure';

import type {
  DeliveryItemRef,
  DeliveryMedia,
  DeliveryMenuItem,
  DeliveryResult,
  DeliverySchema,
  DeliveryTaxonomy,
  DeliveryTermRef,
  ItemSort,
} from '@taprootcms/core/pure';

/**
 * The Taproot client for Astro.
 *
 * A site installs this package, holds an API key, and reads content over HTTP. It does not hold a
 * database, and cannot: the delivery API is the whole contract, which is what makes the CMS a
 * deployment somebody else can run and upgrade without touching this site's code.
 *
 * Every type here comes from `@taprootcms/core/pure` as an `import type`, erased at build. Nothing in
 * this file reaches core at runtime, and `@taprootcms/core/pure` itself compiles to a re-export of the
 * crop arithmetic — so a consumer's bundle contains no Kysely, no dialects, and no data layer.
 *
 * ```ts
 * const taproot = createTaprootClient({
 *   url: import.meta.env.TAPROOT_API_URL,
 *   apiKey: import.meta.env.TAPROOT_API_KEY,
 * });
 *
 * const page = await taproot.resolve(Astro.url.pathname);
 * ```
 */

export interface TaprootClientOptions {
  /** Origin of the Taproot server: `https://cms.example.edu`. */
  url: string;
  /** An API key with the `content:read` scope. See the handbook under Settings → API keys. */
  apiKey?: string;
  /** Swapped in tests, and by a site that wants its own caching or retry behaviour. */
  fetch?: typeof globalThis.fetch;
}

export class TaprootDeliveryError extends Error {
  override name = 'TaprootDeliveryError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ItemSummary {
  id: string;
  title: string;
  slug: string;
  path: string;
  status: string;
  publishedAt: string | null;
  updatedAt: string;
}

/**
 * One search result: a summary plus the sentence the term was found in.
 *
 * The excerpt is **plain text** and must be rendered as text. It is assembled from stored content,
 * so a consumer putting it through `set:html` would be undoing the sanitiser on the one field that
 * never passed through it as markup — and there is nothing to gain, since it carries no highlight
 * markup by design.
 */
export interface SearchResult extends ItemSummary {
  excerpt: string;
}

export interface SearchOptions {
  /** A content type's `api_id`, to search one type. Omit for everything addressable. */
  type?: string;
  /**
   * One of the named orders. Omit for relevance, which is what a search page usually wants.
   *
   * Anything outside the vocabulary falls back to relevance rather than erroring.
   */
  sort?: ItemSort;
  /** Defaults to 20, capped server-side at 100. */
  limit?: number;
  offset?: number;
}

/**
 * One item in a listing: a summary, plus its field values when they were asked for.
 *
 * `data` is the same shape a `query` field's results carry — the item's own fields with `block` and
 * `query` stripped, media/relation/term ids resolving through the maps beside it — so a card
 * component written for one renders the other unchanged.
 */
export interface ListItem extends ItemSummary {
  data?: Record<string, unknown>;
}

export interface ListOptions {
  /** A content type's `api_id`. Omit for every addressable type. */
  type?: string;
  /**
   * A term id, or a term slug when `taxonomy` is given too. Several mean **any of them**.
   *
   * Each always means the whole branch beneath it, expanded server-side — filing something under
   * "Biology" finds it when a visitor browses "Sciences". Passing two departments widens the list
   * to people in either, which is what a facet with checkboxes does.
   */
  term?: string | string[];
  /** The taxonomy `term` belongs to, which is what lets `term` be a slug from a URL. */
  taxonomy?: string;
  search?: string;
  /**
   * One of the named orders. Omitted, a listing comes back in site order (`path`) — or ranked, when
   * `search` is set and no order is named.
   *
   * An order this API does not have is refused rather than ignored, so a typo is a failed request
   * instead of a directory silently in the wrong order.
   */
  sort?: ItemSort;
  /**
   * Ask for each item's field values, and the lookup maps their ids resolve through.
   *
   * Off by default, and worth leaving off for a list of links: it is the difference between sending
   * fifty titles and sending fifty pages' worth of fields. Turn it on to render cards — a directory
   * needs the photo, the role and the department, and the alternative is one `resolve` per person.
   */
  data?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListResult {
  items: ListItem[];
  /** Matching items in total, which is what a pager needs and `items.length` is not. */
  total: number;
  /** The term named by a `taxonomy` + `term` slug pair, for an archive page's heading. */
  term?: DeliveryTermRef;
  /** Present only with `data: true`, because a summary carries no ids to look up. */
  media?: Record<string, DeliveryMedia>;
  references?: Record<string, DeliveryItemRef>;
  terms?: Record<string, DeliveryTermRef>;
}

export function createTaprootClient(options: TaprootClientOptions) {
  /**
   * A missing `url` is almost never a missing argument.
   *
   * It is an environment variable that was undefined at *runtime* — which the type system cannot
   * see, because `url: string` describes what the caller believes it is passing. On Workers that is
   * the ordinary outcome of two mistakes the handbook now documents: reading `import.meta.env`,
   * which Astro substitutes at build time and Cloudflare has no `process.env` to backfill, and
   * setting a value only in `.dev.vars`, which is never uploaded.
   *
   * Without this the failure is `options.url.replace` throwing `Cannot read properties of undefined`
   * from inside a bundled chunk, at module scope, before a request is ever made — a stack that names
   * neither the variable nor the fact that it is a configuration problem. Same reasoning as the 401
   * message below: the person reading this is the person who can fix it, and they are only reading
   * it because something did not say what was wrong.
   *
   * Only `url` is guarded. A missing `apiKey` is legitimate against a local studio, where a signed-in
   * session reaches the delivery API too.
   */
  if (!options.url) {
    throw new Error(
      'createTaprootClient was given no `url`. This is usually an environment variable that is ' +
        'undefined at runtime rather than a missing argument — see the handbook, Building a site → ' +
        'Getting started.',
    );
  }

  const base = options.url.replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;

  const headers: Record<string, string> = {};
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  /**
   * In-flight requests, so one render never asks the CMS the same question twice.
   *
   * A layout and a component that both want the main menu are two `await taproot.menu('main')` calls
   * with nothing between them, and without this they are two HTTP requests — a second round trip for
   * an answer already on its way. Keyed by URL, which is the whole of what identifies a delivery
   * read: every one of these is a GET whose only inputs are its path and query.
   *
   * **This deduplicates concurrent work; it is not a cache.** The entry is dropped as soon as the
   * request settles, so a second call after the first has returned goes to the network again. That
   * boundary is deliberate:
   *
   * A response cache here is the tempting next step and it is the wrong layer. Keeping bodies keyed
   * by ETag would work — a 304 does mean "your copy is current" — right up against the one thing the
   * validator is documented as unable to see: a reusable block edited in the library changes what a
   * page renders without touching the page's row, so the ETag keeps matching and a cached body would
   * stay stale with **no bound at all**. `s-maxage` is what bounds that today, and re-implementing
   * expiry, revalidation and eviction here would be a worse HTTP cache sitting in front of a working
   * one. The edge cache is where that belongs, and `Cache-Tag` is how it is invalidated.
   *
   * A module-level map is right despite that being per-isolate rather than per-request: entries live
   * only as long as a request is in flight, so nothing crosses between two visitors' renders.
   */
  const inFlight = new Map<string, Promise<unknown>>();

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${base}/api/taproot/delivery${path}`;

    const existing = inFlight.get(url);
    if (existing) return existing as Promise<T>;

    const pending = send<T>(url, init).finally(() => inFlight.delete(url));
    inFlight.set(url, pending);
    return pending;
  }

  async function send<T>(url: string, init: RequestInit): Promise<T> {
    const response = await doFetch(url, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });

    if (!response.ok && response.status !== 404) {
      /**
       * The message names the likely cause rather than repeating the status.
       *
       * A 401 here is almost always a missing or revoked key, and that is a configuration problem
       * on the *consumer's* side — the site owner reading their build log is the person who can fix
       * it, and "401" alone sends them to the CMS to look for a fault that is not there.
       */
      const detail =
        response.status === 401
          ? 'The Taproot server refused the API key. Check TAPROOT_API_KEY is set and has not been revoked.'
          : `Taproot answered ${response.status}.`;
      throw new TaprootDeliveryError(detail, response.status);
    }

    return (await response.json()) as T;
  }

  return {
    /**
     * Everything needed to render a path, in one round trip.
     *
     * Returns a discriminated union rather than throwing on a miss, because "nothing is here" and
     * "the CMS is unreachable" are different things a site handles differently — one is a 404 page
     * and the other is an outage.
     *
     * A redirect comes back as data, not as a 30x. The site has to redirect *its own* visitor on
     * its own origin; a real 30x would have redirected this fetch and returned the wrong page's
     * content under the requested URL.
     */
    resolve(
      path: string,
      resolveOptions: { previewToken?: string | null } = {},
    ): Promise<DeliveryResult> {
      const params = new URLSearchParams({ path });
      /**
       * Forwarded untouched. A consumer cannot judge a preview token — it has no session and no
       * database — so it hands it back and the CMS decides, which is what keeps the capability in
       * the token rather than in a query parameter anybody could add.
       */
      if (resolveOptions.previewToken) {
        params.set(PREVIEW_PARAM, resolveOptions.previewToken);
      }
      return request<DeliveryResult>(`/resolve?${params}`);
    },

    /**
     * A filtered list of visible items, for index pages, archives and card grids.
     *
     * ```ts
     * const { items, media, terms } = await taproot.items({
     *   type: 'person',
     *   term: departmentSlugs,      // several mean any of them
     *   taxonomy: 'department',
     *   sort: 'title',
     *   data: true,                 // photo, role, department — no second request
     *   limit: 24,
     * });
     * ```
     */
    items(list: ListOptions = {}): Promise<ListResult> {
      const params = new URLSearchParams();
      if (list.type) params.set('type', list.type);
      /**
       * Repeated rather than comma-joined, because a slug may contain a comma.
       *
       * The server accepts both spellings; this one cannot be ambiguous, which matters for a value
       * that ultimately came from a term an editor named.
       */
      for (const term of Array.isArray(list.term) ? list.term : list.term ? [list.term] : []) {
        params.append('term', term);
      }
      if (list.taxonomy) params.set('taxonomy', list.taxonomy);
      if (list.search) params.set('q', list.search);
      if (list.sort) params.set('sort', list.sort);
      if (list.data) params.set('include', 'data');
      if (list.limit !== undefined) params.set('limit', String(list.limit));
      if (list.offset !== undefined) params.set('offset', String(list.offset));

      const suffix = params.toString() ? `?${params}` : '';
      return request<ListResult>(`/items${suffix}`);
    },

    /**
     * A taxonomy's terms, for building a facet.
     *
     * ```ts
     * const { terms } = await taproot.terms('department', { counts: true, type: 'person' });
     * ```
     *
     * Flat, with `parentId`, depth-first so parents come before their children. `counts` adds
     * `itemCount` per term and costs a second query server-side, so it is opt-in; pass `type`
     * alongside it whenever the listing beside the facet is narrowed to one, or the numbers describe
     * a different set from the rows.
     */
    terms(
      taxonomyApiId: string,
      termOptions: { counts?: boolean; type?: string } = {},
    ): Promise<DeliveryTaxonomy> {
      const params = new URLSearchParams();
      if (termOptions.counts) params.set('counts', '1');
      if (termOptions.type) params.set('type', termOptions.type);

      const suffix = params.toString() ? `?${params}` : '';
      return request<DeliveryTaxonomy>(
        `/taxonomy/${encodeURIComponent(taxonomyApiId)}/terms${suffix}`,
      );
    },

    /**
     * Search a site's content: title, path, and the item's own prose.
     *
     * Results come back ranked — a term in the title above a term in the body — with a plain-text
     * excerpt around the match. A blank or whitespace-only term is answered with no results rather
     * than with everything, so a site's own empty search box needs no guard of its own.
     *
     * ```astro
     * const q = Astro.url.searchParams.get('q') ?? '';
     * const { results, total } = await taproot.search(q);
     * ```
     */
    search(
      query: string,
      searchOptions: SearchOptions = {},
    ): Promise<{ results: SearchResult[]; total: number; query: string }> {
      const params = new URLSearchParams({ q: query });
      if (searchOptions.type) params.set('type', searchOptions.type);
      if (searchOptions.sort) params.set('sort', searchOptions.sort);
      if (searchOptions.limit !== undefined) params.set('limit', String(searchOptions.limit));
      if (searchOptions.offset !== undefined) params.set('offset', String(searchOptions.offset));

      return request<{ results: SearchResult[]; total: number; query: string }>(`/search?${params}`);
    },

    /**
     * A menu, with term targets left unresolved.
     *
     * Apply `applyTermHrefs` with the site's own policy to turn it into links. Taproot has no
     * opinion about which taxonomies get public pages, and this is where that survives the wire.
     */
    async menu(apiId: string): Promise<DeliveryMenuItem[]> {
      const { items } = await request<{ items: DeliveryMenuItem[] }>(
        `/menu/${encodeURIComponent(apiId)}`,
      );
      return items;
    },

    /** The content model. Read by the type generator; rarely useful at request time. */
    schema(): Promise<DeliverySchema> {
      return request<DeliverySchema>('/schema');
    },
  };
}

export type TaprootClient = ReturnType<typeof createTaprootClient>;

/**
 * Re-exported so a site imports one package.
 *
 * `applyTermHrefs` is the other half of `resolveMenu`'s callback, and the crop maths is what
 * `TaprootImage` resolves a stored hotspot with. Both are pure and both live in core so the studio's
 * own preview and a consumer's rendering cannot disagree — which was the bug `TaprootImage` was
 * written to fix in the first place.
 */
export { createTaprootPurgeHandler, type TaprootPurgeHandlerOptions } from './purge.js';

export {
  PURGE_PATH,
  PREVIEW_PARAM,
  PREVIEW_MESSAGE,
  applyTermHrefs,
  resolveCrop,
  cropFrame,
  /**
   * How a listing finds its results: `queries[queryKey(block.id, 'events')]`.
   *
   * Exported rather than left to be spelled by hand, because the failure mode of getting it wrong
   * is a lookup that returns `undefined` — an empty listing on a page whose payload is complete,
   * with nothing anywhere reporting a problem.
   */
  queryKey,
} from '@taprootcms/core/pure';

export type {
  DeliveryField,
  DeliveryItem,
  DeliveryItemRef,
  DeliveryMedia,
  DeliveryMenuItem,
  DeliveryMenuTarget,
  DeliveryQueryResult,
  DeliveryResult,
  DeliverySchema,
  /** An `embed` field's value, and how its frame is sized — both `<TaprootEmbed>` props. */
  EmbedSizing,
  EmbedValue,
  /** A taxonomy and its terms, as `taproot.terms()` answers. */
  DeliveryTaxonomy,
  DeliveryTaxonomyTerm,
  DeliveryTermRef,
  ItemSort,
  MenuLink,
} from '@taprootcms/core/pure';

export type { DeliveryItemRef as TaprootItemRef };
