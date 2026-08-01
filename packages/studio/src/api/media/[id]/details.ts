import { now } from '@taproot/core';

import { apiError, formValue, handle } from '../../_shared.js';

/**
 * Alt text and title, posted from a plain HTML form.
 *
 * Separate from the JSON `PATCH /media/:id` rather than teaching that route to parse form bodies:
 * the two differ in what they accept, what they return, and what a failure looks like, and a single
 * handler branching on content-type had already grown three of those branches elsewhere.
 *
 * Alt text is the one field here that is not a nicety — it is what the accessibility checker reads,
 * and what a screen reader announces for every use of the image.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const id = context.params.id!;
    const form = await context.request.formData();

    /**
     * Decorative wins over whatever is in the alt box, and is stored as `''`.
     *
     * The two cannot both be honoured — an image is either described or declared not to need
     * describing — so the explicit statement is the one that counts, and the form says as much
     * beside the box. Deciding it here rather than in the browser is what makes the rule true for
     * every client, which is the same reason richtext is sanitised on the server.
     */
    const decorative = form.get('decorative') !== null;
    const altText = decorative ? '' : formValue(form, 'alt_text');

    const updated = await taproot.db.db
      .updateTable('media')
      .set({ alt_text: altText, title: formValue(form, 'title'), updated_at: now() })
      .where('id', '=', id)
      .executeTakeFirst();

    if (Number(updated.numUpdatedRows ?? 0) === 0) {
      return apiError(404, 'Media asset not found.');
    }

    return context.redirect(`/admin/media/${id}?saved=1`, 303);
  },
  { role: 'contributor' },
);
