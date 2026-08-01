import { getRelease, publishRelease } from '@taprootcms/core';

import { apiError, handle, json } from '../../_shared.js';

/**
 * Publish a release now.
 *
 * Its own endpoint rather than `PATCH { status: 'published' }`, because publishing is not setting a
 * value. It runs pre-flight over every staged version, then applies each one through `updateItem` —
 * cascading paths, writing redirects, appending revisions. A status field that did all that would
 * be a verb wearing a noun's clothes, and the PATCH schema would have to grow a check that this
 * route can simply *be*.
 *
 * Editor, matching `canManageRelease`: publishing a release performs a transition into `published`
 * for every item in it, and the workflow graph already prices that at editor. A release must not be
 * a way to make a change `canChangeStatus` would refuse one item at a time.
 *
 * Idempotent in the way that matters. Staged versions already applied carry a `published_at` and
 * are skipped, so re-running after a partial failure finishes the job rather than republishing what
 * already landed.
 */
export const POST = handle(
  async ({ context, taproot, user }) => {
    const id = context.params.id!;
    const release = await getRelease(taproot.db.db, id);
    if (!release) return apiError(404, 'Release not found.');

    const isForm = (context.request.headers.get('content-type') ?? '').includes('form');
    const result = await publishRelease(taproot.db, id, { actor: user });

    if (isForm) {
      const params = new URLSearchParams();

      if (result.ok) {
        params.set('published', String(result.published.length));
      } else if (result.problems.length > 0) {
        /**
         * Pre-flight refused it, so nothing was written.
         *
         * The reasons are not passed through the query string — they are recomputed by the screen,
         * which re-runs pre-flight on every render. A list of reasons carried in a URL is one that
         * survives being fixed: the editor corrects the field, comes back, and is still being told
         * about it.
         */
        params.set('blocked', '1');
      } else {
        params.set('partial', String(result.published.length));
        params.set('failed', String(result.failed.length));
      }

      return context.redirect(`/admin/releases/${id}?${params}`, 303);
    }

    return json(result, { status: result.ok ? 200 : 409 });
  },
  { role: 'editor' },
);
