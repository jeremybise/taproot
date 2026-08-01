import { resolveDelivery } from '@taproot/core';

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
    const path = new URL(context.request.url).searchParams.get('path');
    if (path === null) {
      return apiError(400, 'A `path` query parameter is required.');
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
