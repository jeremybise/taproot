import { PREVIEW_PARAM, createPreviewToken, getItem, getRelease } from '@taproot/core';

import { apiError, handle } from './_shared.js';

/**
 * Mint a preview link and send the editor to it.
 *
 * `?preview=1` used to be enough because the site and the CMS shared an origin, so the session
 * cookie travelled with the request and the route checked the *session* rather than the parameter.
 * After the split that cookie is not sent, and nothing on the site's side can vouch for the person.
 * So the CMS issues a short-lived token here, and the site presents it back to the delivery API.
 *
 * A redirect rather than a JSON token, because the caller is a link in the admin. Handing the token
 * to a script to assemble a URL would put a credential in the DOM for no gain.
 *
 * Contributor, matching who may see unpublished content in the editor. A preview shows exactly what
 * that person can already read; making it editor-only would mean a contributor cannot look at their
 * own draft.
 */
export const GET = handle(
  async ({ context, taproot, user }) => {
    const url = new URL(context.request.url);
    const itemId = url.searchParams.get('item');
    const releaseId = url.searchParams.get('release');

    if (!itemId) return apiError(400, 'An `item` query parameter is required.');

    const item = await getItem(taproot.db.db, itemId);
    if (!item) return apiError(404, 'Content item not found.');

    if (releaseId && !(await getRelease(taproot.db.db, releaseId))) {
      return apiError(404, 'Release not found.');
    }

    /**
     * Where the site lives.
     *
     * Unset means nobody has told the CMS where its consumer is, and there is nothing sensible to
     * guess — so this says so rather than redirecting to a 404 on its own origin, which is the
     * confusing version of the same failure.
     */
    const siteUrl = process.env.TAPROOT_SITE_URL;
    if (!siteUrl) {
      return apiError(
        503,
        'No site URL is configured, so Taproot does not know where to send a preview. Set ' +
          'TAPROOT_SITE_URL to the origin of the site that reads this content.',
      );
    }

    const { token } = await createPreviewToken(taproot.db.db, {
      contentItemId: item.id,
      releaseId,
      userId: user.id,
    });

    const target = new URL(item.path, siteUrl);
    target.searchParams.set(PREVIEW_PARAM, token);

    /**
     * `no-store`, because the URL carries a token.
     *
     * A cached 302 would hand the same preview link to whoever asked next, and it would keep
     * working until the token expired.
     */
    const response = context.redirect(target.toString(), 302);
    response.headers.set('cache-control', 'no-store');
    return response;
  },
  { role: 'contributor' },
);
