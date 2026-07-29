import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';
import { createContentType } from './types.js';
import { createItem, deleteItem, updateItem } from './items.js';
import { createTaxonomy, createTerm, deleteTerm } from './taxonomies.js';
import {
  createMenu,
  createMenuItem,
  deleteMenuItem,
  listMenuItems,
  resolveMenu,
  updateMenuItem,
} from './menus.js';

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

async function seedPageType(): Promise<{ type: ContentTypeRow; fields: FieldRow[] }> {
  const type = await createContentType(handle.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    title_field: 'title',
  });
  return { type, fields: [] };
}

describe('menu items', () => {
  it('requires the target matching its type', async () => {
    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main' });

    await expect(
      createMenuItem(handle.db, menu.id, { targetType: 'item', contentItemId: null }),
    ).rejects.toThrow(/Choose the page/);

    await expect(
      createMenuItem(handle.db, menu.id, { targetType: 'url', url: '   ' }),
    ).rejects.toThrow(/Enter the address/);
  });

  it('refuses a javascript: URL', async () => {
    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main' });

    // A menu URL is authored by an editor and rendered into an href on every page of the site,
    // which makes it the most inviting stored-XSS surface in the CMS.
    await expect(
      createMenuItem(handle.db, menu.id, {
        targetType: 'url',
        // eslint-disable-next-line no-script-url
        url: 'javascript:alert(1)',
        label: 'Bad',
      }),
    ).rejects.toThrow(/scheme that is not allowed/);

    await expect(
      createMenuItem(handle.db, menu.id, { targetType: 'url', url: 'DATA:text/html,x' }),
    ).rejects.toThrow(/scheme that is not allowed/);
  });

  it('refuses to nest under an item from another menu', async () => {
    const a = await createMenu(handle.db, { api_id: 'main', name: 'Main' });
    const b = await createMenu(handle.db, { api_id: 'footer', name: 'Footer' });
    const foreign = await createMenuItem(handle.db, b.id, {
      targetType: 'url',
      url: '/x',
      label: 'X',
    });

    await expect(
      createMenuItem(handle.db, a.id, {
        targetType: 'url',
        url: '/y',
        label: 'Y',
        parentId: foreign.id,
      }),
    ).rejects.toThrow(/another menu/);
  });

  it('refuses to move an item under its own child', async () => {
    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main' });
    const parent = await createMenuItem(handle.db, menu.id, {
      targetType: 'url',
      url: '/a',
      label: 'A',
    });
    const child = await createMenuItem(handle.db, menu.id, {
      targetType: 'url',
      url: '/b',
      label: 'B',
      parentId: parent.id,
    });

    await expect(updateMenuItem(handle, parent.id, { parentId: child.id })).rejects.toThrow(
      /underneath itself/,
    );
  });

  it('re-depths descendants when an item moves', async () => {
    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main' });
    const top = await createMenuItem(handle.db, menu.id, {
      targetType: 'url',
      url: '/a',
      label: 'A',
    });
    const mid = await createMenuItem(handle.db, menu.id, {
      targetType: 'url',
      url: '/b',
      label: 'B',
      parentId: top.id,
    });
    const leaf = await createMenuItem(handle.db, menu.id, {
      targetType: 'url',
      url: '/c',
      label: 'C',
      parentId: mid.id,
    });

    expect(leaf.depth).toBe(2);

    await updateMenuItem(handle, mid.id, { parentId: null });

    const rows = await listMenuItems(handle.db, menu.id);
    expect(rows.find((row) => row.id === mid.id)!.depth).toBe(0);
    expect(rows.find((row) => row.id === leaf.id)!.depth).toBe(1);
  });

  it('deletes an item’s children with it', async () => {
    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main' });
    const parent = await createMenuItem(handle.db, menu.id, {
      targetType: 'url',
      url: '/a',
      label: 'A',
    });
    await createMenuItem(handle.db, menu.id, {
      targetType: 'url',
      url: '/b',
      label: 'B',
      parentId: parent.id,
    });

    // Unlike a taxonomy term, a dropdown's contents have no meaning without the thing they hang off.
    await deleteMenuItem(handle.db, parent.id);
    expect(await listMenuItems(handle.db, menu.id)).toEqual([]);
  });
});

