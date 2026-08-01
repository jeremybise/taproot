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
    .select(['mime_type', 'filename'])
    .where('storage_key', '=', key)
    .executeTakeFirst();

  if (!row) return new Response('Not found', { status: 404 });

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
