import {
  NO_SITE_URL,
  PREVIEW_PARAM,
  createPreviewToken,
  getContentType,
  getItem,
  getRelease,
  previewPathFor,
  previewSiteUrl,
  writePreviewDraft,
  type PreviewDraft,
} from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, readJson } from './_shared.js';

/**
 * Preview: minting a token, and keeping the split-view pane's copy of the page current.
 *
 * `?preview=1` used to be enough because the site and the CMS shared an origin, so the session
 * cookie travelled with the request and the route checked the *session* rather than the parameter.
 * After the split that cookie is not sent, and nothing on the site's side can vouch for the person.
 * So the CMS issues a short-lived token here, and the site presents it back to the delivery API.
 *
 * Contributor throughout, matching who may see unpublished content in the editor. A preview shows
 * exactly what that person can already read; making it editor-only would mean a contributor cannot
 * look at their own draft.
 *
 * No CSRF token on the writes below, and the reason is worth stating rather than assuming: the
 * session cookie is `SameSite=Lax`, so it is not sent on a cross-site request at all, and
 * `content-type: application/json` forces a preflight that a cross-origin page cannot satisfy.
 * Same posture as every other JSON route here.
 */

/**
 * Said the same way by both mints and by the pane's empty state.
 *
 * It names the setting, because the person reading it is the person who can fix it and "this kind
 * of content has no page" gave them nowhere to go — which was true when no singleton could ever
 * have one and became misleading the moment one could.
 */
export const NO_PREVIEW_PAGE =
  'This content has no page on the site to preview. A singleton gets one by setting its preview ' +
  'path under Settings → Content types.';

/** Body shape shared by the mint's optional draft and the update. */
const draftSchema = z.object({
  title: z.string(),
  slug: z.string(),
  data: z.record(z.string(), z.unknown()),
  seo: z.object({
    metaTitle: z.string().optional(),
    metaDescription: z.string().optional(),
    ogImageId: z.string().optional(),
    noIndex: z.boolean().optional(),
  }),
});

/**
 * A snapshot is a whole page's field values, which on a block-heavy page is not small — and this is
 * the one endpoint an editor hits on a timer rather than on a click. Refused rather than truncated:
 * a silently shortened preview is a preview of something else.
 */
const MAX_DRAFT_BYTES = 512 * 1024;

/**
 * Mint a preview link and redirect to it.
 *
 * A redirect rather than a JSON token, because the caller is a *link*: handing a token to a script
 * to assemble a URL puts a credential in the DOM, and a plain link buys nothing by doing so. `POST`
 * below is the case where there is something to buy — see the note there.
 *
 * **Nothing in the admin links here any more.** The editor's "Preview page" button was this route's
 * only caller and it was removed when the live preview pane replaced it: two controls with nearly
 * the same name, one showing the saved row in a new tab and one showing unsaved work in place. This
 * survives because it is the only preview entry point that needs no client script and no hydration
 * — a URL that can be linked from a release screen, a script, or a message, and that lands somebody
 * on the page with a working token. It is covered by `previewRoutes.test.ts` rather than left to
 * rot silently.
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

    const siteUrl = previewSiteUrl(process.env);
    if (!siteUrl) return apiError(503, NO_SITE_URL);

    /**
     * The address to open, which is not always the item's own path.
     *
     * A singleton is rendered wherever the site puts it, so `previewPathFor` reads the content
     * type; null means nobody has said, and there is nothing to link to. Same gate as the pane
     * below, from the same function, because a link that works and a pane that refuses would be
     * two answers to one question.
     */
    const contentType = await getContentType(taproot.db.db, item.content_type_id);
    const previewPath = contentType ? previewPathFor(contentType, item) : null;
    if (!previewPath) return apiError(400, NO_PREVIEW_PAGE);

    const { token } = await createPreviewToken(taproot.db.db, {
      contentItemId: item.id,
      releaseId,
      userId: user.id,
    });

    const target = new URL(previewPath, siteUrl);
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

/**
 * Mint a token and hand it back as JSON, for the split-view preview pane.
 *
 * The `GET` above redirects because its caller is a link. This exists because its caller is an
 * `<iframe src>` and a `PUT` body, and a 302 is not something a script can usefully consume — there
 * is no way to put a token into a frame without a script holding it. That is the gain a link does
 * not have, and what makes it acceptable is the bounds rather than the secrecy: thirty minutes, one
 * item, read-only, and strictly less than the session already sitting in that browser.
 *
 * Four rules keep it honest, and they live in the pane: mint after hydration so no token is ever in
 * the HTML this admin serves, hold it in React state only (no `localStorage`, no history, not in the
 * admin's own URL), and let it expire rather than trying to clean it up.
 *
 * An optional `draft` in the same request, so the pane's first frame already shows unsaved state
 * rather than the saved page followed a beat later by a reload.
 */