describe('resolution', () => {
  it('follows a page when it moves, without touching the menu', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
      status: 'published',
    });
    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main' });
    await createMenuItem(handle.db, menu.id, { targetType: 'item', contentItemId: item.id });

    expect((await resolveMenu(handle.db, 'main'))[0]!.href).toBe('/admissions');

    await updateItem(handle, type, fields, item.id, { slug: 'admissions-office' });

    // This is the whole reason menu items reference rather than store a URL.
    expect((await resolveMenu(handle.db, 'main'))[0]!.href).toBe('/admissions-office');
  });

  it('falls back to the target’s current title, and a stored label wins', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Apply for Undergraduate Admission',
      status: 'published',
    });
    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main' });
    const entry = await createMenuItem(handle.db, menu.id, {
      targetType: 'item',
      contentItemId: item.id,
    });

    expect((await resolveMenu(handle.db, 'main'))[0]!.label).toBe(
      'Apply for Undergraduate Admission',
    );

    await updateMenuItem(handle, entry.id, { label: 'Apply' });
    expect((await resolveMenu(handle.db, 'main'))[0]!.label).toBe('Apply');
  });

  it('hides an unpublished page from the public menu but shows it in the admin', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Draft page',
      status: 'draft',
    });
    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main' });
    await createMenuItem(handle.db, menu.id, { targetType: 'item', contentItemId: item.id });

    expect(await resolveMenu(handle.db, 'main')).toEqual([]);

    // The admin keeps the href — following it to the draft is useful — but must be told the entry
    // is not public, which is the whole point of showing it.
    const forAdmin = await resolveMenu(handle.db, 'main', { publishedOnly: false });
    expect(forAdmin[0]).toMatchObject({ brokenReason: 'unpublished', href: '/draft-page' });
  });

  it('keeps a deleted target’s entry visible to the admin and hidden from visitors', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Doomed',
      status: 'published',
    });
    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main' });
    await createMenuItem(handle.db, menu.id, {
      targetType: 'item',
      contentItemId: item.id,
      label: 'Doomed',
    });

    await deleteItem(handle, item.id);

    // Nulled rather than cascaded: deleting a page should not silently edit the navigation.
    expect(await resolveMenu(handle.db, 'main')).toEqual([]);
    const forAdmin = await resolveMenu(handle.db, 'main', { publishedOnly: false });
    expect(forAdmin).toHaveLength(1);
    expect(forAdmin[0]).toMatchObject({ label: 'Doomed', brokenReason: 'deleted' });
  });

  it('resolves a term to its archive path and survives the term being deleted', async () => {
    const taxonomy = await createTaxonomy(handle.db, {
      api_id: 'department',
      name: 'Department',
      name_plural: 'Departments',
    });
    const term = await createTerm(handle.db, taxonomy.id, { name: 'Admissions' });
    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main' });
    await createMenuItem(handle.db, menu.id, { targetType: 'term', termId: term.id });

    expect((await resolveMenu(handle.db, 'main'))[0]).toMatchObject({
      href: '/department/admissions',
      label: 'Admissions',
    });

    await deleteTerm(handle, term.id);
    expect(await resolveMenu(handle.db, 'main')).toEqual([]);
  });

  it('nests children under their parent', async () => {
    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main' });
    const parent = await createMenuItem(handle.db, menu.id, {
      targetType: 'url',
      url: '/about',
      label: 'About',
    });
    await createMenuItem(handle.db, menu.id, {
      targetType: 'url',
      url: '/about/staff',
      label: 'Staff',
      parentId: parent.id,
    });

    const tree = await resolveMenu(handle.db, 'main');
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children.map((child) => child.label)).toEqual(['Staff']);
  });

  it('promotes a child whose parent is hidden rather than dropping it', async () => {
    const { type, fields } = await seedPageType();
    const draft = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Draft parent',
      status: 'draft',
    });
    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main' });
    const parent = await createMenuItem(handle.db, menu.id, {
      targetType: 'item',
      contentItemId: draft.id,
    });
    await createMenuItem(handle.db, menu.id, {
      targetType: 'url',
      url: '/published',
      label: 'Published child',
      parentId: parent.id,
    });

    // Hiding the whole dropdown because its heading is a draft would silently remove published
    // pages from the navigation.
    const tree = await resolveMenu(handle.db, 'main');
    expect(tree.map((node) => node.label)).toEqual(['Published child']);
  });

  it('returns nothing for a menu that does not exist', async () => {
    expect(await resolveMenu(handle.db, 'nope')).toEqual([]);
  });
});
