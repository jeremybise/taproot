import { now } from '@taproot/core';

import { apiError, handle } from '../../_shared.js';

/**
 * Alt text and title, posted from a plain HTML form.
 *
 * Separate from the JSON `PATCH /media/:id` rather than teaching that route to parse form bodies:
 * the two differ in what they accept, what they return, and what a failure looks like, and a single
 * handler branching on content-type had already grown three of those branches elsewhere.
 *
 * Alt text is the one field here that is not a nicety — it is what the Phase 4 accessibility
 * checker reads, and what a screen reader announces for every use of the image.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const id = context.params.id!;
    const form = await context.request.formData();

    const value = (key: string): string | null => {
      const raw = form.get(key);
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      return trimmed === '' ? null : trimmed;
    };

    const updated = await taproot.db.db
      .updateTable('media')
      .set({ alt_text: value('alt_text'), title: value('title'), updated_at: now() })
      .where('id', '=', id)
      .executeTakeFirst();

    if (Number(updated.numUpdatedRows ?? 0) === 0) {
      return apiError(404, 'Media asset not found.');
    }

    return context.redirect(`/admin/media/${id}?saved=1`, 303);
  },
  { role: 'contributor' },
);
