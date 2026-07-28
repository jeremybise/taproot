import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';
import {
  ancestorPaths,
  buildCollectionPath,
  buildPath,
  computeSubtreeRewrite,
  isDescendantPath,
  normalizePath,
  pathDepth,
  slugify,
  uniqueSlug,
  wouldCreateCycle,
} from './paths.js';
import { createContentType, createField, deleteContentType, updateField } from './types.js';
import {
  createItem,
  deleteItem,
  getItemByPath,
  getRedirect,
  getSubtree,
  listItems,
  updateItem,
} from './items.js';
import { validateItemData } from '../validation/fields.js';

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

// ---------------------------------------------------------------------------
// Pure path helpers
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('How To Apply')).toBe('how-to-apply');
  });

  it('strips accents rather than percent-escaping them', () => {
    expect(slugify('Résumé Guidance')).toBe('resume-guidance');
  });

  it('drops apostrophes instead of turning them into separators', () => {
    expect(slugify("Dean's Office")).toBe('deans-office');
  });

  it('collapses punctuation and trims stray hyphens', () => {
    expect(slugify('  Spring 2026 — Open House!  ')).toBe('spring-2026-open-house');
  });

  it('returns an empty string for input with nothing usable', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('path construction', () => {
  it('builds nested paths', () => {
    expect(buildPath('/admissions', 'apply')).toBe('/admissions/apply');
  });

  it('treats a null parent as root level', () => {
    expect(buildPath(null, 'admissions')).toBe('/admissions');
  });

  it('type-prefixes collection paths', () => {
    expect(buildCollectionPath('events', 'spring-open-house')).toBe('/events/spring-open-house');
  });

  it('normalizes messy request paths', () => {
    expect(normalizePath('admissions//apply/')).toBe('/admissions/apply');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
  });

  it('computes depth', () => {
    expect(pathDepth('/')).toBe(0);
    expect(pathDepth('/admissions')).toBe(0);
    expect(pathDepth('/admissions/apply')).toBe(1);
    expect(pathDepth('/admissions/apply/deadlines')).toBe(2);
  });

  it('lists ancestors for breadcrumbs', () => {
    expect(ancestorPaths('/admissions/apply/deadlines')).toEqual(['/admissions', '/admissions/apply']);
  });

  it('identifies descendants without matching sibling prefixes', () => {
    expect(isDescendantPath('/admissions/apply', '/admissions')).toBe(true);
    // The bug this guards: "/admissions-office" must not count as under "/admissions".
    expect(isDescendantPath('/admissions-office', '/admissions')).toBe(false);
  });
});

describe('uniqueSlug', () => {
  it('returns the base slug when free', () => {
    expect(uniqueSlug('Apply', [])).toBe('apply');
  });

  it('appends a counter when taken', () => {
    expect(uniqueSlug('Apply', ['apply'])).toBe('apply-2');
    expect(uniqueSlug('Apply', ['apply', 'apply-2'])).toBe('apply-3');
  });

  it('falls back when the input slugifies to nothing', () => {
    expect(uniqueSlug('!!!', [])).toBe('item');
  });
});

describe('computeSubtreeRewrite', () => {
  const subtree = [
    { id: 'a', path: '/admissions', depth: 0 },
    { id: 'b', path: '/admissions/apply', depth: 1 },
    { id: 'c', path: '/admissions/apply/deadlines', depth: 2 },
  ];

  it('rewrites the root and every descendant', () => {
    const rewrites = computeSubtreeRewrite(subtree, 'a', '/admissions-and-aid');
    expect(rewrites.map((r) => r.newPath)).toEqual([
      '/admissions-and-aid',
      '/admissions-and-aid/apply',
      '/admissions-and-aid/apply/deadlines',
    ]);
  });

  it('shifts depth when the subtree moves to a different level', () => {
    const rewrites = computeSubtreeRewrite(subtree, 'a', '/about/admissions');
    expect(rewrites.map((r) => r.depth)).toEqual([1, 2, 3]);
  });

  it('refuses a subtree that does not contain its own root', () => {
    expect(() => computeSubtreeRewrite(subtree, 'missing', '/x')).toThrow(/does not contain/);
  });

  it('refuses a node that is not actually a descendant', () => {
    const mismatched = [...subtree, { id: 'z', path: '/unrelated', depth: 0 }];
    expect(() => computeSubtreeRewrite(mismatched, 'a', '/x')).toThrow(/not a descendant/);
  });

  it('detects a move that would create a cycle', () => {
    expect(wouldCreateCycle(subtree, 'c')).toBe(true);
    expect(wouldCreateCycle(subtree, 'outside')).toBe(false);
    expect(wouldCreateCycle(subtree, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

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

  const body = await createField(handle.db, type.id, {
    api_id: 'body',
    label: 'Body',
    type: 'text',
    required: false,
    localized: false,
    position: 0,
    config: {},
    help_text: null,
  });

  return { type, fields: [body] };
}

describe('content types', () => {
  it('rejects a duplicate api_id', async () => {
    await seedPageType();
    await expect(
      createContentType(handle.db, {
        api_id: 'page',
        name: 'Another',
        name_plural: 'Others',
        kind: 'collection',
        description: null,
        icon: null,
        url_prefix: null,
        title_field: null,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('defaults a collection url_prefix to its api_id', async () => {
    const type = await createContentType(handle.db, {
      api_id: 'event',
      name: 'Event',
      name_plural: 'Events',
      kind: 'collection',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: null,
    });
    expect(type.url_prefix).toBe('event');
  });

  it('refuses to delete a type that still has items', async () => {
    const { type, fields } = await seedPageType();
    await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Home' });

    // Cascading here would silently delete a department's entire content.
    await expect(deleteContentType(handle.db, type.id)).rejects.toThrow(/still use it/);
  });

  it('refuses to change a field type after creation', async () => {
    const { fields } = await seedPageType();
    await expect(updateField(handle.db, fields[0]!.id, { type: 'number' })).rejects.toThrow(
      /cannot be changed/,
    );
  });

  it('keeps a field config when an update does not mention it', async () => {
    // Regression: the API's PATCH schema derived from `fieldInputSchema.partial()` still carried
    // `config`'s `.default({})`, so renaming a field wiped its stored options. A select errored
    // loudly; a text field silently lost its length limits.
    const { type } = await seedPageType();
    const field = await createField(handle.db, type.id, {
      api_id: 'status',
      label: 'Status',
      type: 'select',
      required: false,
      localized: false,
      position: 1,
      help_text: null,
      config: { options: [{ label: 'Draft', value: 'draft' }], multiple: false },
    });

    const renamed = await updateField(handle.db, field.id, { label: 'Workflow status' });

    expect(renamed.label).toBe('Workflow status');
    expect(JSON.parse(renamed.config).options).toEqual([{ label: 'Draft', value: 'draft' }]);
  });

  it('replaces a field config when an update does provide one', async () => {
    const { type } = await seedPageType();
    const field = await createField(handle.db, type.id, {
      api_id: 'note',
      label: 'Note',
      type: 'text',
      required: false,
      localized: false,
      position: 1,
      help_text: null,
      config: { maxLength: 100 },
    });

    const updated = await updateField(handle.db, field.id, { config: { maxLength: 500 } });
    expect(JSON.parse(updated.config).maxLength).toBe(500);
  });

  it('rejects an invalid field config', async () => {
    const { type } = await seedPageType();
    await expect(
      createField(handle.db, type.id, {
        api_id: 'status',
        label: 'Status',
        type: 'select',
        required: false,
        localized: false,
        position: 1,
        help_text: null,
        // A select with no options is not a usable field.
        config: { options: [] },
      }),
    ).rejects.toThrow(/Invalid configuration/);
  });
});

describe('content items', () => {
  it('creates an item with a derived path', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'How To Apply',
    });

    expect(item.slug).toBe('how-to-apply');
    expect(item.path).toBe('/how-to-apply');
    expect(item.depth).toBe(0);
  });

  it('nests an item under its parent', async () => {
    const { type, fields } = await seedPageType();
    const parent = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
    });
    const child = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Apply',
      parentId: parent.id,
    });

    expect(child.path).toBe('/admissions/apply');
    expect(child.depth).toBe(1);
  });

  it('lets the same slug exist under different parents', async () => {
    const { type, fields } = await seedPageType();
    const admissions = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Admissions' });
    const aid = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Financial Aid' });

    const a = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Apply', parentId: admissions.id });
    const b = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Apply', parentId: aid.id });

    expect(a.path).toBe('/admissions/apply');
    expect(b.path).toBe('/financial-aid/apply');
  });

  it('disambiguates a duplicate slug under the same parent', async () => {
    const { type, fields } = await seedPageType();
    const first = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Apply' });
    const second = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Apply' });

    expect(first.slug).toBe('apply');
    expect(second.slug).toBe('apply-2');
  });

  it('enforces singleton uniqueness', async () => {
    const type = await createContentType(handle.db, {
      api_id: 'weather_banner',
      name: 'Weather Banner',
      name_plural: 'Weather Banners',
      kind: 'singleton',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: null,
    });

    await createItem(handle, type, [], { contentTypeId: type.id, title: 'Weather Banner' });
    await expect(
      createItem(handle, type, [], { contentTypeId: type.id, title: 'Weather Banner' }),
    ).rejects.toThrow(/already has an item/);
  });

  it('resolves a published item by path and hides drafts', async () => {
    const { type, fields } = await seedPageType();
    await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Live', status: 'published' });
    await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Hidden', status: 'draft' });

    expect((await getItemByPath(handle.db, '/live'))?.title).toBe('Live');
    expect(await getItemByPath(handle.db, '/hidden')).toBeUndefined();
    expect((await getItemByPath(handle.db, '/hidden', { publishedOnly: false }))?.title).toBe('Hidden');
  });

  it('rejects content that fails field validation', async () => {
    const { type } = await seedPageType();
    const required = await createField(handle.db, type.id, {
      api_id: 'summary',
      label: 'Summary',
      type: 'text',
      required: true,
      localized: false,
      position: 1,
      help_text: null,
      config: {},
    });

    await expect(
      createItem(handle, type, [required], { contentTypeId: type.id, title: 'X', data: {} }),
    ).rejects.toThrow(/validation/i);
  });
});

describe('cascading moves', () => {
  async function seedTree() {
    const { type, fields } = await seedPageType();
    const admissions = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Admissions', status: 'published' });
    const apply = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Apply', parentId: admissions.id, status: 'published' });
    const deadlines = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Deadlines', parentId: apply.id, status: 'published' });
    return { type, fields, admissions, apply, deadlines };
  }

  it('rewrites every descendant path when a parent is renamed', async () => {
    const { type, fields, admissions } = await seedTree();

    await updateItem(handle, type, fields, admissions.id, { slug: 'admissions-and-aid' });

    const { items } = await listItems(handle.db, {});
    const paths = items.map((i) => i.path).sort();
    expect(paths).toEqual([
      '/admissions-and-aid',
      '/admissions-and-aid/apply',
      '/admissions-and-aid/apply/deadlines',
    ]);
  });

  it('writes an automatic redirect for every moved path', async () => {
    const { type, fields, admissions } = await seedTree();
    await updateItem(handle, type, fields, admissions.id, { slug: 'admissions-and-aid' });

    expect(await getRedirect(handle.db, '/admissions')).toEqual({ to: '/admissions-and-aid', status: 301 });
    expect(await getRedirect(handle.db, '/admissions/apply')).toEqual({ to: '/admissions-and-aid/apply', status: 301 });
    expect(await getRedirect(handle.db, '/admissions/apply/deadlines')).toEqual({
      to: '/admissions-and-aid/apply/deadlines',
      status: 301,
    });
  });

  it('collapses redirect chains when an item moves twice', async () => {
    const { type, fields, admissions } = await seedTree();

    await updateItem(handle, type, fields, admissions.id, { slug: 'step-two' });
    await updateItem(handle, type, fields, admissions.id, { slug: 'step-three' });

    // The original path must hop straight to the final destination, not via the intermediate one.
    expect(await getRedirect(handle.db, '/admissions')).toEqual({ to: '/step-three', status: 301 });
    expect(await getRedirect(handle.db, '/step-two')).toEqual({ to: '/step-three', status: 301 });
  });

  it('updates depth when a subtree is re-parented', async () => {
    const { type, fields, admissions, apply } = await seedTree();
    const about = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'About' });

    await updateItem(handle, type, fields, apply.id, { parentId: about.id });

    const moved = await getItemByPath(handle.db, '/about/apply', { publishedOnly: false });
    const child = await getItemByPath(handle.db, '/about/apply/deadlines', { publishedOnly: false });

    expect(moved?.depth).toBe(1);
    expect(child?.depth).toBe(2);
    expect(moved?.parent_id).toBe(about.id);

    // The old parent keeps its own path.
    expect((await getItemByPath(handle.db, '/admissions', { publishedOnly: false }))?.id).toBe(admissions.id);
  });

  it('refuses to move an item underneath its own descendant', async () => {
    const { type, fields, admissions, deadlines } = await seedTree();

    await expect(
      updateItem(handle, type, fields, admissions.id, { parentId: deadlines.id }),
    ).rejects.toThrow(/underneath itself/);
  });

  it('leaves the tree untouched when a move is rejected', async () => {
    const { type, fields, admissions, deadlines } = await seedTree();

    await expect(
      updateItem(handle, type, fields, admissions.id, { parentId: deadlines.id }),
    ).rejects.toThrow();

    const { items } = await listItems(handle.db, {});
    expect(items.map((i) => i.path).sort()).toEqual([
      '/admissions',
      '/admissions/apply',
      '/admissions/apply/deadlines',
    ]);
  });

  it('reads a subtree without pulling in unrelated branches', async () => {
    const { type, fields, admissions } = await seedTree();
    await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Unrelated' });

    const subtree = await getSubtree(handle.db, admissions.id);
    expect(subtree).toHaveLength(3);
    expect(subtree.every((n) => n.path.startsWith('/admissions'))).toBe(true);
  });

  it('clears a stale redirect when a live item moves onto that path', async () => {
    const { type, fields } = await seedPageType();
    const page = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Old Home' });

    // Move away, leaving /old-home -> /new-home behind.
    await updateItem(handle, type, fields, page.id, { slug: 'new-home' });
    expect(await getRedirect(handle.db, '/old-home')).toBeDefined();

    // Now move something back onto /old-home; the stale redirect must not shadow it.
    const other = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Other' });
    await updateItem(handle, type, fields, other.id, { slug: 'old-home' });

    expect(await getRedirect(handle.db, '/old-home')).toBeUndefined();
    expect((await getItemByPath(handle.db, '/old-home', { publishedOnly: false }))?.id).toBe(other.id);
  });
});

describe('field validation', () => {
  function field(overrides: Partial<FieldRow>): FieldRow {
    return {
      id: 'f',
      content_type_id: 'ct',
      api_id: 'x',
      label: 'X',
      type: 'text',
      help_text: null,
      position: 0,
      required: 0,
      localized: 0,
      config: '{}',
      created_at: '',
      updated_at: '',
      ...overrides,
    } as FieldRow;
  }

  it('accepts a valid payload', () => {
    const result = validateItemData([field({ api_id: 'name' })], { name: 'Hello' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: 'Hello' });
  });

  it('rejects an empty string for a required field', () => {
    const result = validateItemData([field({ api_id: 'name', required: 1 })], { name: '' });
    expect(result.success).toBe(false);
    expect(result.errors.name).toBeDefined();
  });

  it('allows an omitted optional field', () => {
    expect(validateItemData([field({ api_id: 'name' })], {}).success).toBe(true);
  });

  it('enforces select options', () => {
    const select = field({
      api_id: 'status',
      type: 'select',
      required: 1,
      config: JSON.stringify({ options: [{ label: 'A', value: 'a' }], multiple: false }),
    });
    expect(validateItemData([select], { status: 'a' }).success).toBe(true);
    expect(validateItemData([select], { status: 'nope' }).success).toBe(false);
  });

  it('enforces number bounds', () => {
    const num = field({ api_id: 'n', type: 'number', required: 1, config: JSON.stringify({ min: 1, max: 10, integer: true }) });
    expect(validateItemData([num], { n: 5 }).success).toBe(true);
    expect(validateItemData([num], { n: 50 }).success).toBe(false);
    expect(validateItemData([num], { n: 1.5 }).success).toBe(false);
  });

  it('drops keys that no longer correspond to a field', () => {
    // A removed field must not make every existing item unsavable.
    const result = validateItemData([field({ api_id: 'name' })], { name: 'Hi', removed: 'stale' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: 'Hi' });
  });

  it('rejects non-object payloads', () => {
    expect(validateItemData([], 'nope').success).toBe(false);
    expect(validateItemData([], ['a']).success).toBe(false);
  });
});

describe('deletion', () => {
  it('removes an item', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Temp' });
    await deleteItem(handle, item.id);
    expect(await getItemByPath(handle.db, '/temp', { publishedOnly: false })).toBeUndefined();
  });

  it('orphans children rather than cascading the delete', async () => {
    const { type, fields } = await seedPageType();
    const parent = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Parent' });
    const child = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Child', parentId: parent.id });

    await deleteItem(handle, parent.id);

    // Deliberate: silently deleting a whole page tree is not a recoverable mistake.
    const { items } = await listItems(handle.db, {});
    expect(items.map((i) => i.id)).toEqual([child.id]);
  });
});
