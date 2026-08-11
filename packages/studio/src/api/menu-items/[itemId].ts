import {
  deleteMenuItem,
  getMenu,
  getMenuItem,
  menuTag,
  updateMenuItem,
  type MenuTargetType,
} from '@taprootcms/core';
import type { Kysely } from 'kysely';
import type { Database } from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, noContent } from '../_shared.js';

/**
 * The tag for the menu this item belongs to.
 *
 * A menu item stores `menu_id` and a cache tag is spelled with the menu's `api_id`, so reaching one
 * from the other is a second read. Worth it: the alternative is purging `SITE_TAG` and handing the
 * whole site a cold cache every time somebody edits a nav link, and these routes are admin-only
 * writes where one extra indexed lookup is not the cost that matters.
 *
 * Returns an empty list rather than throwing when the row has gone — a purge is maintenance, and
 * failing a write because its cache tag could not be resolved would be exactly backwards.
 */
async function menuTagsForItem(db: Kysely<Database>, itemId: string): Promise<string[]> {
  const item = await getMenuItem(db, itemId);
  if (!item) return [];
  const menu = await getMenu(db, item.menu_id);
  return menu ? [menuTag(menu.api_id)] : [];
}

const patchSchema = z.object({
  targetType: z.enum(['item', 'term', 'url']).optional(),
  label: z.string().max(120).nullish(),
  contentItemId: z.string().nullish(),
  termId: z.string().nullish(),
  url: z.string().max(2000).nullish(),
  parentId: z.string().nullish(),
  openInNewTab: z.boolean().optional(),
  noFollow: z.boolean().optional(),
});

/**
 * Read a checkbox on a **patch**, where absent is ambiguous and a bare `!== null` is a bug.
 *
 * An unticked checkbox is simply not posted, so on a create — where every field is being set at
 * once — presence *is* the value and `form.get(name) !== null` is correct. A patch cannot use that:
 * absent means either "the editor unticked it" or "this form never offered the control", and those
 * must not collapse. They did here. `openInNewTab: form.get('openInNewTab') !== null` sat on this
 * route while the admin rendered no such checkbox anywhere, so any form POST would have cleared a
 * flag set through the API — latent only because nothing renders a form against this route yet, and
 * armed the moment somebody adds the no-JS edit row the docblock below promises.
 *
 * A hidden marker beside each checkbox disambiguates: it is present exactly when the form rendered
 * the control, so no marker means "leave it alone" and a marker with no checkbox means "unticked".
 * The alternative idiom — a hidden `value="0"` sharing the checkbox's name, reading the last of
 * `getAll` — needs no second name and is a trick, and this file would have to explain it anyway.
 */
function patchFlag(form: FormData, name: string): boolean | undefined {
  return form.get(`${name}_present`) === null ? undefined : form.get(name) !== null;
}

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

    // Resolved up front because the delete branch below destroys the row the lookup walks through.
    const tags = await menuTagsForItem(taproot.db.db, itemId);

    try {
      if (form.get('_method') === 'delete') {
        await deleteMenuItem(taproot.db.db, itemId);
        taproot.invalidate(tags);
        return back({ deleted: '1' });
      }

      const parsed = patchSchema.safeParse({
        targetType: (form.get('targetType') as MenuTargetType | null) ?? undefined,
        label: (form.get('label') as string | null) ?? undefined,
        contentItemId: (form.get('contentItemId') as string | null) || null,
        termId: (form.get('termId') as string | null) || null,
        url: (form.get('url') as string | null) || null,
        parentId: (form.get('parentId') as string | null) || null,
        openInNewTab: patchFlag(form, 'openInNewTab'),
        noFollow: patchFlag(form, 'noFollow'),
      });

      if (!parsed.success) {
        return back({ error: parsed.error.issues[0]?.message ?? 'That item could not be saved.' });
      }

      await updateMenuItem(taproot.db, itemId, parsed.data);
      taproot.invalidate(tags);
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
    const itemId = context.params.itemId!;

    // Before the write: `parentId` can move an item between menus, and the menu it is *leaving*
    // has a cached response that has to drop too.
    const tags = await menuTagsForItem(taproot.db.db, itemId);

    const item = await updateMenuItem(taproot.db, itemId, input);
    taproot.invalidate([...tags, ...(await menuTagsForItem(taproot.db.db, itemId))]);

    return json({ item });
  },
  { role: 'admin' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    const itemId = context.params.itemId!;
    const tags = await menuTagsForItem(taproot.db.db, itemId);

    await deleteMenuItem(taproot.db.db, itemId);
    taproot.invalidate(tags);

    return noContent();
  },
  { role: 'admin' },
);
