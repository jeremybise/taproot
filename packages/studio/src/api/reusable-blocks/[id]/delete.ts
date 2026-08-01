import { deleteReusableBlock, getReusableBlock, ReusableBlockError } from '@taprootcms/core';

import { apiError, handle } from '../../_shared.js';

/**
 * Delete from a plain HTML form, so the library screen needs no JavaScript for it.
 *
 * A separate route from the JSON `DELETE /reusable-blocks/:id` rather than teaching that one to
 * answer with a redirect: the two differ in what a failure looks like, and a handler branching on
 * `accept` has already grown three of those branches elsewhere in this API.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const id = context.params.id!;
    const block = await getReusableBlock(taproot.db.db, id);
    if (!block) return apiError(404, 'Reusable block not found.');

    try {
      await deleteReusableBlock(taproot.db.db, id);
    } catch (cause) {
      // Back to the entry rather than the list: the reason it was refused is the usage list, and
      // that is on the entry's own screen.
      const message =
        cause instanceof ReusableBlockError ? cause.message : 'Could not delete that block.';
      return context.redirect(`/admin/blocks/${id}?error=${encodeURIComponent(message)}`, 303);
    }

    return context.redirect(`/admin/blocks?deleted=${encodeURIComponent(block.name)}`, 303);
  },
  { role: 'editor' },
);
