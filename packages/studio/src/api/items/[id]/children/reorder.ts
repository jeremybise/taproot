import {
  getChildren,
  getContentType,
  getItem,
  itemTag,
  normalizeCacheTags,
  recordAuditEntry,
  reorderSiblings,
  typeTag,
} from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, readJson } from '../../../_shared.js';

/**
 * Put one item's children in a new order.
 *
 * `position` is what `resolveDelivery` hands a consumer as an item's children — the order a site's
 * sub-navigation and any "pages in this section" listing come out in. Until this route existed it was
 * written once by `createItem` and never again, so that order was permanently the order somebody
 * happened to create the pages in.
 *
 * **The parent is in the path, not the body**, following `menus/[id]/reorder`: an order is only
 * meaningful within one sibling group, so naming the group is naming the parent. `reorderSiblings`
 * requires the ids to be exactly that parent's children and refuses anything else — see the reasons
 * there, of which the sharpest is that a stale list from a second editor's screen is caught rather
 * than applied.
 *
 * **Contributor**, matching `PATCH /items/[id]`. Reordering is an edit to content somebody may
 * already edit one item at a time, and it is not a status change — nothing becomes visible that was
 * not visible before, so `canChangeStatus` has nothing to say about it.
 *
 * Root-level items have no parent id to put in a path and are therefore unreachable here. `core`'s
 * `reorderSiblings` accepts `null` and handles them, so the limit is this route's shape rather than
 * the capability's — a top-level reorder wants a screen that does not exist yet.
 */
const schema = z.object({
  /** The parent's children, all of them, in their new order. */
  orderedIds: z.array(z.string()).min(1),
});

export const POST = handle(
  async ({ context, taproot, user }) => {
    const parentId = context.params.id!;

    const parent = await getItem(taproot.db.db, parentId);
    if (!parent) return apiError(404, 'Content item not found.');

    const { orderedIds } = await readJson(context.request, schema);

    /**
     * The children are read before the write as well as inside it.
     *
     * `reorderSiblings` reads them to validate, so this looks like a duplicate query — it is not.
     * The tags below need each child's *content type*, which the write path has no reason to load,
     * and a purge naming the wrong types is the failure this repository documents as the expensive
     * one: it succeeds, reports success, and clears nothing.
     */
    const children = await getChildren(taproot.db.db, parentId);

    await reorderSiblings(taproot.db, parentId, orderedIds);

    /**
     * `item:` for the parent, `type:` for every type among its children.
     *
     * The parent's own delivery response carries these children in this order, so it is stale.
     * `type:` is what reaches the rest: any listing showing these items is tagged by type rather
     * than by the items it happened to match, so a reorder that changed which of them a capped
     * listing returns is covered. The children's own pages are *not* tagged individually — nothing
     * about an item's own payload changes when its position does.
     */
    const typeIds = [...new Set(children.map((child) => child.content_type_id))];
    const types = await Promise.all(
      typeIds.map((id) => getContentType(taproot.db.db, id)),
    );

    taproot.invalidate(
      normalizeCacheTags([
        itemTag(parentId),
        ...types.flatMap((type) => (type ? [typeTag(type.api_id)] : [])),
      ]),
    );

    await recordAuditEntry(taproot.db.db, {
      actor: user,
      action: 'item.reorder_children',
      subjectType: 'item',
      subjectId: parentId,
      subjectLabel: parent.title,
      detail: { count: orderedIds.length },
    });

    return json({ ok: true });
  },
  { role: 'contributor' },
);
