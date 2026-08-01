import { listMedia } from '@taproot/core';
import type { Kysely } from 'kysely';
import type { Database } from '@taproot/core';

/**
 * One media asset as the admin's React islands see it.
 *
 * Defined here rather than in a component because four screens and three islands pass it around,
 * and the picker, the SEO panel, and the media field all have to agree on it.
 *
 * `url` is resolved server-side on purpose: `publicUrl` belongs to the storage adapter, which is
 * configured per deployment and only exists on the server. Sending the storage key to the browser
 * and reassembling a URL there would hardcode one adapter's layout into the client.
 */
export interface MediaOption {
  id: string;
  filename: string;
  url: string;
  altText: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
}

/**
 * The first page the media picker opens with.
 *
 * Passed from the server rather than fetched on open so the grid has content in the same frame the
 * dialog appears — a picker that opens empty and fills in a moment later reads as broken, and the
 * editor has already started moving the pointer by then. Searching past this page does go to the
 * API, which is where `total` earns its keep.
 */
export async function mediaOptions(
  db: Kysely<Database>,
  storage: { publicUrl(key: string): string },
  limit = 60,
): Promise<MediaOption[]> {
  const { media } = await listMedia(db, { limit });
  return media.map((row) => toMediaOption(row, storage));
}

/**
 * Images only, for the places where the asset is a social card.
 *
 * A PDF cannot be an OG image, and offering one produces a share preview that silently fails on
 * every platform. `media` fields use `mediaOptions` instead and constrain by their own accept list.
 */
export async function imageOptions(
  db: Kysely<Database>,
  storage: { publicUrl(key: string): string },
  limit = 60,
): Promise<MediaOption[]> {
  const { media } = await listMedia(db, { accept: ['image/'], limit });
  return media.map((row) => toMediaOption(row, storage));
}

/** One image by id, for rendering a content type's inherited default. */
export function findImage(images: MediaOption[], id: string | null): MediaOption | null {
  return id ? (images.find((image) => image.id === id) ?? null) : null;
}

function toMediaOption(
  row: {
    id: string;
    filename: string;
    storage_key: string;
    alt_text: string | null;
    mime_type: string;
    width: number | null;
    height: number | null;
  },
  storage: { publicUrl(key: string): string },
): MediaOption {
  return {
    id: row.id,
    filename: row.filename,
    url: storage.publicUrl(row.storage_key),
    altText: row.alt_text,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
  };
}
