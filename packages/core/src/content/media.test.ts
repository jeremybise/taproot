import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { newId } from '../ids.js';
import { listMedia, mediaMatchesAccept } from './media.js';

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

/**
 * Timestamps step forward explicitly rather than calling `now()` per row.
 *
 * `now()` has millisecond resolution, and a loop inserting five assets lands several of them in
 * the same millisecond — which would make every ordering assertion here flaky rather than wrong.
 */
let clock = 0;
beforeEach(() => {
  clock = 0;
});

async function seedAsset(
  filename: string,
  mimeType: string,
  altText: string | null = null,
): Promise<string> {
  const id = newId();
  clock += 1000;
  const timestamp = new Date(Date.parse('2026-01-01T00:00:00.000Z') + clock).toISOString();
  await handle.db
    .insertInto('media')
    .values({
      id,
      storage_key: `uploads/${id}/${filename}`,
      filename,
      mime_type: mimeType,
      size_bytes: 1024,
      width: null,
      height: null,
      alt_text: altText,
      title: null,
      hotspot_x: null,
      hotspot_y: null,
      crop_top: null,
      crop_right: null,
      crop_bottom: null,
      crop_left: null,
      uploaded_by: null,
      created_at: timestamp,
      updated_at: timestamp,
    })
    .execute();
  return id;
}

describe('listMedia', () => {
  it('returns the newest first', async () => {
    await seedAsset('first.jpg', 'image/jpeg');
    await seedAsset('second.jpg', 'image/jpeg');

    const { media } = await listMedia(handle.db);
    expect(media.map((asset) => asset.filename)).toEqual(['second.jpg', 'first.jpg']);
  });

  it('searches filenames case-insensitively', async () => {
    // Lowercased on both sides rather than trusting the collation: SQLite's LIKE ignores ASCII
    // case and Postgres's does not, so an unqualified LIKE would behave differently in production.
    await seedAsset('Quad-Autumn.JPG', 'image/jpeg');
    await seedAsset('library.jpg', 'image/jpeg');

    const { media } = await listMedia(handle.db, { search: 'quad' });
    expect(media.map((asset) => asset.filename)).toEqual(['Quad-Autumn.JPG']);
  });

  it('searches alt text too, which is often the only description of what an image shows', async () => {
    await seedAsset('DSC_0413.jpg', 'image/jpeg', 'Students crossing the quad at dusk');
    await seedAsset('DSC_0414.jpg', 'image/jpeg', 'The library reading room');

    const { media } = await listMedia(handle.db, { search: 'dusk' });
    expect(media.map((asset) => asset.filename)).toEqual(['DSC_0413.jpg']);
  });

  it('does not fall over on assets with no alt text', async () => {
    // `alt_text` is nullable, and a bare LIKE against NULL matches nothing — including for a
    // search that should have matched the filename.
    await seedAsset('quad.jpg', 'image/jpeg', null);

    const { media } = await listMedia(handle.db, { search: 'quad' });
    expect(media).toHaveLength(1);
  });

  it('filters by MIME prefix', async () => {
    await seedAsset('photo.jpg', 'image/jpeg');
    await seedAsset('diagram.png', 'image/png');
    await seedAsset('catalogue.pdf', 'application/pdf');

    const images = await listMedia(handle.db, { accept: ['image/'] });
    expect(images.media).toHaveLength(2);

    const documents = await listMedia(handle.db, { accept: ['application/'] });
    expect(documents.media.map((asset) => asset.filename)).toEqual(['catalogue.pdf']);
  });

  it('treats an empty accept list as no filter, matching the field builder default', async () => {
    await seedAsset('photo.jpg', 'image/jpeg');
    await seedAsset('catalogue.pdf', 'application/pdf');

    const { media } = await listMedia(handle.db, { accept: [] });
    expect(media).toHaveLength(2);
  });

  it('resolves specific ids regardless of how old they are', async () => {
    // What a field pointing at an asset older than the picker's first page depends on.
    const wanted = await seedAsset('old.jpg', 'image/jpeg');
    for (let index = 0; index < 5; index += 1) await seedAsset(`newer-${index}.jpg`, 'image/jpeg');

    const { media } = await listMedia(handle.db, { ids: [wanted] });
    expect(media.map((asset) => asset.filename)).toEqual(['old.jpg']);
  });

  it('returns nothing for an empty id list rather than the whole library', async () => {
    // The dangerous failure: "resolve these none" quietly becoming "return everything".
    await seedAsset('photo.jpg', 'image/jpeg');

    const { media, total } = await listMedia(handle.db, { ids: [] });
    expect(media).toEqual([]);
    expect(total).toBe(0);
  });

  it('counts every match, not just the page returned', async () => {
    // What lets the picker say "showing 2 of 5" instead of leaving the editor to guess whether
    // scrolling would reveal more.
    for (let index = 0; index < 5; index += 1) await seedAsset(`photo-${index}.jpg`, 'image/jpeg');

    const { media, total } = await listMedia(handle.db, { limit: 2 });
    expect(media).toHaveLength(2);
    expect(total).toBe(5);
  });
});

describe('mediaMatchesAccept', () => {
  it('matches the query, so a client-side filter cannot disagree with a server-side one', () => {
    expect(mediaMatchesAccept('image/jpeg', ['image/'])).toBe(true);
    expect(mediaMatchesAccept('application/pdf', ['image/'])).toBe(false);
    expect(mediaMatchesAccept('application/pdf', ['image/', 'application/'])).toBe(true);
  });

  it('accepts everything when nothing is specified', () => {
    expect(mediaMatchesAccept('application/pdf', [])).toBe(true);
    expect(mediaMatchesAccept('application/pdf', undefined)).toBe(true);
  });
});
