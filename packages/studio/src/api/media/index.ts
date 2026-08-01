import {
  buildStorageKey,
  contentTypeFromFilename,
  listMedia,
  newId,
  now,
  readImageDimensions,
} from '@taproot/core';

import { apiError, handle, json } from '../_shared.js';

/** Uploads larger than this are rejected outright rather than buffered. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const GET = handle(async ({ context, taproot }) => {
  const params = new URL(context.request.url).searchParams;

  /**
   * `accept` arrives comma-separated because it comes straight from a `media` field's config,
   * which stores MIME prefixes. Splitting here rather than repeating the parameter keeps the
   * picker's fetch URL readable in a network log.
   */
  const accept = (params.get('accept') ?? '')
    .split(',')
    .map((prefix) => prefix.trim())
    .filter(Boolean);

  /**
   * `ids` resolves assets a field already references. The picker only ever holds the most recent
   * page of the library, so an item pointing at an older asset needs this to render its thumbnail
   * at all. It ignores the accept filter on purpose: a stored value is shown as it is, and quietly
   * dropping one because the field's accept list narrowed later would look like data loss.
   */
  const ids = (params.get('ids') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const { media, total } = await listMedia(taproot.db.db, {
    ids: params.has('ids') ? ids : undefined,
    search: params.get('q') ?? undefined,
    accept: params.has('ids') ? [] : accept,
    limit: params.has('ids') ? ids.length : Math.min(Number(params.get('limit') ?? 50), 200),
    offset: Number(params.get('offset') ?? 0),
  });

  return json({
    media: media.map((asset) => ({ ...asset, url: taproot.storage.publicUrl(asset.storage_key) })),
    total,
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
