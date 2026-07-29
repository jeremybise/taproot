import { blockTypeRegistry, createReusableBlock, listReusableBlocks } from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json, readJson } from '../_shared.js';

export const GET = handle(async ({ context, taproot }) => {
  const blockType = new URL(context.request.url).searchParams.get('blockType') ?? undefined;
  return json({ reusableBlocks: await listReusableBlocks(taproot.db.db, { blockType }) });
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).nullish(),
  /** The block type's `api_id`, matching how block instances name their type. */
  blockType: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Promote a block into the library.
 *
 * `editor` rather than `contributor`: a reusable block's content appears on every page that
 * references it, so creating one is a decision with a wider blast radius than editing a single
 * page — the same reasoning that puts publishing above drafting.
 */
export const POST = handle(
  async ({ context, taproot, user }) => {
    const input = await readJson(context.request, createSchema);

    const registry = await blockTypeRegistry(taproot.db.db);
    const blockType = registry.get(input.blockType);
    if (!blockType) return apiError(404, `Unknown block type "${input.blockType}".`);

    const created = await createReusableBlock(taproot.db.db, blockType.fields, {
      name: input.name,
      description: input.description,
      blockType: input.blockType,
      data: input.data,
      userId: user.id,
    });

    return json({ reusableBlock: created }, { status: 201 });
  },
  { role: 'editor' },
);
