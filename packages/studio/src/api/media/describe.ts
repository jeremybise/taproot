import { now } from '@taprootcms/core';

import { apiError, formValue, handle } from '../_shared.js';

/**
 * Save alt text for several assets at once.
 *
 * The three states are the whole of this endpoint, and getting any of them wrong is silent:
 *
 * - **A filled box** is a description. Stored as typed.
 * - **The Decorative checkbox** is the only thing that writes `''` — "somebody decided this image
 *   carries no information of its own". A screen reader skips it, which is right for a divider and
 *   wrong for a photograph, so it has to be a deliberate act rather than a default.
 * - **A blank box with the checkbox clear** is `null` — "nobody has said". It is what an untouched
 *   row means, and the reason a grid must never read blank as decorative: an editor who describes
 *   three of twelve images and saves would otherwise mark the other nine as needing no description,
 *   emptying the accessibility report of exactly the images that still need work.
 *
 * ## A filled box wins over the checkbox
 *
 * They can disagree — tick Decorative, then type. Rather than refusing the save, the text wins,
 * because it is the more specific statement and the one that cannot have been left behind by
 * accident: the checkbox may be a leftover from a row that arrived already marked decorative, while
 * nobody types a description they did not mean. The form disables neither control, so this is a
 * rule the server has to hold whatever the browser did.
 *
 * ## Only what the form sent
 *
 * The write is scoped to the `ids` the form carried, so a request cannot reach an asset the screen
 * was not showing. A row whose field is missing from the body is skipped rather than nulled — that
 * is a truncated post, not an editor clearing a description.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const form = await context.request.formData();

    const ids = String(form.get('ids') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    const isBrowserForm = (context.request.headers.get('accept') ?? '').includes('text/html');
    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/media?${new URLSearchParams(params)}`, 303);

    if (ids.length === 0) {
      const message = 'Nothing to save.';
      return isBrowserForm ? back({ error: message }) : apiError(422, message);
    }

    const timestamp = now();
    let saved = 0;

    for (const id of ids) {
      // Absent means the form never carried this row. `formValue` already maps a blank string to
      // null, which is exactly the "nobody has said" state — so the two cases are distinguished
      // before they can be confused: `has` answers "was it on screen", the value answers "what did
      // they type".
      if (!form.has(`alt-${id}`)) continue;

      const typed = formValue(form, `alt-${id}`);
      const decorative = form.get(`decorative-${id}`) !== null;

      // Text beats the checkbox — see above. `null` only survives when neither was given.
      const altText = typed !== null ? typed : decorative ? '' : null;

      await taproot.db.db
        .updateTable('media')
        .set({ alt_text: altText, updated_at: timestamp })
        .where('id', '=', id)
        .execute();

      saved += 1;
    }

    /*
     * Alt text is content a page renders, so a change to it has to clear the caches holding that
     * page — the same reason every other media write purges. `SITE_TAG` rather than something
     * narrower for the reason stated there: a media id lives inside `content_items.data`, so there
     * is no reverse index from an asset to the items placing it without a scan.
     */
    taproot.invalidate(['site']);

    if (isBrowserForm) {
      // Back to the queue rather than to the library, because the report's way in is a backlog and
      // the next screenful is the next thing to do. With no ids left undescribed it renders its own
      // empty state, which is the confirmation that the queue is clear.
      return context.redirect(`/admin/media/describe?saved=${saved}`, 303);
    }

    return new Response(JSON.stringify({ saved }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
  { role: 'contributor' },
);
