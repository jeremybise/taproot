import {
  SITE_TAG,
  getItem,
  itemWebhookSubjects,
  publicationEvents,
  updateSubtree,
} from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, readJson } from '../../_shared.js';
import { canChangeStatus } from '../../../runtime/guards.js';

/**
 * Apply a status and/or `noIndex` to everything under an item.
 *
 * Superseding a catalog year: ~280 pages want unpublishing, or want to stop competing with the new
 * edition in search while staying readable — students hold rights to the year they entered under, so
 * those are genuinely different intentions and both are offered.
 *
 * **Contributor, with the permission decided per item.** The role on the route cannot answer this:
 * a branch part published and part draft holds several different transitions, and which of them
 * this person may make depends on each item's current status. `canChangeStatus` is handed down as a
 * callback and refusals come back named, so somebody moving 280 items moves the 277 they may and is
 * told about the three they may not — rather than the whole batch failing on one.
 *
 * Chunked like the duplicate endpoint, and for the same reason.
 */
const schema = z.object({
  status: z.enum(['draft', 'in_review', 'scheduled', 'published', 'archived']).optional(),
  noIndex: z.boolean().optional(),
  includeRoot: z.boolean().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export const POST = handle(
  async ({ context, taproot, user }) => {
    const id = context.params.id!;
    const root = await getItem(taproot.db.db, id);
    if (!root) return apiError(404, 'Content item not found.');

    const isForm = (context.request.headers.get('content-type') ?? '').includes('form');

    let input: z.infer<typeof schema>;
    if (isForm) {
      const form = await context.request.formData();
      const status = form.get('status');
      const noIndex = form.get('noIndex');
      input = {
        status: typeof status === 'string' && status ? (status as never) : undefined,
        // A checkbox that is not posted means unticked, which here means "clear it" rather than
        // "leave it alone" — the form always offers the control, so absence is a real answer.
        noIndex: form.has('setNoIndex') ? noIndex === 'on' || noIndex === '1' : undefined,
        includeRoot: form.get('includeRoot') !== null,
        limit: 25,
      };
    } else {
      // Throws `ZodError`, which `handle` turns into a 400 with the field errors grouped.
      input = await readJson(context.request, schema);
    }

    try {
      const result = await updateSubtree(taproot.db, id, {
        ...input,
        userId: user?.id ?? null,
        canChange: (from, to) => canChangeStatus(user, from, to),
      });

      /**
       * A coarse purge, for `publishRelease`'s reason.
       *
       * This is the other operation whose entire purpose is that many pages change at once, and
       * "which pages did this affect" is honestly answered by "assume all of them". Precise tags
       * would need the content type of every changed item — a second query per item, on the one
       * path most likely to be handling hundreds. Safe because a bulk subtree change is rare and
       * deliberate, which is exactly why `itemWriteTags` stays precise for an ordinary save.
       */
      if (result.changed > 0) taproot.invalidate([SITE_TAG]);

      /**
       * Per-item events, following `publishRelease`.
       *
       * A cache can assume all of them; a receiver cannot — an event names the item it is about, so
       * a search index taking 280 pages off the site needs to be told which 280. Only emitted for a
       * status change: setting `noIndex` alone changes a field like any other save, and the item's
       * own PATCH route is where that is announced.
       */
      if (input.status && result.changed > 0) {
        const subjects = await itemWebhookSubjects(taproot.db.db, [...result.touched.keys()]);
        for (const [itemId, from] of result.touched) {
          const subject = subjects.get(itemId);
          if (!subject) continue;

          const withPrevious = { ...subject, previousStatus: from };
          taproot.emit({ event: 'item.updated', subject: withPrevious });
          for (const event of publicationEvents(from, input.status)) {
            taproot.emit({ event, subject: withPrevious });
          }
        }
      }

      if (isForm) {
        const params = new URLSearchParams({
          changed: String(result.changed),
          remaining: String(result.remaining),
        });
        if (result.refused.length > 0) params.set('refused', String(result.refused.length));
        return context.redirect(`/admin/content/${id}?${params}`, 303);
      }

      return json(result);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'nothing_to_do') return apiError(400, (error as Error).message);
      if (code === 'not_found') return apiError(404, (error as Error).message);
      throw error;
    }
  },
  { role: 'contributor' },
);
