import {
  getContentType,
  getItem,
  getRevision,
  itemWebhookSubject,
  itemWriteTags,
  publicationEvents,
  restoreRevision,
} from '@taprootcms/core';

import { apiError, handle, json } from '../../../../_shared.js';
import { canChangeStatus } from '../../../../../runtime/guards.js';

/**
 * Restore a content item to an earlier revision.
 *
 * POST rather than PUT because it is not idempotent — every restore appends a new revision, so
 * running it twice leaves a different history than running it once.
 */
export const POST = handle(
  async ({ context, taproot, user }) => {
    const itemId = context.params.id!;
    const revisionId = context.params.revisionId!;

    const item = await getItem(taproot.db.db, itemId);
    if (!item) return apiError(404, 'Content item not found.');

    const contentType = await getContentType(taproot.db.db, item.content_type_id);
    if (!contentType) return apiError(404, 'Content type not found.');

    /**
     * A revision carries the status it was saved with, so a restore is a status change and has to
     * clear the same bar the PATCH route does — otherwise restore is a second door to the thing
     * that route refuses.
     *
     * Both directions matter here, and only the first was checked. Restoring a *published*
     * revision publishes; restoring a *draft* revision onto a live item unpublishes it, which is
     * how a contributor could take a page off the site without ever touching a status control.
     */
    const revision = await getRevision(taproot.db.db, revisionId);
    if (!revision) return apiError(404, 'Revision not found.');
    if (!canChangeStatus(user, item.status, revision.status)) {
      return apiError(
        403,
        `Restoring this revision would change the item to "${revision.status}", which requires ` +
          'the editor role or higher.',
      );
    }

    const restored = await restoreRevision(
      taproot.db,
      contentType,
      contentType.fields,
      itemId,
      revisionId,
      user.id,
    );

    /**
     * A restore is a write like any other, and this route was declaring nothing.
     *
     * It changes the title, the body and possibly the status of a live page, and it emitted no tags
     * — so the delivery JSON kept the restored-over version for its full day of `s-maxage` and the
     * consumer's HTML was never flushed. Exactly the shape of the media-write bug in 5.9: the write
     * path was working, and "my restore did not take" sends you to look at it.
     */
    taproot.invalidate(itemWriteTags(restored.id, contentType.api_id));

    /**
     * And the same two events a PATCH produces, for the same reason.
     *
     * A restore can cross the publication boundary in **both** directions — the guard above says so
     * in as many words — so deriving the event from the restored status alone would call an
     * unpublish a publish.
     */
    const subject = itemWebhookSubject(restored, contentType, item.status);
    taproot.emit({ event: 'item.updated', subject });

    for (const event of publicationEvents(item.status, restored.status)) {
      taproot.emit({ event, subject });
    }

    // The history panel posts a plain HTML form, so a browser follows this back to the editor
    // rather than being left looking at raw JSON. Programmatic callers still get the item.
    if ((context.request.headers.get('accept') ?? '').includes('text/html')) {
      return context.redirect(
        `/admin/content/${itemId}?restored=${revision.revision_number}`,
        303,
      );
    }

    return json({ item: restored });
  },
  { role: 'contributor' },
);
