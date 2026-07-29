import { deleteTerm, getTerm, updateTerm } from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json, noContent } from '../_shared.js';

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().max(120).optional(),
  parentId: z.string().nullish(),
  description: z.string().max(500).nullish(),
});

/**
 * PATCH and DELETE both accept a form post, because HTML forms can only GET or POST.
 *
 * The term editor sends `_method=delete` on a POST rather than using fetch, so the whole screen
 * keeps working without JavaScript — the same reason the admin is server-rendered at all.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const termId = context.params.termId!;
    const term = await getTerm(taproot.db.db, termId);
    if (!term) return apiError(404, 'Term not found.');

    const form = await context.request.formData();
    const back = (params: Record<string, string>) =>
      context.redirect(
        `/admin/taxonomies/${term.taxonomy_id}?${new URLSearchParams(params)}`,
        303,
      );

    // A cycle or a cross-taxonomy parent throws, and this branch is followed by a browser, so the
    // message has to come back as a redirect rather than the shared handler's JSON error body.
    try {
      if (form.get('_method') === 'delete') {
        await deleteTerm(taproot.db, termId);
        return back({ deleted: term.name });
      }

      const parsed = patchSchema.safeParse({
        name: form.get('name') ?? undefined,
        slug: form.get('slug') ?? undefined,
        parentId: form.get('parentId') || null,
        description: form.get('description') ?? undefined,
      });

      if (!parsed.success) {
        return back({ error: parsed.error.issues[0]?.message ?? 'That term could not be saved.' });
      }

      await updateTerm(taproot.db, termId, parsed.data);
      return back({ updated: parsed.data.name ?? term.name });
    } catch (error) {
      return back({ error: error instanceof Error ? error.message : 'Could not save that term.' });
    }
  },
  { role: 'editor' },
);

export const PATCH = handle(
  async ({ context, taproot }) => {
    const input = patchSchema.parse(await context.request.json());
    const term = await updateTerm(taproot.db, context.params.termId!, input);
    return json({ term });
  },
  { role: 'editor' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    await deleteTerm(taproot.db, context.params.termId!);
    return noContent();
  },
  { role: 'editor' },
);
