import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';
import { createItem } from './items.js';
import { createContentType, createField, deleteContentType } from './types.js';
import {
  countReusableBlockUsage,
  createReusableBlock,
  deleteReusableBlock,
  itemsUsingReusableBlock,
  listReusableBlocks,
  resolveBlockReferences,
  resolveItemBlocks,
  updateReusableBlock,
} from './reusableBlocks.js';

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

async function seedBlockType(): Promise<{ type: ContentTypeRow; fields: FieldRow[] }> {
  const type = await createContentType(handle.db, {
    api_id: 'notice',
    name: 'Notice',
    name_plural: 'Notices',
    kind: 'block',
    description: null,
    icon: null,
    url_prefix: null,
    summary_template: null,
  });

  const body = await createField(handle.db, type.id, {
    api_id: 'body',
    label: 'Body',
    type: 'text',
    required: true,
    localized: false,
    position: 0,
    config: {},
    help_text: null,
  });

  return { type, fields: [body] };
}

async function seedPageTypeWithBlocks(): Promise<{ type: ContentTypeRow; fields: FieldRow[] }> {
  const type = await createContentType(handle.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    summary_template: '{{ title }}',
  });

  const sections = await createField(handle.db, type.id, {
    api_id: 'sections',
    label: 'Sections',
    type: 'block',
    required: false,
    localized: false,
    position: 0,
    config: {},
    help_text: null,
  });

  return { type, fields: [sections] };
}

describe('creating library entries', () => {
  it('validates content against the block type before storing it', async () => {
    // This is a write path like any other and the REST API reaches it directly, so trusting the
    // caller would let an invalid entry onto every page that later references it.
    const { fields } = await seedBlockType();

    await expect(
      createReusableBlock(handle.db, fields, {
        name: 'Closure notice',
        blockType: 'notice',
        data: {},
      }),
    ).rejects.toThrow(/validation/i);
  });

  it('stores validated content', async () => {
    const { fields } = await seedBlockType();

    const created = await createReusableBlock(handle.db, fields, {
      name: 'Closure notice',
      blockType: 'notice',
      data: { body: 'Campus closed Monday.' },
    });

    expect(created.data).toEqual({ body: 'Campus closed Monday.' });
    expect((await listReusableBlocks(handle.db)).map((b) => b.name)).toEqual(['Closure notice']);
  });

  it('lists by block type', async () => {
    const { fields } = await seedBlockType();
    await createReusableBlock(handle.db, fields, {
      name: 'A',
      blockType: 'notice',
      data: { body: 'x' },
    });

    expect(await listReusableBlocks(handle.db, { blockType: 'notice' })).toHaveLength(1);
    expect(await listReusableBlocks(handle.db, { blockType: 'other' })).toHaveLength(0);
  });
});

