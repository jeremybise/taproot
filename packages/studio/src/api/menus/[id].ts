import { deleteMenu, getMenu, menuTag, resolveMenu, updateMenu } from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, noContent, readJson } from '../_shared.js';

/**
 * A menu, resolved into the tree a template would render.
 *
 * `?published=0` keeps entries whose target is a draft or has been deleted, each carrying why —
 * that is the admin's view. The default is the visitor's.
 */
export const GET = handle(async ({ context, taproot }) => {
  const menu = await getMenu(taproot.db.db, context.params.id!);
  if (!menu) return apiError(404, 'Menu not found.');

  const publishedOnly = new URL(context.request.url).searchParams.get('published') !== '0';

  return json({
    menu,
    items: await resolveMenu(taproot.db.db, menu.api_id, { publishedOnly }),
  });
});

const patchSchema = z.strictObject(
  {
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullish(),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? "A menu's API id is fixed after creation, because templates ask for menus by it."
        : undefined,
  },
);

export const PATCH = handle(
  async ({ context, taproot }) => {
    const input = await readJson(context.request, patchSchema);
    const menu = await updateMenu(taproot.db.db, context.params.id!, input);

    /**
     * `menuTag`, not `SITE_TAG`.
     *
     * The only cached response carrying a menu is `/delivery/menu/{apiId}` — a page's own payload
     * does not embed one — so the precise tag clears everything that went stale. Reaching for
     * `SITE_TAG` would give the whole site a cold cache every time somebody renamed a nav link,
     * and a nav restructure is a dozen of these in a row.
     */
    taproot.invalidate([menuTag(menu.api_id)]);

    return json({ menu });
  },
  { role: 'admin' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    // Read before the delete, or the `api_id` the tag is spelled with is already gone — the same
    // ordering `items/[id].ts` uses to keep a deleted item's tags.
    const menu = await getMenu(taproot.db.db, context.params.id!);

    await deleteMenu(taproot.db.db, context.params.id!);
    if (menu) taproot.invalidate([menuTag(menu.api_id)]);

    return noContent();
  },
  { role: 'admin' },
);
