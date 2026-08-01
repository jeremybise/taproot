import { getStagedItem, unstageItem, updateStagedItem } from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, noContent, readJson } from '../../../_shared.js';
import { seoSchema } from '../../../seoSchema.js';

export const GET = handle(async ({ context, taproot }) => {
  const staged = await getStagedItem(
    taproot.db.db,
    context.params.id!,
    context.params.itemId!,
  );
  if (!staged) return apiError(404, 'That item is not in this release.');
  return json({ staged });
});

const patchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  slug: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  // Written out rather than derived with `.partial()`, which does not strip a `.default()` and
  // would send `{}` on every request that omitted the key — wiping stored SEO overrides. That
  // exact bug has already cost a real one here.
  seo: seoSchema.optional(),
});

/**
 * Edit the version waiting inside a release.
 *
 * This is where the item editor posts when it is opened in release mode, and the live page is
 * untouched by it. `status` is deliberately not accepted: a release publishes what is in it, so
 * "what status will this end up in" is answered by the release rather than per item — and accepting
 * one here would be a way to move an item's status without going through `canChangeStatus`.
 */
export const PATCH = handle(
  async ({ context, taproot }) => {
    const input = await readJson(context.request, patchSchema);

    const staged = await updateStagedItem(
      taproot.db.db,
      context.params.id!,
      context.params.itemId!,
      input,
    );

    return json({ staged });
  },
  { role: 'contributor' },
);

export const DELETE = handle(
  async ({ context, taproot, user }) => {
    await unstageItem(taproot.db.db, context.params.id!, context.params.itemId!, { actor: user });
    return noContent();
  },
  { role: 'contributor' },
);
