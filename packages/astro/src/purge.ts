/**
 * The endpoint a site mounts so the CMS can clear its rendered HTML.
 *
 * **Cloudflare scopes cache purging to the Worker that owns the cache.** The CMS purging its own
 * tags clears the delivery JSON and cannot touch the HTML a site rendered from it, so without this
 * a published page reaches visitors only when the site's own `s-maxage` lapses. That is why this is
 * a request the CMS makes rather than something it can do directly.
 *
 * **A handler you mount, not a route injected by an integration.** `@taprootcms/astro` is a plain
 * library — it has no Astro integration and calls no `injectRoute` — so the site owns the file and
 * therefore owns the path, the runtime, and the secret's provenance. Mount it as:
 *
 * ```ts
 * // src/pages/taproot/purge.ts
 * import { createTaprootPurgeHandler } from '@taprootcms/astro';
 * import { env } from 'cloudflare:workers';
 *
 * export const prerender = false;
 * export const POST = createTaprootPurgeHandler({ secret: env.TAPROOT_PURGE_SECRET });
 * ```
 *
 * **It flushes everything rather than purging the tags it was sent**, and that is a decision rather
 * than a shortcut. A site's pages are rendered from several delivery calls, and only `resolve`
 * exposes `cacheTags` — `/delivery/items` and `/delivery/menu` do not, so a listing page has no way
 * to know what it depended on. Tag-precise purging would therefore silently never invalidate
 * exactly the pages most likely to be stale: the index that should show a newly published item. The
 * tags still arrive in the body so precision can be added later without changing the protocol.
 */

import { PURGE_SECRET_HEADER } from '@taprootcms/core/pure';

/** The slice of Cloudflare's `ExecutionContext` this needs, named structurally. */
interface CachePurger {
  purge?: (options: { purgeEverything: true }) => Promise<unknown>;
}

export interface TaprootPurgeHandlerOptions {
  /**
   * The shared secret, matching `TAPROOT_SITE_PURGE_SECRET` on the CMS.
   *
   * Undefined disables the endpoint — it answers 404, not 401. An unconfigured site should look
   * like a site with no such route rather than like one guarding something, because a 401 tells an
   * unauthenticated caller that there is an endpoint here worth guessing at.
   */
  secret?: string;
}

/**
 * Constant-time comparison, so a wrong secret leaks nothing about the right one.
 *
 * Length is compared first and *is* leaked, which is fine and unavoidable — an early return on
 * mismatched lengths is what every implementation does, and the length of a random secret is not
 * the part worth protecting.
 */
function secretMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }

  return diff === 0;
}

export function createTaprootPurgeHandler(options: TaprootPurgeHandlerOptions = {}) {
  return async function POST(context: {
    request: Request;
    locals?: unknown;
  }): Promise<Response> {
    const { secret } = options;

    // Never cached, never stored, and never indexed — this is an authenticated write surface.
    const headers = { 'cache-control': 'no-store' };

    if (!secret) return new Response(null, { status: 404, headers });

    const presented = context.request.headers.get(PURGE_SECRET_HEADER);
    if (!presented || !secretMatches(presented, secret)) {
      return new Response(null, { status: 401, headers });
    }

    try {
      const cache = (
        context.locals as { cfContext?: { cache?: CachePurger } } | undefined
      )?.cfContext?.cache;

      /**
       * No cache is a success, not a failure.
       *
       * That is the shape of `npm run dev` and of any deployment without
       * `"cache": { "enabled": true }`. Answering an error would make the CMS retry eight times and
       * then report a problem on Settings → System for a site that is behaving correctly.
       */
      await cache?.purge?.({ purgeEverything: true });

      return new Response(null, { status: 204, headers });
    } catch (error) {
      /**
       * A real failure, reported as one — deliberately unlike every purge path inside the CMS.
       *
       * There the rule is "never throw", because the write being described has already committed
       * and telling an editor their save failed would be a lie. Here there is no write and no
       * editor: the caller is the CMS's retry queue, and the only way it can ever replay this is if
       * this response says it did not work.
       */
      console.error('[taproot] cache purge failed', error);
      return new Response(null, { status: 500, headers });
    }
  };
}
