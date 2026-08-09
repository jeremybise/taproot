import { now, SITE_TAG } from '@taprootcms/core';
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

    /**
     * Media was the only entity whose writes purged nothing at all.
     *
     * Every other write route here invalidates — items, content types, fields, menus, reusable
     * blocks, terms, taxonomies, snippets — and this one did not, so moving a focal point updated
     * D1 and cleared no cache: the delivery JSON carrying the old hotspot survived its full
     * `s-maxage` of a day, and the consumer's HTML was never flushed because the purge callback
     * that flushes it never fired. Observed as an edited hotspot that simply did not appear.
     *
     * `SITE_TAG` because there is no reverse index from an asset to the items placing it — a
     * `media` id sits inside `content_items.data`, reachable only by scanning. Same reason a
     * taxonomy edit takes the site-wide tag. Note this cannot reach the *variant* responses: they
     * carry no `cache-tag` and are `immutable` for a year, which is what `cropStamp` addresses by
     * moving the URL instead.
     */
    taproot.invalidate([SITE_TAG]);

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

    // A page still placing it now renders without it, which is a visible change to cached HTML.
    taproot.invalidate([SITE_TAG]);

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

    taproot.invalidate([SITE_TAG]);

    return noContent();
  },
  { role: 'editor' },
);
