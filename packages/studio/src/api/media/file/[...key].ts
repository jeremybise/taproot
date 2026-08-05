import { parseMediaVariant, resizeImage } from '@taprootcms/core';
import type { APIContext } from 'astro';

import { getTaproot } from '../../../runtime/guards.js';

/**
 * Serve a stored object.
 *
 * `storageFromEnv` defaults an R2 deployment's `publicBaseUrl` to `/media`, and nothing served it
 * — so an operator who did not attach a custom domain to the bucket got uploads that succeeded,
 * rows that listed, and every `<img>` pointing at a path that answered 404. The failure looked
 * like a broken image rather than a missing setting, which is the worst way for a configuration
 * gap to present.
 *
 * This is the fallback, not the recommendation. A custom domain on the bucket serves bytes from
 * Cloudflare's edge without waking a Worker; this route bills an invocation per image and cannot
 * be as fast. `TAPROOT_MEDIA_URL` still wins whenever it is set, so configuring the domain simply
 * routes around this — which is why the default is a path that now works rather than one that
 * silently does not.
 *
 * Deliberately public and unauthenticated. Media in a CMS is public by definition: it is embedded
 * in pages anyone can read, and `publicUrl` is documented as non-signed for exactly that reason.
 */
export async function GET(context: APIContext): Promise<Response> {
  const taproot = getTaproot(context.locals);
  const key = context.params.key;

  if (!key) return new Response('Not found', { status: 404 });

  /**
   * The adapter resolves the key, which is what keeps the traversal guard in one place.
   *
   * `LocalStorageAdapter` throws for a key escaping the upload directory and R2 has no such
   * concept, so both are handled by letting the adapter decide rather than re-checking here with
   * a rule that could drift from theirs.
   */
  let bytes: Uint8Array | undefined;
  try {
    bytes = await taproot.storage.get(key);
  } catch {
    // A key the adapter refuses is not a key this route should explain.
    return new Response('Not found', { status: 404 });
  }

  if (!bytes) return new Response('Not found', { status: 404 });

  /**
   * The content type comes from the `media` row rather than from the filename.
   *
   * The row records what was actually uploaded; the key is derived from a filename a user chose.
   * Serving `image/svg+xml` because someone named their upload `.svg` would be letting the
   * filename decide whether the browser executes the contents.
   */
  const row = await taproot.db.db
    .selectFrom('media')
    /*
     * The crop columns are selected because a `?ar=` variant is cropped server-side, and the
     * rectangle is resolved here from the stored hotspot and crop rather than sent by the client —
     * one authority for what the picture is, shared with the admin's preview frames.
     */
    .select([
      'mime_type',
      'filename',
      'width',
      'height',
      'hotspot_x',
      'hotspot_y',
      'crop_top',
      'crop_right',
      'crop_bottom',
      'crop_left',
    ])
    .where('storage_key', '=', key)
    .executeTakeFirst();

  if (!row) return new Response('Not found', { status: 404 });

  /**
   * Resize, if this URL asked for it and the deployment can.
   *
   * The width and format are read off the URL rather than negotiated, because this response is
   * stored in a shared cache keyed on the URL and `Vary` is honoured there only for
   * `Accept-Encoding` — a format chosen from `Accept` would be the first visitor's format served to
   * everyone behind them. `parseMediaVariant` snaps the width to a fixed ladder, which is what stops
   * a crawler walking `?w=1` upward from minting an unbounded number of billable transformations and
   * cache entries.
   *
   * `resizeImage` answers `undefined` for every reason it might not work — no binding, an
   * unresizable type, an allowance reached, a throw — and the original is served instead. That is
   * what makes this safe on a Node deployment and on a Worker with no Images binding: the page is
   * heavier, never broken.
   */
  const variant = parseMediaVariant(context.url.searchParams);
  const resized = await resizeImage(taproot.images, bytes, row.mime_type, variant, row);

  if (resized) {
    return new Response(resized.bytes as BodyInit, {
      headers: {
        'content-type': resized.contentType,
        // Same reasoning as below: the key carries the asset's id and the variant is in the query,
        // so this exact URL can never mean different bytes.
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        /*
         * No `content-disposition` on a transformed variant, deliberately: the stored filename
         * carries the *source* extension, so a re-encoded image would advertise itself as a `.png`
         * while being WebP. A wrong filename is worse than none, and nothing downloads a srcset
         * candidate by name.
         */
      },
    });
  }

  return new Response(bytes as BodyInit, {
    headers: {
      'content-type': row.mime_type,
      /**
       * Immutable, because a storage key contains the asset's id: replacing an image writes a new
       * key rather than overwriting one, so a cached response can never be stale. The R2 adapter
       * sets the same value on the object itself.
       */
      'cache-control': 'public, max-age=31536000, immutable',
      /**
       * Belt and braces against a stored SVG or HTML being interpreted as a document on this
       * origin — which would make an uploaded file same-origin script. `nosniff` stops a browser
       * second-guessing the type above, and the CSP neuters anything that does get parsed.
       */
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'content-disposition': `inline; filename="${row.filename.replace(/["\\]/g, '')}"`,
    },
  });
}
