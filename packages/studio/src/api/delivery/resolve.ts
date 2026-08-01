import {
  PREVIEW_PARAM,
  buildItemPayload,
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

    if (preview) {
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

    const result = await resolveDelivery(taproot.db.db, path, {
      origin: new URL(context.request.url).origin,
      storage: taproot.storage,
      /**
       * Published only, with no way to ask otherwise.
       *
       * Cross-origin preview is Phase 3.75b and needs a signed token — until it exists, there is
       * deliberately no parameter here that could turn drafts on. An `includeUnpublished` flag
       * driven by the query string would be exactly the mistake `?preview=1` avoided by checking
       * the session rather than the parameter.
       */
    });

    if (result.kind === 'not_found') {
      return json({ kind: 'not_found' }, { status: 404 });
    }

    if (result.kind === 'redirect') {
      // Not cached: a redirect is rewritten whenever content moves again, and the collapse of a
      // redirect chain has to reach visitors promptly or a moved page keeps a stale hop.
      return json(result, { headers: { 'cache-control': 'public, max-age=0, s-maxage=30' } });
    }

    const cache = deliveryCache(result.item.updatedAt, result.item.id);
    const unchanged = notModified(context.request, cache.etag);
    if (unchanged) return unchanged;

    return json(result, { headers: cache.headers });
  },
  { scope: 'content:read' },
);