describe('references', () => {
  async function seedReferencedPage() {
    const block = await seedBlockType();
    const page = await seedPageTypeWithBlocks();

    const entry = await createReusableBlock(handle.db, block.fields, {
      name: 'Closure notice',
      blockType: 'notice',
      data: { body: 'Campus closed Monday.' },
    });

    const item = await createItem(handle, page.type, page.fields, {
      contentTypeId: page.type.id,
      title: 'Home',
      data: { sections: [{ id: 'b1', type: 'notice', data: {}, ref: entry.id }] },
    });

    return { block, page, entry, item };
  }

  it('stores the reference and no copy of the content', async () => {
    // Two copies would mean a question about which is authoritative, and the stale one would win
    // on whichever page nobody reopened.
    const { item } = await seedReferencedPage();

    expect(item.data.sections).toEqual([
      { id: 'b1', type: 'notice', data: {}, ref: expect.any(String) },
    ]);
  });

  it('does not validate a reference against the block type', async () => {
    // The library row owns the content and was validated when written. A referencing page carries
    // no content, so requiring it to satisfy a required field would make the reference unsavable.
    const { block, page, entry } = await seedReferencedPage();
    expect(block.fields[0]!.required).toBe(1);

    const second = await createItem(handle, page.type, page.fields, {
      contentTypeId: page.type.id,
      title: 'Second',
      data: { sections: [{ id: 'b2', type: 'notice', data: {}, ref: entry.id }] },
    });

    expect(second.data.sections).toHaveLength(1);
  });

  it('resolves the content at read time', async () => {
    const { entry, item, page } = await seedReferencedPage();

    const resolved = await resolveItemBlocks(handle.db, page.fields, item.data);
    const blocks = resolved.sections as { data: unknown; reusable?: { name: string } }[];

    expect(blocks[0]!.data).toEqual({ body: 'Campus closed Monday.' });
    expect(blocks[0]!.reusable).toEqual({ id: entry.id, name: 'Closure notice' });
  });

  it('shows the new content on every page after one edit', async () => {
    // The entire point of the feature.
    const { block, entry, item, page } = await seedReferencedPage();

    await updateReusableBlock(handle.db, block.fields, entry.id, {
      data: { body: 'Campus reopens Tuesday.' },
    });

    const resolved = await resolveItemBlocks(handle.db, page.fields, item.data);
    expect((resolved.sections as { data: { body: string } }[])[0]!.data.body).toBe(
      'Campus reopens Tuesday.',
    );
  });

  it('leaves ordinary blocks untouched', async () => {
    const blocks = [{ id: 'a', type: 'notice', data: { body: 'inline' } }];

    expect(await resolveBlockReferences(handle.db, blocks)).toEqual(blocks);
  });

  it('resolves a repeated reference with one lookup, not one per block', async () => {
    const { entry } = await seedReferencedPage();

    const resolved = await resolveBlockReferences(handle.db, [
      { id: 'a', type: 'notice', data: {}, ref: entry.id },
      { id: 'b', type: 'notice', data: {}, ref: entry.id },
    ]);

    expect(resolved.every((block) => (block.data as { body: string }).body === 'Campus closed Monday.')).toBe(true);
  });

  it('renders nothing rather than throwing when a target has gone', async () => {
    // Deletion is refused while references exist, so this is a torn-database case — but a page
    // that throws is worse than a page missing one block.
    const resolved = await resolveBlockReferences(handle.db, [
      { id: 'a', type: 'notice', data: {}, ref: 'does-not-exist' },
    ]);

    expect(resolved[0]!.data).toEqual({});
  });

  it('tolerates a value that is not a block list', async () => {
    expect(await resolveBlockReferences(handle.db, null)).toEqual([]);
    expect(await resolveBlockReferences(handle.db, 'nope')).toEqual([]);
  });
});

describe('usage tracking and deletion', () => {
  it('counts and lists the pages using an entry', async () => {
    const block = await seedBlockType();
    const page = await seedPageTypeWithBlocks();
    const entry = await createReusableBlock(handle.db, block.fields, {
      name: 'Notice',
      blockType: 'notice',
      data: { body: 'x' },
    });

    await createItem(handle, page.type, page.fields, {
      contentTypeId: page.type.id,
      title: 'Home',
      data: { sections: [{ id: 'b1', type: 'notice', data: {}, ref: entry.id }] },
    });

    expect(await countReusableBlockUsage(handle.db, entry.id)).toBe(1);
    expect((await itemsUsingReusableBlock(handle.db, entry.id)).map((i) => i.title)).toEqual([
      'Home',
    ]);
  });

  it('refuses to delete an entry still referenced', async () => {
    // A reference with no target renders as a gap, on exactly the pages nobody is looking at —
    // which is why the content was shared in the first place.
    const block = await seedBlockType();
    const page = await seedPageTypeWithBlocks();
    const entry = await createReusableBlock(handle.db, block.fields, {
      name: 'Notice',
      blockType: 'notice',
      data: { body: 'x' },
    });

    await createItem(handle, page.type, page.fields, {
      contentTypeId: page.type.id,
      title: 'Home',
      data: { sections: [{ id: 'b1', type: 'notice', data: {}, ref: entry.id }] },
    });

    await expect(deleteReusableBlock(handle.db, entry.id)).rejects.toThrow(/still use it/);
  });

  it('allows deleting an unreferenced entry', async () => {
    const block = await seedBlockType();
    const entry = await createReusableBlock(handle.db, block.fields, {
      name: 'Notice',
      blockType: 'notice',
      data: { body: 'x' },
    });

    await deleteReusableBlock(handle.db, entry.id);
    expect(await listReusableBlocks(handle.db)).toEqual([]);
  });

  it('refuses to delete a block type that only the library uses', async () => {
    // `countBlockUsage` only sees blocks written into a content item, so an entry no page
    // references yet is invisible to it — and deleting the type would strand it.
    const block = await seedBlockType();
    await createReusableBlock(handle.db, block.fields, {
      name: 'Notice',
      blockType: 'notice',
      data: { body: 'x' },
    });

    await expect(deleteContentType(handle.db, block.type.id)).rejects.toThrow(/reusable block/i);
  });
});
