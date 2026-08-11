import {
  SITE_TAG,
  getRelease,
  itemWebhookSubjects,
  publicationEvents,
  publishRelease,
} from '@taprootcms/core';

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

    /**
     * A published release purges everything, deliberately, rather than tagging item by item.
     *
     * `published` carries `{ id, title, path }` and not the content type each item belongs to, so
     * the `type:` tags that listings depend on are not reachable from here without a second query
     * per item — and a release is the one operation whose whole purpose is that many pages change
     * together. The coarse purge is also the accurate one: a launch is exactly the moment when
     * "which pages did this affect" is answered by "assume all of them".
     *
     * Safe because releases are published rarely and by hand, which is not true of an item save —
     * that is why `itemWriteTags` is precise and this is not. Only on a successful publish: a
     * pre-flight refusal wrote nothing, and flushing the cache for a no-op would be a cold site
     * bought with an error message.
     */
    if (result.published.length > 0) taproot.invalidate([SITE_TAG]);

    /**
     * Per item *and* for the release, which is not two spellings of one fact.
     *
     * A static build wants one signal for a launch of twelve pages; a search index wants twelve. So
     * both go out, and an endpoint subscribes to whichever it can act on. `release.published` is
     * emitted only when every staged version applied — a partial publish is a state somebody has to
     * look at, and announcing it as a completed release would be the CMS asserting something it has
     * just recorded as untrue.
     *
     * Precision is affordable here where the *purge* above stays coarse, and the difference is what
     * each costs: the tags would need a second query per item, while the subjects are one query for
     * the batch — and an event names the item it is about, so a receiver cannot use "assume all of
     * them" the way a cache can.
     */
    const subjects = await itemWebhookSubjects(
      taproot.db.db,
      result.published.map((entry) => entry.id),
    );

    for (const entry of result.published) {
      const subject = subjects.get(entry.id);
      if (!subject) continue;

      const withPrevious = { ...subject, previousStatus: entry.from };
      taproot.emit({ event: 'item.updated', subject: withPrevious });

      for (const event of publicationEvents(entry.from, 'published')) {
        taproot.emit({ event, subject: withPrevious });
      }
    }

    if (result.ok && result.published.length > 0) {
      taproot.emit({
        event: 'release.published',
        subject: {
          kind: 'release',
          id: release.id,
          name: release.name,
          itemCount: result.published.length,
        },
      });
    }

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
