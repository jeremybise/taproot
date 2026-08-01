import { getContentType, getItem, listRevisions, revisionChanges } from '@taprootcms/core';

import { apiError, handle, json } from '../../_shared.js';

/**
 * An item's revision history, newest first.
 *
 * Each entry carries the list of things that changed relative to the revision *below* it, computed
 * here rather than in the browser: the field labels needed to describe a change live on the content
 * type, and shipping the whole type definition to the client just to render a history list would be
 * a lot of payload for a panel most editors never open.
 */
export const GET = handle(async ({ context, taproot }) => {
  const url = new URL(context.request.url);
  const itemId = context.params.id!;

  const item = await getItem(taproot.db.db, itemId);
  if (!item) return apiError(404, 'Content item not found.');

  const contentType = await getContentType(taproot.db.db, item.content_type_id);
  if (!contentType) return apiError(404, 'Content type not found.');

  const { revisions, total } = await listRevisions(taproot.db.db, itemId, {
    limit: Math.min(Number(url.searchParams.get('limit') ?? 50), 200),
    offset: Number(url.searchParams.get('offset') ?? 0),
  });

  return json({
    total,
    revisions: revisions.map((revision, index) => ({
      ...revision,
      // The next entry in a newest-first list is the older one, so it is the predecessor to diff
      // against. The oldest revision on the page has none, and reports no changes.
      changes: revisionChanges(revisions[index + 1], revision, contentType.fields),
    })),
  });
});
