import { deleteMenuItem, getMenuItem, updateMenuItem, type MenuTargetType } from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json, noContent } from '../_shared.js';

const patchSchema = z.object({
  targetType: z.enum(['item', 'term', 'url']).optional(),
  label: z.string().max(120).nullish(),
  contentItemId: z.string().nullish(),
  termId: z.string().nullish(),
  url: z.string().max(2000).nullish(),
  parentId: z.string().nullish(),
  openInNewTab: z.boolean().optional(),
});

/**
 * POST carries both edit and delete, because an HTML form can only GET or POST.
 *
 * `_method=delete` on a POST keeps the menu editor working without JavaScript, the same reason
 * the admin is server-rendered at all.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const itemId = context.params.itemId!;
    const item = await getMenuItem(taproot.db.db, itemId);
    if (!item) return apiError(404, 'Menu item not found.');

    const form = await context.request.formData();
    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/menus/${item.menu_id}?${new URLSearchParams(params)}`, 303);

    try {
      if (form.get('_method') === 'delete') {
        await deleteMenuItem(taproot.db.db, itemId);
        return back({ deleted: '1' });
      }

      const parsed = patchSchema.safeParse({
        targetType: (form.get('targetType') as MenuTargetType | null) ?? undefined,
        label: (form.get('label') as string | null) ?? undefined,
        contentItemId: (form.get('contentItemId') as string | null) || null,
        termId: (form.get('termId') as string | null) || null,
        url: (form.get('url') as string | null) || null,
        parentId: (form.get('parentId') as string | null) || null,
        openInNewTab: form.get('openInNewTab') !== null,
      });

      if (!parsed.success) {
        return back({ error: parsed.error.issues[0]?.message ?? 'That item could not be saved.' });
      }

      await updateMenuItem(taproot.db, itemId, parsed.data);
      return back({ updated: '1' });
    } catch (error) {
      return back({ error: error instanceof Error ? error.message : 'Could not save that item.' });
    }
  },
  { role: 'admin' },
);

export const PATCH = handle(
  async ({ context, taproot }) => {
    const input = patchSchema.parse(await context.request.json());
    return json({ item: await updateMenuItem(taproot.db, context.params.itemId!, input) });
  },
  { role: 'admin' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    await deleteMenuItem(taproot.db.db, context.params.itemId!);
    return noContent();
  },
  { role: 'admin' },
);
