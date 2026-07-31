import { deleteItem, getContentType, getItem, updateItem } from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json, noContent, readJson } from '../_shared.js';
import { seoSchema } from '../seoSchema.js';
import { canChangeStatus } from '../../runtime/guards.js';

export const GET = handle(async ({ context, taproot }) => {
  const item = await getItem(taproot.db.db, context.params.id!);
  if (!item) return apiError(404, 'Content item not found.');
  return json({ item });
});

const patchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  slug: z.string().optional(),
  parentId: z.string().nullish(),
  status: z.enum(['draft', 'in_review', 'scheduled', 'published', 'archived']).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  // Written explicitly as `.optional()` on the shared schema rather than derived with
  // `.partial()`, which does not strip a `.default()` and would send `{}` on every request that
  // omitted the key — wiping any stored SEO overrides. That exact bug has already cost a real one
  // here with field config.
  seo: seoSchema.optional(),
});

export const PATCH = handle(
  async ({ context, taproot, user }) => {
    const input = await readJson(context.request, patchSchema);

    const existing = await getItem(taproot.db.db, context.params.id!);
    if (!existing) return apiError(404, 'Content item not found.');

    const contentType = await getContentType(taproot.db.db, existing.content_type_id);
    if (!contentType) return apiError(404, 'Content type not found.');

    /**
     * The previous status matters as much as the new one: moving *off* `published` unpublishes,
     * which is an editor's call even though the status being moved to is only a draft.
     */
    if (!canChangeStatus(user, existing.status, input.status)) {
      return apiError(
        403,
        'Changing this item to or from a published status requires the editor role or higher.',
      );
    }

    const item = await updateItem(taproot.db, contentType, contentType.fields, existing.id, {
      title: input.title,
      slug: input.slug,
      parentId: input.parentId,
      status: input.status,
      data: input.data,
      seo: input.seo,
      userId: user.id,
    });

    return json({ item });
  },
  { role: 'contributor' },
);

/**
 * POST carries the delete, because an HTML form can only GET or POST.
 *
 * Same shape as the content-type delete: `_method=delete` keeps it working without JavaScript, and
 * the typed confirmation is checked here rather than by disabling a submit button, which turning
 * JavaScript off would bypass.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const id = context.params.id!;
    const item = await getItem(taproot.db.db, id);
    if (!item) return apiError(404, 'Content item not found.');

    const form = await context.request.formData();
    if (form.get('_method') !== 'delete') return apiError(400, 'Unsupported form action.');

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/content/${id}?${new URLSearchParams(params)}`, 303);

    if (String(form.get('confirm') ?? '').trim() !== item.slug) {
      return back({ error: `Type ${item.slug} exactly to confirm. Nothing was deleted.` });
    }

    try {
      await deleteItem(taproot.db, id);
    } catch (error) {
      return back({
        error: error instanceof Error ? error.message : 'Could not delete that item.',
      });
    }

    /**
     * Back to the item's own type rather than to "All content".
     *
     * The list they were working in is the one that should now be missing a row; sending them
     * somewhere else makes them find their way back to check.
     */
    const contentType = await getContentType(taproot.db.db, item.content_type_id);
    const destination = contentType ? `/admin/content/type/${contentType.api_id}` : '/admin/content';

    return context.redirect(
      `${destination}?${new URLSearchParams({ deleted: item.title })}`,
      303,
    );
  },
  { role: 'editor' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    try {
      await deleteItem(taproot.db, context.params.id!);
    } catch (error) {
      // The guard lives in core so this route and the admin screen cannot disagree about whether
      // a delete would succeed. Surfaced as 409 rather than 500: the request was well-formed and
      // the refusal is about state, not about the request.
      return apiError(409, error instanceof Error ? error.message : 'Could not delete that item.');
    }
    return noContent();
  },
  { role: 'editor' },
);
