import {
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

    return json({ reusableBlock: updated });
  },
  { role: 'editor' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    await deleteReusableBlock(taproot.db.db, context.params.id!);
    return noContent();
  },
  { role: 'editor' },
);
