import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUser, listTerms, createTaxonomy, createTerm, type User } from '@taproot/core';

import { createHarness, location, type Harness } from './testHarness.js';
import { GET as serveFile } from './media/file/[...key].js';
import { POST as termAction } from './terms/[termId].js';

/**
 * Serving stored objects, and reordering terms.
 *
 * Both close gaps where a function existed and nothing reached it: `storageFromEnv` defaulted an
 * R2 deployment to `/media` with no route behind it, and `reorderTerms` had shipped with the
 * taxonomy work and never acquired a caller.
 */

let h: Harness;
let admin: User;

beforeEach(async () => {
  h = await createHarness();
  admin = await createUser(h.db.db, { email: 'a@campus.edu', name: 'A', role: 'admin' });
  h.as(admin);
});

afterEach(async () => {
  await h.destroy();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function storeAsset(overrides: Record<string, unknown> = {}) {
  const key = '2026/07/abc/photo.png';
  await h.storage.put(key, PNG, { contentType: 'image/png' });
  await h.db.db
    .insertInto('media')
    .values({
      id: 'm1',
      storage_key: key,
      filename: 'photo.png',
      mime_type: 'image/png',
      size_bytes: PNG.byteLength,
      width: null,
      height: null,
      alt_text: null,
      title: null,
      hotspot_x: null,
      hotspot_y: null,
      crop_top: null,
      crop_right: null,
      crop_bottom: null,
      crop_left: null,
      uploaded_by: admin.id,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      ...overrides,
    })
    .execute();
  return key;
}

describe('serving a stored object', () => {
  it('returns the bytes', async () => {
    const key = await storeAsset();
    const response = await serveFile(h.context({ params: { key } }));

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it('is public — media in a CMS is embedded in pages anyone can read', async () => {
    const key = await storeAsset();
    h.as(undefined);

    expect((await serveFile(h.context({ params: { key } }))).status).toBe(200);
  });

  it('takes the content type from the row, not the filename', async () => {
    /**
     * The key is derived from a name a user chose. Letting it decide the type would mean an upload
     * called `x.svg` is served as `image/svg+xml` — which browsers treat as a document, making an
     * uploaded file same-origin script.
     */
    const key = await storeAsset({ filename: 'looks-like.svg', mime_type: 'image/png' });
    const response = await serveFile(h.context({ params: { key } }));

    expect(response.headers.get('content-type')).toBe('image/png');
  });

  it('sends the headers that keep an uploaded file from becoming a page', async () => {
    const key = await storeAsset();
    const response = await serveFile(h.context({ params: { key } }));

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    // Immutable is safe because a storage key contains the asset's id: replacing an image writes a
    // new key rather than overwriting one, so a cached response can never be stale.
    expect(response.headers.get('cache-control')).toContain('immutable');
  });

  it('404s for a key with no row, even when the object exists', async () => {
    // An object with no row is clutter from a failed delete, not something to serve.
    await h.storage.put('orphan.png', PNG, { contentType: 'image/png' });

    expect((await serveFile(h.context({ params: { key: 'orphan.png' } }))).status).toBe(404);
  });

  it('404s for a row whose object has gone', async () => {
    const key = await storeAsset();
    await h.storage.delete(key);

    expect((await serveFile(h.context({ params: { key } }))).status).toBe(404);
  });

  it('404s with no key at all', async () => {
    expect((await serveFile(h.context({ params: {} }))).status).toBe(404);
  });

  it('does not leak a filename with a quote in it into the header', async () => {
    const key = await storeAsset({ filename: 'od"d\\name.png' });
    const response = await serveFile(h.context({ params: { key } }));

    expect(response.headers.get('content-disposition')).toBe('inline; filename="oddname.png"');
  });
});

describe('reordering terms', () => {
  async function seedTerms() {
    const taxonomy = await createTaxonomy(h.db.db, {
      api_id: 'department',
      name: 'Department',
      name_plural: 'Departments',
      hierarchical: true,
    });
    const first = await createTerm(h.db.db, taxonomy.id, { name: 'Academics' });
    const second = await createTerm(h.db.db, taxonomy.id, { name: 'Student Services' });
    const child = await createTerm(h.db.db, taxonomy.id, { name: 'Sciences', parentId: first.id });

    return { taxonomy, first, second, child };
  }

  const rootNames = async (taxonomyId: string) =>
    (await listTerms(h.db.db, taxonomyId))
      .filter((term) => term.parent_id === null)
      .map((term) => term.name);

  it('moves a term above its sibling', async () => {
    const { taxonomy, second } = await seedTerms();

    const response = await termAction(
      h.context({ params: { termId: second.id }, form: { move: 'up' } }),
    );

    expect(location(response)).toMatch(/moved=Student Services/);
    expect(await rootNames(taxonomy.id)).toEqual(['Student Services', 'Academics']);
  });

  it('moves it back down again', async () => {
    const { taxonomy, second } = await seedTerms();
    await termAction(h.context({ params: { termId: second.id }, form: { move: 'up' } }));
    await termAction(h.context({ params: { termId: second.id }, form: { move: 'down' } }));

    expect(await rootNames(taxonomy.id)).toEqual(['Academics', 'Student Services']);
  });

  it('does nothing at the ends rather than erroring', async () => {
    const { taxonomy, first } = await seedTerms();

    const response = await termAction(
      h.context({ params: { termId: first.id }, form: { move: 'up' } }),
    );

    expect(response.status).toBe(303);
    expect(await rootNames(taxonomy.id)).toEqual(['Academics', 'Student Services']);
  });

  it('reorders among siblings, not across the flat list', async () => {
    /**
     * `position` is scoped to a parent. Moving a child "up" past a root would write a position
     * that means nothing and leave the list looking unchanged — so a child that is first among its
     * own siblings has nowhere to go, even though rows sit above it on screen.
     */
    const { taxonomy, child } = await seedTerms();

    await termAction(h.context({ params: { termId: child.id }, form: { move: 'up' } }));

    const terms = await listTerms(h.db.db, taxonomy.id);
    expect(terms.find((term) => term.name === 'Sciences')?.parent_id).toBeTruthy();
    expect(await rootNames(taxonomy.id)).toEqual(['Academics', 'Student Services']);
  });

  it('needs the editor role', async () => {
    const { second } = await seedTerms();
    h.as(await h.user('contributor'));

    expect(
      (await termAction(h.context({ params: { termId: second.id }, form: { move: 'up' } }))).status,
    ).toBe(403);
  });
});
