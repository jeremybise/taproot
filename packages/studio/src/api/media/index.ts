import {
  buildStorageKey,
  contentTypeFromFilename,
  listMedia,
  newId,
  now,
  readImageDimensions,
} from '@taprootcms/core';

import { apiError, formValue, handle, json } from '../_shared.js';

/** Uploads larger than this are rejected outright rather than buffered. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * How many files one POST may carry, and how many bytes in total.
 *
 * Both caps are explicit, and the count cap is what keeps this a **plain form**. The obvious way to
 * upload twenty files is twenty client-side POSTs with a progress bar, and that forks the no-JS
 * path permanently: the server-rendered form would have to keep working alongside a second upload
 * implementation, and the two would drift on exactly the rules that matter here — the byte cap and
 * the alt-text state machine. One request, bounded, keeps one path.
 *
 * The total is not `MAX_UPLOAD_FILES × MAX_UPLOAD_BYTES`, which would be 250 MB and is more than a
 * Worker should buffer. It is the request-level bound; the per-file one still applies to each.
 */
const MAX_UPLOAD_FILES = 10;
const MAX_BATCH_BYTES = 60 * 1024 * 1024;

/** What went wrong with one file in a batch, so a partial success can name it. */
interface RejectedUpload {
  filename: string;
  reason: string;
}

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

    /**
     * `getAll`, so one field name carries one file or twenty.
     *
     * The library's form is `multiple` and the picker's is not, and both post `file` — which is
     * what keeps this one endpoint rather than a second bulk one. A single-file post is simply a
     * batch of one and takes every rule below unchanged.
     */
    const files = form.getAll('file').filter((entry): entry is File => entry instanceof File);
    const present = files.filter((file) => file.size > 0);

    /**
     * The media library's upload form is a plain HTML form, so a browser follows this response.
     * Returning JSON meant a successful upload dumped `{"media":{...}}` on screen instead of
     * going back to the library. Programmatic callers still get JSON; browsers get a redirect.
     */
    const isBrowserForm = (context.request.headers.get('accept') ?? '').includes('text/html');
    const backToLibrary = (params: Record<string, string>) =>
      context.redirect(`/admin/media?${new URLSearchParams(params)}`, 303);

    if (present.length === 0) {
      const message = 'Choose a file to upload.';
      return isBrowserForm ? backToLibrary({ error: message }) : apiError(422, message);
    }

    /*
     * The two batch caps are refusals of the whole request, not per-file rejections.
     *
     * Both describe the *request* rather than any one file, so there is no subset of it that is
     * valid — silently keeping the first ten of thirty would be the truncation bug the content
     * lists just spent a phase removing, one layer down and with somebody's files in it.
     */
    if (present.length > MAX_UPLOAD_FILES) {
      const message = `That is ${present.length} files; ${MAX_UPLOAD_FILES} at a time is the limit.`;
      return isBrowserForm ? backToLibrary({ error: message }) : apiError(422, message);
    }

    const batchBytes = present.reduce((total, file) => total + file.size, 0);
    if (batchBytes > MAX_BATCH_BYTES) {
      const message =
        `Those files come to ${(batchBytes / 1024 / 1024).toFixed(1)} MB; ` +
        `${MAX_BATCH_BYTES / 1024 / 1024} MB per upload is the limit.`;
      return isBrowserForm ? backToLibrary({ error: message }) : apiError(413, message);
    }

    /*
     * Per-file failures do **not** sink the batch.
     *
     * One oversized file among nine good ones must not cost the other eight — a browser cannot
     * reselect a partial file list, so the editor's only recovery would be to redo all of it. They
     * are collected and named instead. A single-file post is unaffected: its batch is one, so a
     * rejection there is still a failed upload with its reason, which is what it was before.
     */
    const rejected: RejectedUpload[] = [];
    const rows: Array<Awaited<ReturnType<typeof storeOne>>> = [];

    async function storeOne(file: File) {
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
      return {
        id,
        storage_key: stored.key,
        filename: file.name,
        mime_type: stored.contentType,
        size_bytes: stored.size,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        /**
         * Blank becomes null, not the empty string.
         *
         * `''` means "somebody decided this image needs no description" and null means "nobody has
         * said" — the distinction the accessibility checker rests on. An empty text input submits
         * `''`, so passing the form value straight through would have every upload with the alt box
         * left blank claiming to be a deliberate decision. Declaring an image decorative is done on
         * the describe screen or the asset's own, where the rest of its description lives.
         *
         * Read once outside the loop's meaning: a batch shares one `alt` field only when the form
         * offered one, which is the picker's single-file case. The library's multi-file form has no
         * alt box at all — one description cannot serve twenty images — and sends its editor to the
         * describe screen instead.
         */
        alt_text: present.length === 1 ? formValue(form, 'alt') : null,
        title: present.length === 1 ? formValue(form, 'title') : null,
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
    }

    for (const file of present) {
      if (file.size > MAX_UPLOAD_BYTES) {
        rejected.push({
          filename: file.name,
          reason:
            `${(file.size / 1024 / 1024).toFixed(1)} MB, over the ` +
            `${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit`,
        });
        continue;
      }
      rows.push(await storeOne(file));
    }

    // Every file rejected is a failed upload, not a partial success, and a single-file post that
    // was too big has to keep answering 413 the way it did before this took batches.
    if (rows.length === 0) {
      const message =
        rejected.length === 1
          ? `That file is ${rejected[0]!.reason}.`
          : `None of those files could be uploaded: ${rejected.map((r) => r.filename).join(', ')}.`;
      return isBrowserForm ? backToLibrary({ error: message }) : apiError(413, message);
    }

    await taproot.db.db.insertInto('media').values(rows).execute();

    if (isBrowserForm) {
      /*
       * Straight to the describe screen, carrying exactly the ids just written.
       *
       * This is the "upload-in-place asks for alt text" rule surviving contact with N files: one
       * alt box cannot describe twenty images, so the moment moves from the form to the step right
       * after it rather than disappearing. Passing ids rather than letting the screen re-query for
       * undescribed images is what keeps a batch uploaded into a library that already has fifty
       * undescribed assets from opening a grid of fifty-odd strangers.
       */
      const params = new URLSearchParams({ ids: rows.map((row) => row.id).join(',') });
      if (rejected.length > 0) {
        params.set('rejected', rejected.map((entry) => `${entry.filename} (${entry.reason})`).join('; '));
      }
      return context.redirect(`/admin/media/describe?${params}`, 303);
    }

    return json(
      {
        // Singular `media` is what the picker reads, and it is the only caller that posts one file
        // and expects one asset back. Kept rather than renamed, with the batch beside it.
        media: { ...rows[0]!, url: taproot.storage.publicUrl(rows[0]!.storage_key) },
        uploaded: rows.map((row) => ({ ...row, url: taproot.storage.publicUrl(row.storage_key) })),
        rejected,
      },
      { status: 201 },
    );
  },
  { role: 'contributor' },
);
