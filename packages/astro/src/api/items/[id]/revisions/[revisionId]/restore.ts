import { getContentType, getItem, getRevision, restoreRevision } from '@taproot/core';

import { apiError, handle, json } from '../../../../_shared.js';
import { canPublishContent } from '../../../../../runtime/guards.js';

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
     * A revision carries the status it was saved with, so restoring one is a publish when that
     * status was `published`. Without this check, restore would be a way for a contributor to
     * publish content that the PATCH route would have refused them.
     */
    const revision = await getRevision(taproot.db.db, revisionId);
    if (!revision) return apiError(404, 'Revision not found.');
    if (revision.status === 'published' && !canPublishContent(user)) {
      return apiError(
        403,
        'That revision was published, and restoring it would publish this item. ' +
          'Publishing requires the editor role or higher.',
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
