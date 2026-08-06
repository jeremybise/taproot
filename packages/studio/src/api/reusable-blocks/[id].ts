import {
  blockTag,
  blockTypeRegistry,
  deleteReusableBlock,
  getReusableBlock,
  updateReusableBlock,
} from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, noContent, readJson } from '../_shared.js';

export const GET = handle(async ({ context, taproot }) => {
  const block = await getReusableBlock(taproot.db.db, context.params.id!);
  if (!block) return apiError(404, 'Reusable block not found.');
  return json({ reusableBlock: block });
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).nullish(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Edit a library entry.
 *
 * `block_type` is deliberately not patchable: the data is that type's shape, so changing it would
 * reinterpret every field on every page referencing the entry. Delete and re-create instead, which
 * the deletion guard forces you to notice.
 */
export const PATCH = handle(
  async ({ context, taproot }) => {
    const input = await readJson(context.request, patchSchema);

    const existing = await getReusableBlock(taproot.db.db, context.params.id!);
    if (!existing) return apiError(404, 'Reusable block not found.');

    const registry = await blockTypeRegistry(taproot.db.db);
    const blockType = registry.get(existing.block_type);
    if (!blockType) return apiError(409, `Block type "${existing.block_type}" no longer exists.`);

    const updated = await updateReusableBlock(
      taproot.db.db,
      blockType.fields,
      existing.id,
      input,
    );

    /**
     * The one invalidation with no backstop behind it.
     *
     * Every other write moves a content item's `updated_at`, so a stale copy is caught by the ETag
     * on the next revalidation even if the purge never lands. A library edit touches no referencing
     * row at all — and a 304 *renews* a cached copy's freshness, so an unchanging validator is not
     * bounded by `s-maxage`, it is unbounded. `deliveryCache` folds the library's own stamp into the
     * ETag for exactly that reason; this purge is what makes the change visible immediately rather
     * than at the next revalidation.
     */
    taproot.invalidate([blockTag(updated.id)]);

    return json({ reusableBlock: updated });
  },
  { role: 'editor' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    const id = context.params.id!;
    await deleteReusableBlock(taproot.db.db, id);

    // `deleteReusableBlock` refuses while anything still references it, so nothing here can strand a
    // page — but the library screens are cached too, and the entry has to leave them.
    taproot.invalidate([blockTag(id)]);

    return noContent();
  },
  { role: 'editor' },
);
