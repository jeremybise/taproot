import {
  buildStorageKey,
  contentTypeFromFilename,
  newId,
  now,
  readImageDimensions,
} from '@taproot/core';

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

    /**
     * The media library's upload form is a plain HTML form, so a browser follows this response.
     * Returning JSON meant a successful upload dumped `{"media":{...}}` on screen instead of
     * going back to the library. Programmatic callers still get JSON; browsers get a redirect.
     */
    const isBrowserForm = (context.request.headers.get('accept') ?? '').includes('text/html');
    const backToLibrary = (params: Record<string, string>) =>
      context.redirect(`/admin/media?${new URLSearchParams(params)}`, 303);

    if (!(file instanceof File) || file.size === 0) {
      const message = 'Choose a file to upload.';
      return isBrowserForm ? backToLibrary({ error: message }) : apiError(422, message);
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      const message =
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ` +
        `${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`;
      return isBrowserForm ? backToLibrary({ error: message }) : apiError(413, message);
    }

    const id = newId();
    const key = buildStorageKey(id, file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentType = file.type || contentTypeFromFilename(file.name);

    const stored = await taproot.storage.put(key, bytes, { contentType });

    /**
     * Dimensions are read from the header bytes, not decoded.
     *
     * The crop editor needs the source's real proportions to fit a target shape inside a
     * normalised crop rectangle — without them it can only show the crop as-is. Unrecognised
     * formats return null and stay null, which is a degraded editor rather than a failed upload.
     */
    const dimensions = stored.contentType.startsWith('image/')
      ? readImageDimensions(bytes)
      : null;

    const timestamp = now();
    const row = {
      id,
      storage_key: stored.key,
      filename: file.name,
      mime_type: stored.contentType,
      size_bytes: stored.size,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
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

    if (isBrowserForm) {
      return backToLibrary({ uploaded: file.name });
    }

    return json({ media: { ...row, url: taproot.storage.publicUrl(stored.key) } }, { status: 201 });
  },
  { role: 'contributor' },
);
