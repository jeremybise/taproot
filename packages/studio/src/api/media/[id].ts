import { now } from '@taprootcms/core';
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

/**
 * POST carries the delete, because an HTML form can only GET or POST.
 *
 * Same shape as the content-type and content-item deletes — see `content-types/[id].ts`.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const id = context.params.id!;
    const asset = await taproot.db.db
      .selectFrom('media')
      .select(['id', 'filename', 'storage_key'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!asset) return apiError(404, 'Media asset not found.');

    const form = await context.request.formData();
    if (form.get('_method') !== 'delete') return apiError(400, 'Unsupported form action.');

    if (String(form.get('confirm') ?? '').trim() !== asset.filename) {
      return context.redirect(
        `/admin/media/${id}?${new URLSearchParams({
          error: `Type ${asset.filename} exactly to confirm. Nothing was deleted.`,
        })}`,
        303,
      );
    }

    // Row first: a stored object with no row is invisible clutter, whereas a row pointing at a
    // deleted object renders as a broken image on the live site.
    await taproot.db.db.deleteFrom('media').where('id', '=', id).execute();
    await taproot.storage.delete(asset.storage_key);

    return context.redirect(
      `/admin/media?${new URLSearchParams({ deleted: asset.filename })}`,
      303,
    );
  },
  { role: 'editor' },
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
