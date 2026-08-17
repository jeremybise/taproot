import { duplicateSubtree, getItem } from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, readJson } from '../../_shared.js';

/**
 * Copy an item and everything beneath it, as drafts.
 *
 * How a versioned section rolls over: duplicate `/handbook/2026-27` to `/handbook/2027-28`, edit the
 * copy, publish it. Freezing last year is then structural — the old pages are different rows, so
 * nothing done to the copy can reach them.
 *
 * **Chunked, and the caller loops.** A large subtree can be hundreds of items and each is its own batch, so one
 * request cannot finish inside a Worker's budget. `remaining` is what a progress UI reads and what
 * a script tests; calling again resumes, because an item counts as copied when something exists at
 * its mapped path — no job table, no cleanup after a failure.
 *
 * **Contributor**, matching `createItem`: everything this writes is a draft, which reaches nobody.
 * Publishing the copy afterwards is a separate act and still costs editor, one item at a time or
 * through the bulk endpoint.
 */
const schema = z.object({
  slug: z.string().max(120).optional(),
  title: z.string().max(300).optional(),
  parentId: z.string().nullish(),
  /** Items to write before returning. The admin sends a small number and calls again. */
  limit: z.number().int().positive().max(200).optional(),
});

export const POST = handle(
  async ({ context, taproot, user }) => {
    const id = context.params.id!;
    const source = await getItem(taproot.db.db, id);
    if (!source) return apiError(404, 'Content item not found.');

    const isForm = (context.request.headers.get('content-type') ?? '').includes('form');

    let input: z.infer<typeof schema> = {};
    if (isForm) {
      const form = await context.request.formData();
      const slug = form.get('slug');
      const title = form.get('title');
      input = {
        slug: typeof slug === 'string' && slug ? slug : undefined,
        title: typeof title === 'string' && title ? title : undefined,
        limit: 25,
      };
    } else {
      // Throws `ZodError`, which `handle` turns into a 400 with the field errors grouped.
      input = await readJson(context.request, schema);
    }

    try {
      const result = await duplicateSubtree(taproot.db, id, {
        ...input,
        userId: user?.id ?? null,
      });

      /**
       * No purge and no webhooks, deliberately.
       *
       * Every row written is a draft, so nothing a visitor or a cached page can see has changed —
       * purging would flush the site to reflect content that is not on it. The meaningful event is
       * the *publish* that follows, and that goes through the ordinary path where it is announced
       * once per item with a status transition attached. Announcing 280 draft creations instead
       * would bury it.
       */

      if (isForm) {
        const params = new URLSearchParams({
          copied: String(result.created),
          remaining: String(result.remaining),
        });
        return context.redirect(`/admin/content/${result.root.id}?${params}`, 303);
      }

      return json(result);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'invalid_target') return apiError(422, (error as Error).message);
      if (code === 'not_found') return apiError(404, (error as Error).message);
      throw error;
    }
  },
  { role: 'contributor' },
);
