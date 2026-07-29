import type { Kysely } from 'kysely';
import type { Database } from '@taproot/core';

import type { MediaOption } from './islands/SeoPanel.js';

/**
 * Image assets, with their public URLs resolved server-side.
 *
 * The URL has to be built here rather than in the island: `publicUrl` belongs to the storage
 * adapter, which is configured per deployment and only exists on the server. Sending the storage
 * key to the browser and reassembling a URL there would hardcode one adapter's layout into the
 * client.
 *
 * Non-images are excluded — a PDF cannot be a social card, and offering one produces a share
 * preview that silently fails on every platform.
 */
export async function imageOptions(
  db: Kysely<Database>,
  storage: { publicUrl(key: string): string },
  limit = 200,
): Promise<MediaOption[]> {
  const rows = await db
    .selectFrom('media')
    .select(['id', 'filename', 'storage_key', 'alt_text', 'mime_type'])
    .where('mime_type', 'like', 'image/%')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();

  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    url: storage.publicUrl(row.storage_key),
    altText: row.alt_text,
  }));
}

/** One image by id, for rendering a content type's inherited default. */
export function findImage(images: MediaOption[], id: string | null): MediaOption | null {
  return id ? (images.find((image) => image.id === id) ?? null) : null;
}
