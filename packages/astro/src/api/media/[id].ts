import { now } from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json, noContent, readJson } from '../_shared.js';

const patchSchema = z.object({
  alt_text: z.string().max(500).nullish(),
  title: z.string().max(300).nullish(),
  // Hotspot and crop are normalised 0-1 so they stay independent of any rendered size.
  // The editor UI for these arrives as a Phase 1 fast-follow; the data model is ready now.
  hotspot_x: z.number().min(0).max(1).nullish(),
  hotspot_y: z.number().min(0).max(1).nullish(),
  crop_top: z.number().min(0).max(1).nullish(),
  crop_right: z.number().min(0).max(1).nullish(),
  crop_bottom: z.number().min(0).max(1).nullish(),
  crop_left: z.number().min(0).max(1).nullish(),
});

export const PATCH = handle(
  async ({ context, taproot }) => {
    const input = await readJson(context.request, patchSchema);

    const updated = await taproot.db.db
      .updateTable('media')
      .set({ ...input, updated_at: now() })
      .where('id', '=', context.params.id!)
      .executeTakeFirst();

    if (Number(updated.numUpdatedRows ?? 0) === 0) {
      return apiError(404, 'Media asset not found.');
    }

    return json({ ok: true });
  },
  { role: 'contributor' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    const asset = await taproot.db.db
      .selectFrom('media')
      .select('storage_key')
      .where('id', '=', context.params.id!)
      .executeTakeFirst();

    if (!asset) return apiError(404, 'Media asset not found.');

    // Remove the row first: a stored object with no row is invisible clutter, whereas a row
    // pointing at a deleted object renders as a broken image on the live site.
    await taproot.db.db.deleteFrom('media').where('id', '=', context.params.id!).execute();
    await taproot.storage.delete(asset.storage_key);

    return noContent();
  },
  { role: 'editor' },
);
