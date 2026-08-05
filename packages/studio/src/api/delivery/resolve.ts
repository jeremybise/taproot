import {
  PREVIEW_PARAM,
  buildItemPayload,
  getItemVersionByPath,
  normalizePath,
  resolveDelivery,
  resolvePreviewToken,
} from '@taprootcms/core';

import { apiError, handleScoped, json } from '../_shared.js';
import { deliveryCache, notModified } from './cache.js';

/**
 * Resolve a path to everything needed to render it, in one request.
 *
 * This is the endpoint the split exists for. The embedded demo route makes twelve-plus queries per
 * page — the item, its type, its children, one lookup *per ancestor* for breadcrumbs, the blocks,
 * an `og:image` row, the redirect fallback — which is unremarkable against a local database and
 * indefensible as twelve HTTP round trips. All of it comes back here.
 *
 * A redirect is a 200 carrying `{ kind: 'redirect' }` rather than a 30x. The consumer has to issue
 * the redirect to *its own* visitor, on its own origin; sending a real 30x would either redirect the
 * server-side fetch (and silently serve the wrong page's content under the requested URL) or need
 * the client to disable following, which is a footgun to hand somebody in exchange for nothing.
 */
export const GET = handleScoped(
  async ({ context, taproot }) => {
    const url = new URL(context.request.url);
    const path = url.searchParams.get('path');
    if (path === null) {
      return apiError(400, 'A `path` query parameter is required.');
    }

    /**
     * A preview token, which is the only way to see unpublished content here.
     *
     * Deliberately not a boolean flag: `?preview=1` would be a parameter anyone could add, and the
     * reason the old same-origin version was safe is that it checked the *session* rather than the
     * parameter. The token is the replacement for that session, and `resolvePreviewToken` answers
     * `undefined` for absent, malformed, unknown, and expired alike — so this cannot be probed.
     *
     * The payload is built by the same function the published path uses, which is what stops a
     * preview being a preview of something nobody will ever see.
     */
    const preview = await resolvePreviewToken(
      taproot.db.db,
      url.searchParams.get(PREVIEW_PARAM),
    );

    /**
     * The override applies to the page the token was minted for, and to no other.
     *
     * This branch used to ignore `path` entirely and answer with the token's item whatever was
     * asked for. That was invisible while the only caller was a 302 straight to `item.path` — but
     * the split-view pane can be pointed at any address on the site, and following a link inside
     * that frame would make every page render as the item being edited.
     *
     * It is also the security property, stated: a preview token is a capability over **one** item,
     * not a site-wide key to unpublished content. Any other address falls through to the ordinary
     * published-only resolution below.
     */
    if (preview && normalizePath(path) === preview.item.path) {
      const payload = await buildItemPayload(taproot.db.db, preview.item, {
        origin: url.origin,
        storage: taproot.storage,
        includeUnpublished: true,
      });

      // Never cached and never indexed: this is content that is not live, and a shared cache
      // holding it would serve a draft to somebody with no token at all.
      return json(payload, {
        headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
      });
    }

    /**
     * A token-bearing URL is never cached, even when the answer is published content.
     *
     * The response is public, so this is not about the body — it is that the URL is a cache key and
     * this one carries a credential. A shared cache holding entries under it is a credential
     * sitting in infrastructure that has no reason to hold one.
     */
    const noStore = Boolean(preview);

    /**
     * Answer a conditional request **before** resolving anything.
     *
     * This check used to sit at the bottom, after `resolveDelivery` had run every query and built
     * the whole payload, and it threw the body away on a match. That saved a payload — and a payload
     * is the part Cloudflare does not charge for, while D1 bills rows read. A 304 cost exactly what
     * a 200 did, which is the opposite of what a validator is for.
     *
     * One indexed lookup of `id` and `updated_at` answers it instead, because those two are the only
     * inputs `deliveryCache` has. The full resolution below still recomputes the same tag for a
     * request that turns out to need a body; there is no second definition of the validator, and
     * `deliveryCache` stays the only place it is spelled.
     *
     * Skipped entirely under a preview token, which is `no-store` — a client holding a validator for
     * unpublished content is exactly what that header exists to prevent.
     */
    if (!noStore && context.request.headers.get('if-none-match')) {
      const version = await getItemVersionByPath(taproot.db.db, path);
      if (version) {
        const cheap = deliveryCache(version.updatedAt, version.id);
        const unchanged = notModified(context.request, cheap.etag);
        if (unchanged) return unchanged;
      }
    }

    const result = await resolveDelivery(taproot.db.db, path, {
      origin: new URL(context.request.url).origin,
      storage: taproot.storage,
      /**
       * Published only, with no way to ask otherwise.
       *
       * A valid token reaching this line means it was minted for a *different* page — the pane's
       * address box pointed elsewhere, or somebody followed a link inside the frame. It buys
       * nothing here: an `includeUnpublished` flag the query string could turn on would be exactly
       * the mistake `?preview=1` avoided by checking the session rather than the parameter, and it
       * would quietly widen a one-item capability into a site-wide one.
       */
    });

    if (result.kind === 'not_found') {
      /**
       * A 404 is cacheable too, and used to carry no headers at all.
       *
       * Every crawler on a dead URL, every stale inbound link, and every scanner probing for
       * `/wp-login.php` paid a full item lookup *and* a redirect lookup, repeatedly, because nothing
       * downstream was allowed to remember the answer. Kept short: a 404 is the one answer most
       * likely to stop being true, since it becomes a real page the moment somebody publishes one at
       * that path.
       */
      return json(
        { kind: 'not_found' },
        {
          status: 404,
          headers: {
            'cache-control': noStore ? 'no-store' : 'public, max-age=0, s-maxage=30',
            vary: 'authorization',
          },
        },
      );
    }

    if (result.kind === 'redirect') {
      // Not cached for long: a redirect is rewritten whenever content moves again, and the collapse
      // of a redirect chain has to reach visitors promptly or a moved page keeps a stale hop.
      return json(result, {
        headers: { 'cache-control': noStore ? 'no-store' : 'public, max-age=0, s-maxage=30' },
      });
    }

    /**
     * The validator for the body being sent. There is no `notModified` check here any more, and its
     * absence is deliberate rather than an omission.
     *
     * Reaching this line with `kind: 'item'` means `getItemVersionByPath` above found the same row
     * under the same visibility predicate, so a matching `if-none-match` has already returned 304
     * without resolving anything. A second check here could only ever be false, and a dead branch
     * that looks load-bearing is how the next person concludes the cheap path is optional.
     */
    const cache = deliveryCache(result.item.updatedAt, result.item.id, result.cacheTags);

    return json(result, {
      headers: noStore ? { ...cache.headers, 'cache-control': 'no-store' } : cache.headers,
    });
  },
  { scope: 'content:read' },
);
