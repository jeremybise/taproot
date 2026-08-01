import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { newId } from '../ids.js';
import { now } from '../db/values.js';
import { auditContentItems, undescribedImages } from './accessibilityReport.js';
import { createItem } from './items.js';
import { createContentType, createField } from './types.js';
import { createReusableBlock } from './reusableBlocks.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';

/**
 * The site-wide report: the same rules as the editor's panel, over many items at once.
 *
 * What is worth asserting here is not the rules — `accessibility.test.ts` covers those against a
 * pure function — but the resolution this half is responsible for: that a page's media is looked up
 * by what the items actually reference, that the default is what the public can see, and that an
 * item with nothing wrong does not appear at all.
 */

let handle: TaprootDb;
let type: ContentTypeRow;
let fields: FieldRow[];

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;

  type = await createContentType(handle.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    title_field: 'title',
  });

  fields = [
    await createField(handle.db, type.id, {
      api_id: 'body',
      label: 'Body',
      type: 'richtext',
      required: false,
      localized: false,
      position: 0,
      config: {},
      help_text: null,
    }),
    await createField(handle.db, type.id, {
      api_id: 'photo',
      label: 'Photo',
      type: 'media',
      required: false,
      localized: false,
      position: 1,
      config: {},
      help_text: null,
    }),
  ];
});

afterEach(async () => {
  await handle.destroy();
});

async function page(
  title: string,
  data: Record<string, unknown>,
  status: 'draft' | 'published' = 'published',
) {
  return createItem(handle, type, fields, { contentTypeId: type.id, title, status, data });
}

/** An image row, written directly — the upload route is not what is under test. */
async function image(filename: string, altText: string | null): Promise<string> {
  const id = newId();
  const timestamp = now();
  await handle.db
    .insertInto('media')
    .values({
      id,
      storage_key: `uploads/${filename}`,
      filename,
      mime_type: 'image/jpeg',
      size_bytes: 1024,
      width: 1600,
      height: 900,
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

describe('auditContentItems', () => {
  it('lists only the items with something wrong', async () => {
    await page('Fine', { body: '<h2>Good</h2>' });
    await page('Broken', { body: '<h2>a</h2><h4>b</h4>' });

    const report = await auditContentItems(handle.db);

    expect(report.items.map((entry) => entry.item.title)).toEqual(['Broken']);
    // Both were checked, and the screen says so — the count is of items scanned, not of items
    // listed, because "we found one problem" and "we looked at two pages" are different facts.
    expect(report.scanned).toBe(2);
    expect(report.totalItems).toBe(2);
    expect(report.errors).toBe(1);
  });

  it('reads alt text for the assets the items reference', async () => {
    const described = await image('quad.jpg', 'The quad in autumn');
    const undescribed = await image('library.jpg', null);

    await page('Described', { photo: described });
    await page('Undescribed', { photo: undescribed });

    const report = await auditContentItems(handle.db);

    expect(report.items.map((entry) => entry.item.title)).toEqual(['Undescribed']);
    expect(report.items[0]!.issues[0]!.message).toContain('library.jpg');
  });

  it('says nothing about an image marked decorative', async () => {
    await page('Divider', { photo: await image('rule.jpg', '') });

    expect((await auditContentItems(handle.db)).items).toEqual([]);
  });

  it('checks what the public can see by default', async () => {
    await page('Draft with a problem', { body: '<h4>a</h4>' }, 'draft');

    // Through the same `visibleToPublic` rule every other reader uses, rather than a status list of
    // its own — a draft nobody has finished is not yet a problem anybody has.
    expect((await auditContentItems(handle.db)).items).toEqual([]);
    expect((await auditContentItems(handle.db, { visibleOnly: false })).items).toHaveLength(1);
  });

  it('narrows to one rule without changing what was scanned', async () => {
    await page('Both', { body: '<h4>a</h4><p><a href="/x">click here</a></p>' });

    const all = await auditContentItems(handle.db);
    const headings = await auditContentItems(handle.db, { rule: 'heading-order' });

    expect(all.items[0]!.issues).toHaveLength(2);
    expect(headings.items[0]!.issues).toHaveLength(1);
    expect(headings.scanned).toBe(all.scanned);
  });

  it('attributes a reusable block’s issue to the library entry', async () => {
    const blockType = await createContentType(handle.db, {
      api_id: 'callout',
      name: 'Callout',
      name_plural: 'Callouts',
      kind: 'block',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: null,
    });
    const calloutText = await createField(handle.db, blockType.id, {
      api_id: 'text',
      label: 'Text',
      type: 'richtext',
      required: false,
      localized: false,
      position: 0,
      config: {},
      help_text: null,
    });

    const blocksField = await createField(handle.db, type.id, {
      api_id: 'content',
      label: 'Page content',
      type: 'block',
      required: false,
      localized: false,
      position: 2,
      config: {},
      help_text: null,
    });
    fields = [...fields, blocksField];

    const entry = await createReusableBlock(handle.db, [calloutText], {
      name: 'Admissions callout',
      blockType: 'callout',
      description: null,
      data: { text: '<a href="/x">click here</a>' },
    });

    await page('Uses the library', {
      content: [{ id: 'b1', type: 'callout', ref: entry.id, data: {} }],
    });

    const report = await auditContentItems(handle.db);

    expect(report.items[0]!.issues[0]!.inheritedFrom).toEqual({
      id: entry.id,
      name: 'Admissions callout',
    });
  });

  it('pages through without rescanning', async () => {
    for (let i = 0; i < 3; i++) await page(`Page ${i}`, { body: '<h4>a</h4>' });

    const first = await auditContentItems(handle.db, { limit: 2 });
    const second = await auditContentItems(handle.db, { limit: 2, offset: 2 });

    expect(first.scanned).toBe(2);
    expect(second.scanned).toBe(1);
    expect(first.totalItems).toBe(3);

    const titles = [...first.items, ...second.items].map((entry) => entry.item.title);
    expect(new Set(titles).size).toBe(3);
  });
});

describe('undescribedImages', () => {
  it('counts every undescribed image, including one no page uses', async () => {
    await image('placed.jpg', null);
    await image('never-placed.jpg', null);
    await image('described.jpg', 'A description');
    await image('decorative.jpg', '');

    const { images, total } = await undescribedImages(handle.db);

    // The whole point of asking this separately: an image uploaded and not yet placed appears in no
    // item's data, so the item scan cannot see it — and it will be undescribed wherever it lands.
    expect(total).toBe(2);
    expect(images.map((row) => row.filename).sort()).toEqual(['never-placed.jpg', 'placed.jpg']);
  });

  it('reports a true total even when it returns fewer rows', async () => {
    for (let i = 0; i < 5; i++) await image(`shot-${i}.jpg`, null);

    const { images, total } = await undescribedImages(handle.db, { limit: 2 });

    // A count query rather than the length of what was fetched. A capped number presented as a
    // total is worse than no total, because nothing on screen says it is wrong.
    expect(images).toHaveLength(2);
    expect(total).toBe(5);
  });

  it('ignores anything that is not an image', async () => {
    const id = newId();
    const timestamp = now();
    await handle.db
      .insertInto('media')
      .values({
        id,
        storage_key: 'uploads/prospectus.pdf',
        filename: 'prospectus.pdf',
        mime_type: 'application/pdf',
        size_bytes: 2048,
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
        uploaded_by: null,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .execute();

    expect((await undescribedImages(handle.db)).total).toBe(0);
  });
});
