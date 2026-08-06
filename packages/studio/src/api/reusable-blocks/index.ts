import { blockTypeRegistry, createReusableBlock, listReusableBlocks } from '@taprootcms/core';
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
    /**
     * Two callers, one shape.
     *
     * Promoting a block on a page sends the content it is promoting; the new-entry screen sends
     * content the author has just written into the same editor. Both arrive as JSON with a full
     * `data`, and both are validated here — which they must be, because a page referencing an
     * entry skips field validation on the grounds that the library row already passed it. An
     * "empty entry, fill it in later" path would quietly break that.
     */
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

    /**
     * Deliberately no `invalidate` here, unlike PATCH and DELETE.
     *
     * A `block:` tag is recorded on a delivery response by the pages that *place* the entry, and a
     * just-created one is placed nowhere — so there is no cached response carrying the tag and the
     * purge would clear nothing. Adding it for symmetry is the tempting move and would be the same
     * mistake `SITE_TAG` shipped with: a purge that succeeds, reports success, and does nothing.
     * The page that promoted a block into the library is a separate item write, and that one purges.
     */
    return json({ reusableBlock: created }, { status: 201 });
  },
  { role: 'editor' },
);