export const POST = handle(
  async ({ context, taproot, user }) => {
    const body = await readJson(
      context.request,
      z.strictObject({
        item: z.string(),
        release: z.string().nullish(),
        draft: draftSchema.optional(),
      }),
    );

    const item = await getItem(taproot.db.db, body.item);
    if (!item) return apiError(404, 'Content item not found.');

    /**
     * Content with no page on the site has nothing to frame.
     *
     * This used to refuse every singleton on the reasoning that `/__singleton/{api_id}` is a URL
     * nobody will ever request — correct about that path, and wrong about singletons, which are
     * frequently the one page a site cares most about. `previewPathFor` asks the question that was
     * actually meant: not "what kind is this" but "is there an address to open". A singleton with
     * no preview path configured is still refused, which is what keeps a settings record from
     * framing the front page and calling it itself.
     */
    const contentType = await getContentType(taproot.db.db, item.content_type_id);
    const previewPath = contentType ? previewPathFor(contentType, item) : null;
    if (!previewPath) return apiError(400, NO_PREVIEW_PAGE);

    if (body.release && !(await getRelease(taproot.db.db, body.release))) {
      return apiError(404, 'Release not found.');
    }

    const siteUrl = previewSiteUrl(process.env);
    if (!siteUrl) return apiError(503, NO_SITE_URL);

    const { token, expiresAt } = await createPreviewToken(taproot.db.db, {
      contentItemId: item.id,
      releaseId: body.release,
      userId: user.id,
    });

    let expiry = expiresAt;
    if (body.draft) {
      // Failure is not fatal here: the token is good, and the pane simply shows the saved page
      // until the next debounce tick sends a draft that validates.
      const written = await writePreviewDraft(taproot.db.db, {
        token,
        userId: user.id,
        draft: body.draft as PreviewDraft,
      });
      if (written.ok) expiry = written.expiresAt;
    }

    /**
     * `itemPath` is the address to frame, which for a singleton is not the item's own path.
     *
     * The pane uses it as the starting value of its address bar, so sending `/__singleton/homepage`
     * here would open the one URL on the site guaranteed to 404 — and the editor would have to know
     * to type over it.
     */
    return json(
      { token, expiresAt: expiry.toISOString(), siteUrl, itemPath: previewPath },
      { headers: { 'cache-control': 'no-store' } },
    );
  },
  { role: 'contributor' },
);

/**
 * Replace the unsaved snapshot attached to a token.
 *
 * The token is the only thing that says which item this is for — the body cannot name one, because
 * `content_item_id` is on the row. That is the property which makes a plain role check sufficient
 * here, with no per-item permission to invent and no way to aim a snapshot somewhere it was not
 * minted for.
 *
 * Unknown, expired, and somebody else's token all answer 404 identically, following
 * `resolvePreviewToken`: a distinct status confirms the token exists.
 */
export const PUT = handle(
  async ({ context, taproot, user }) => {
    const raw = await context.request.text();
    if (raw.length > MAX_DRAFT_BYTES) {
      return apiError(413, 'That draft is too large to preview.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return apiError(400, 'Request body must be valid JSON.');
    }

    const body = z
      .strictObject({ token: z.string() })
      .extend(draftSchema.shape)
      .parse(parsed);

    const { token, ...draft } = body;

    const result = await writePreviewDraft(taproot.db.db, {
      token,
      userId: user.id,
      draft: draft as PreviewDraft,
    });

    if (result.ok) {
      return json(
        { expiresAt: result.expiresAt.toISOString() },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    if (result.reason === 'unknown') {
      return apiError(404, 'That preview is no longer available.');
    }

    /**
     * 200, not 422, and deliberately so.
     *
     * The previous snapshot is still in the row and still renders, so nothing has failed from the
     * pane's point of view — it has one thing to say and it is not an error. Answering 4xx would
     * push this into the editor's own error handling, where a message means "your save was
     * rejected", and that has to keep meaning that.
     */
    return json(
      { stale: true, fields: result.errors },
      { headers: { 'cache-control': 'no-store' } },
    );
  },
  { role: 'contributor' },
);
