import { buildStorageKey, contentTypeFromFilename, newId, now } from '@taproot/core';

import { apiError, handle, json } from '../_shared.js';

/** Uploads larger than this are rejected outright rather than buffered. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const GET = handle(async ({ context, taproot }) => {
  const params = new URL(context.request.url).searchParams;
  const limit = Math.min(Number(params.get('limit') ?? 50), 200);

  const assets = await taproot.db.db
    .selectFrom('media')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(Number(params.get('offset') ?? 0))
    .execute();

  return json({
    media: assets.map((asset) => ({ ...asset, url: taproot.storage.publicUrl(asset.storage_key) })),
  });
});

export const POST = handle(
  async ({ context, taproot, user }) => {
    const form = await context.request.formData();
    const file = form.get('file');

    if (!(file instanceof File)) {
      return apiError(422, 'Send a file in a multipart form field named "file".');
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return apiError(
        413,
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      );
    }

    const id = newId();
    const key = buildStorageKey(id, file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentType = file.type || contentTypeFromFilename(file.name);

    const stored = await taproot.storage.put(key, bytes, { contentType });

    const timestamp = now();
    const row = {
      id,
      storage_key: stored.key,
      filename: file.name,
      mime_type: stored.contentType,
      size_bytes: stored.size,
      // Dimensions are left null in Phase 0. Reading them needs an image decoder that works on
      // Workers; the hotspot/crop editor in Phase 1 is where they start to matter.
      width: null,
      height: null,
      alt_text: (form.get('alt') as string | null) ?? null,
      title: (form.get('title') as string | null) ?? null,
      hotspot_x: null,
      hotspot_y: null,
      crop_top: null,
      crop_right: null,
      crop_bottom: null,
      crop_left: null,
      uploaded_by: user.id,
      created_at: timestamp,
      updated_at: timestamp,
    };

    await taproot.db.db.insertInto('media').values(row).execute();

    return json({ media: { ...row, url: taproot.storage.publicUrl(stored.key) } }, { status: 201 });
  },
  { role: 'contributor' },
);
