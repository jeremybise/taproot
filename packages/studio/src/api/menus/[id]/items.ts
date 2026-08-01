import { createMenuItem, getMenu, type MenuTargetType } from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json } from '../../_shared.js';

const createSchema = z.object({
  targetType: z.enum(['item', 'term', 'url']),
  label: z.string().max(120).nullish(),
  contentItemId: z.string().nullish(),
  termId: z.string().nullish(),
  url: z.string().max(2000).nullish(),
  parentId: z.string().nullish(),
  openInNewTab: z.boolean().default(false),
});

/**
 * Add an item to a menu.
 *
 * The form posts one set of fields for all three target kinds and lets the service decide which
 * matters, rather than three endpoints — the shape of a menu item does not differ by target, only
 * which column it fills.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const menuId = context.params.id!;
    const menu = await getMenu(taproot.db.db, menuId);
    if (!menu) return apiError(404, 'Menu not found.');

    const isForm = !(context.request.headers.get('content-type') ?? '').includes('application/json');

    const raw = isForm
      ? await (async () => {
          const form = await context.request.formData();
          return {
            targetType: String(form.get('targetType') ?? '') as MenuTargetType,
            label: (form.get('label') as string | null) || null,
            // Empty strings from unused inputs must read as absent, not as a chosen empty target.
            contentItemId: (form.get('contentItemId') as string | null) || null,
            termId: (form.get('termId') as string | null) || null,
            url: (form.get('url') as string | null) || null,
            parentId: (form.get('parentId') as string | null) || null,
            openInNewTab: form.get('openInNewTab') !== null,
          };
        })()
      : ((await context.request.json()) as Record<string, unknown>);

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/menus/${menuId}?${new URLSearchParams(params)}`, 303);

    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'That menu item could not be added.';
      return isForm ? back({ error: message }) : apiError(422, message);
    }

    // An invalid target — no page chosen, a javascript: URL — throws, and a browser following a
    // form post needs the message rather than a JSON body.
    if (isForm) {
      try {
        await createMenuItem(taproot.db.db, menuId, parsed.data);
        return back({ added: '1' });
      } catch (error) {
        return back({ error: error instanceof Error ? error.message : 'Could not add that item.' });
      }
    }

    return json(
      { item: await createMenuItem(taproot.db.db, menuId, parsed.data) },
      { status: 201 },
    );
  },
  { role: 'admin' },
);
