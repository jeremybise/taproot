import { getMenu, listMenuItems, reorderMenuItems } from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json, readJson } from '../../_shared.js';

const schema = z.object({
  /**
   * One sibling group in its new order — not the whole menu.
   *
   * `position` is scoped to a parent, so reordering is inherently per-level. Sending the whole
   * flattened tree would force the server to work out which entries were siblings, which it would
   * have to do by re-reading exactly what the client already knows.
   */
  orderedIds: z.array(z.string()).min(1),
});

export const POST = handle(
  async ({ context, taproot }) => {
    const menuId = context.params.id!;
    const menu = await getMenu(taproot.db.db, menuId);
    if (!menu) return apiError(404, 'Menu not found.');

    const { orderedIds } = await readJson(context.request, schema);

    /**
     * Every id must belong to this menu.
     *
     * Without the check, a caller could pass ids from another menu and have their positions
     * rewritten — the reorder statements themselves only match on id, so nothing downstream would
     * notice.
     */
    const known = new Set((await listMenuItems(taproot.db.db, menuId)).map((entry) => entry.id));
    const foreign = orderedIds.filter((id) => !known.has(id));
    if (foreign.length > 0) {
      return apiError(422, 'That order refers to items which are not in this menu.');
    }

    await reorderMenuItems(taproot.db, orderedIds);
    return json({ ok: true });
  },
  { role: 'admin' },
);
