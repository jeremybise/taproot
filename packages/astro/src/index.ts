import { PREVIEW_PARAM } from '@taprootcms/core/pure';

import type {
  DeliveryItemRef,
  DeliveryMenuItem,
  DeliveryResult,
  DeliverySchema,
  DeliveryTermRef,
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

export interface ListOptions {
  /** A content type's `api_id`. Omit for every addressable type. */
  type?: string;
  /**
   * A term id, or a term slug when `taxonomy` is given too.
   *
   * Always means the whole branch beneath it, expanded server-side — filing something under
   * "Biology" finds it when a visitor browses "Sciences".
   */
  term?: string;
  /** The taxonomy `term` belongs to, which is what lets `term` be a slug from a URL. */
  taxonomy?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function createTaprootClient(options: TaprootClientOptions) {
  const base = options.url.replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;

  const headers: Record<string, string> = {};
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await doFetch(`${base}/api/taproot/delivery${path}`, {
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

    /** A filtered list of visible items, for index pages and archives. */
    items(
      list: ListOptions = {},
    ): Promise<{ items: ItemSummary[]; total: number; term?: DeliveryTermRef }> {
      const params = new URLSearchParams();
      if (list.type) params.set('type', list.type);
      if (list.term) params.set('term', list.term);
      if (list.taxonomy) params.set('taxonomy', list.taxonomy);
      if (list.search) params.set('q', list.search);
      if (list.limit !== undefined) params.set('limit', String(list.limit));
      if (list.offset !== undefined) params.set('offset', String(list.offset));

      const suffix = params.toString() ? `?${params}` : '';
      return request<{ items: ItemSummary[]; total: number; term?: DeliveryTermRef }>(
        `/items${suffix}`,
      );
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
export {
  PREVIEW_PARAM,
  PREVIEW_MESSAGE,
  applyTermHrefs,
  resolveCrop,
  cropFrame,
} from '@taprootcms/core/pure';

export type {
  DeliveryField,
  DeliveryItem,
  DeliveryItemRef,
  DeliveryMedia,
  DeliveryMenuItem,
  DeliveryMenuTarget,
  DeliveryResult,
  DeliverySchema,
  DeliveryTermRef,
  MenuLink,
} from '@taprootcms/core/pure';

export type { DeliveryItemRef as TaprootItemRef };
