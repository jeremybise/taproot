import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import type { ContentTypeRow, FieldRow, TaxonomyRow } from '../db/schema.js';
import { createContentType, createField } from './types.js';
import { createItem, deleteItem, updateItem } from './items.js';
import {
  buildTermTree,
  createTaxonomy,
  createTerm,
  deleteTaxonomy,
  deleteTerm,
  getTerm,
  getTermSubtree,
  itemIdsInTermBranch,
  listTerms,
  termIdsFromValue,
  termsForItem,
  updateTerm,
} from './taxonomies.js';

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

async function seedTaxonomy(hierarchical = true): Promise<TaxonomyRow> {
  return createTaxonomy(handle.db, {
    api_id: 'department',
    name: 'Department',
    name_plural: 'Departments',
    hierarchical,
  });
}

/** A page type carrying one multi-value taxonomy field pointed at the given taxonomy. */
async function seedTaggedType(
  taxonomyId: string,
): Promise<{ type: ContentTypeRow; fields: FieldRow[] }> {
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

  const departments = await createField(handle.db, type.id, {
    api_id: 'departments',
    label: 'Departments',
    type: 'taxonomy',
    required: false,
    localized: false,
    position: 0,
    config: { taxonomyId, multiple: true },
    help_text: null,
  });

  return { type, fields: [departments] };
}

describe('taxonomies', () => {
  it('derives an api_id and rejects a duplicate', async () => {
    const taxonomy = await createTaxonomy(handle.db, {
      api_id: 'Academic Department',
      name: 'Academic Department',
      name_plural: 'Academic Departments',
    });
    expect(taxonomy.api_id).toBe('academic-department');

    await expect(
      createTaxonomy(handle.db, {
        api_id: 'academic-department',
        name: 'Another',
        name_plural: 'Others',
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('refuses to delete a taxonomy a field still points at', async () => {
    const taxonomy = await seedTaxonomy();
    await seedTaggedType(taxonomy.id);

    // Cascading would take the terms with it and leave every tagged item holding dead ids.
    await expect(deleteTaxonomy(handle.db, taxonomy.id)).rejects.toThrow(/still reference it/);
  });

  it('deletes a taxonomy nothing points at, and its terms with it', async () => {
    const taxonomy = await seedTaxonomy();
    await createTerm(handle.db, taxonomy.id, { name: 'Admissions' });

    await deleteTaxonomy(handle.db, taxonomy.id);

    expect(await listTerms(handle.db, taxonomy.id)).toEqual([]);
  });
});

describe('terms', () => {
  it('nests terms and tracks depth', async () => {
    const taxonomy = await seedTaxonomy();
    const parent = await createTerm(handle.db, taxonomy.id, { name: 'Admissions' });
    const child = await createTerm(handle.db, taxonomy.id, {
      name: 'Graduate',
      parentId: parent.id,
    });

    expect(parent.depth).toBe(0);
    expect(child.depth).toBe(1);
    expect(child.slug).toBe('graduate');
  });

  it('scopes slug uniqueness to siblings within a taxonomy', async () => {
    const taxonomy = await seedTaxonomy();
    const admissions = await createTerm(handle.db, taxonomy.id, { name: 'Admissions' });
    const programs = await createTerm(handle.db, taxonomy.id, { name: 'Programs' });

    // The same term name under two different parents is the normal case, not a collision.
    const a = await createTerm(handle.db, taxonomy.id, {
      name: 'Graduate',
      parentId: admissions.id,
    });
    const b = await createTerm(handle.db, taxonomy.id, {
      name: 'Graduate',
      parentId: programs.id,
    });

    expect(a.slug).toBe('graduate');
    expect(b.slug).toBe('graduate');
  });

  it('disambiguates a slug taken by a sibling', async () => {
    const taxonomy = await seedTaxonomy();
    await createTerm(handle.db, taxonomy.id, { name: 'Graduate' });
    const second = await createTerm(handle.db, taxonomy.id, { name: 'Graduate' });

    expect(second.slug).not.toBe('graduate');
  });

  it('refuses to nest terms in a flat taxonomy', async () => {
    const taxonomy = await seedTaxonomy(false);
    const parent = await createTerm(handle.db, taxonomy.id, { name: 'News' });

    await expect(
      createTerm(handle.db, taxonomy.id, { name: 'Sports', parentId: parent.id }),
    ).rejects.toThrow(/flat taxonomy/);
  });

  it('refuses a parent from a different taxonomy', async () => {
    const departments = await seedTaxonomy();
    const topics = await createTaxonomy(handle.db, {
      api_id: 'topic',
      name: 'Topic',
      name_plural: 'Topics',
    });
    const foreign = await createTerm(handle.db, topics.id, { name: 'Research' });

    await expect(
      createTerm(handle.db, departments.id, { name: 'Admissions', parentId: foreign.id }),
    ).rejects.toThrow(/different taxonomy/);
  });

  it('re-depths the whole subtree when a branch moves', async () => {
    const taxonomy = await seedTaxonomy();
    const root = await createTerm(handle.db, taxonomy.id, { name: 'Academics' });
    const mid = await createTerm(handle.db, taxonomy.id, { name: 'Sciences', parentId: root.id });
    const leaf = await createTerm(handle.db, taxonomy.id, { name: 'Biology', parentId: mid.id });

    expect(leaf.depth).toBe(2);

    // Promote the middle branch to the root; the leaf has to come up with it.
    await updateTerm(handle, mid.id, { parentId: null });

    expect((await getTerm(handle.db, mid.id))!.depth).toBe(0);
    expect((await getTerm(handle.db, leaf.id))!.depth).toBe(1);
  });

  it('refuses to move a term under its own descendant', async () => {
    const taxonomy = await seedTaxonomy();
    const root = await createTerm(handle.db, taxonomy.id, { name: 'Academics' });
    const child = await createTerm(handle.db, taxonomy.id, { name: 'Sciences', parentId: root.id });

    await expect(updateTerm(handle, root.id, { parentId: child.id })).rejects.toThrow(
      /underneath itself/,
    );
  });

  it('promotes children rather than orphaning them when a term is deleted', async () => {
    const taxonomy = await seedTaxonomy();
    const root = await createTerm(handle.db, taxonomy.id, { name: 'Academics' });
    const mid = await createTerm(handle.db, taxonomy.id, { name: 'Sciences', parentId: root.id });
    const leaf = await createTerm(handle.db, taxonomy.id, { name: 'Biology', parentId: mid.id });

    await deleteTerm(handle, mid.id);

    const promoted = await getTerm(handle.db, leaf.id);
    // The leaf keeps its place under Academics instead of being silently flung to the root.
    expect(promoted!.parent_id).toBe(root.id);
    expect(promoted!.depth).toBe(1);
  });

  it('reads a subtree in one query', async () => {
    const taxonomy = await seedTaxonomy();
    const root = await createTerm(handle.db, taxonomy.id, { name: 'Academics' });
    const mid = await createTerm(handle.db, taxonomy.id, { name: 'Sciences', parentId: root.id });
    await createTerm(handle.db, taxonomy.id, { name: 'Biology', parentId: mid.id });
    await createTerm(handle.db, taxonomy.id, { name: 'Athletics' });

    const subtree = await getTermSubtree(handle.db, root.id);
    expect(subtree).toHaveLength(3);
  });

  it('builds a tree, keeping an orphaned branch visible', () => {
    const rows = [
      { id: 'a', parent_id: null, name: 'A' },
      { id: 'b', parent_id: 'a', name: 'B' },
      { id: 'c', parent_id: 'missing', name: 'C' },
    ] as unknown as Parameters<typeof buildTermTree>[0];

    const tree = buildTermTree(rows);
    // C's parent is gone; dropping it would hide the term from the only screen that could fix it.
    expect(tree.map((node) => node.id)).toEqual(['a', 'c']);
    expect(tree[0]!.children.map((node) => node.id)).toEqual(['b']);
  });
});

describe('assignment index', () => {
  it('indexes terms from the item’s authored data', async () => {
    const taxonomy = await seedTaxonomy();
    const { type, fields } = await seedTaggedType(taxonomy.id);
    const admissions = await createTerm(handle.db, taxonomy.id, { name: 'Admissions' });

    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'How to apply',
      data: { departments: [admissions.id] },
    });

    const assigned = await termsForItem(handle.db, item.id);
    expect(assigned.map((term) => term.name)).toEqual(['Admissions']);
    expect(assigned[0]!.field_api_id).toBe('departments');
  });

  it('rebuilds the index on every save rather than accumulating', async () => {
    const taxonomy = await seedTaxonomy();
    const { type, fields } = await seedTaggedType(taxonomy.id);
    const a = await createTerm(handle.db, taxonomy.id, { name: 'Admissions' });
    const b = await createTerm(handle.db, taxonomy.id, { name: 'Athletics' });

    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Page',
      data: { departments: [a.id] },
    });

    await updateItem(handle, type, fields, item.id, { data: { departments: [b.id] } });

    const assigned = await termsForItem(handle.db, item.id);
    expect(assigned.map((term) => term.name)).toEqual(['Athletics']);
  });

  it('clears the index when the tags are removed', async () => {
    const taxonomy = await seedTaxonomy();
    const { type, fields } = await seedTaggedType(taxonomy.id);
    const a = await createTerm(handle.db, taxonomy.id, { name: 'Admissions' });

    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Page',
      data: { departments: [a.id] },
    });
    await updateItem(handle, type, fields, item.id, { data: { departments: [] } });

    expect(await termsForItem(handle.db, item.id)).toEqual([]);
  });

  it('refuses a save referencing a term that does not exist', async () => {
    const taxonomy = await seedTaxonomy();
    const { type, fields } = await seedTaggedType(taxonomy.id);

    // Caught before the batch is submitted, so the caller gets a per-field message rather than a
    // foreign key error from statement nine of twelve.
    await expect(
      createItem(handle, type, fields, {
        contentTypeId: type.id,
        title: 'Page',
        data: { departments: ['does-not-exist'] },
      }),
    ).rejects.toMatchObject({ fieldErrors: { departments: [expect.stringContaining('no longer')] } });
  });

  it('absorbs the same term picked twice', async () => {
    const taxonomy = await seedTaxonomy();
    const { type, fields } = await seedTaggedType(taxonomy.id);
    const a = await createTerm(handle.db, taxonomy.id, { name: 'Admissions' });

    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Page',
      data: { departments: [a.id, a.id] },
    });

    expect(await termsForItem(handle.db, item.id)).toHaveLength(1);
  });

  it('drops an item’s assignments when the item goes', async () => {
    const taxonomy = await seedTaxonomy();
    const { type, fields } = await seedTaggedType(taxonomy.id);
    const a = await createTerm(handle.db, taxonomy.id, { name: 'Admissions' });

    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Page',
      data: { departments: [a.id] },
    });
    await deleteItem(handle, item.id);

    expect(await itemIdsInTermBranch(handle.db, a.id)).toEqual([]);
  });

  it('finds every item tagged anywhere in a branch', async () => {
    const taxonomy = await seedTaxonomy();
    const { type, fields } = await seedTaggedType(taxonomy.id);
    const academics = await createTerm(handle.db, taxonomy.id, { name: 'Academics' });
    const biology = await createTerm(handle.db, taxonomy.id, {
      name: 'Biology',
      parentId: academics.id,
    });
    const athletics = await createTerm(handle.db, taxonomy.id, { name: 'Athletics' });

    const tagged = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Biology degree',
      data: { departments: [biology.id] },
    });
    await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Fixtures',
      data: { departments: [athletics.id] },
    });

    // Filtering a listing by a branch: everything under Academics, including deeper terms.
    expect(await itemIdsInTermBranch(handle.db, academics.id)).toEqual([tagged.id]);
  });

  it('restoring a revision restores its tags', async () => {
    const taxonomy = await seedTaxonomy();
    const { type, fields } = await seedTaggedType(taxonomy.id);
    const a = await createTerm(handle.db, taxonomy.id, { name: 'Admissions' });
    const b = await createTerm(handle.db, taxonomy.id, { name: 'Athletics' });

    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Page',
      data: { departments: [a.id] },
    });
    await updateItem(handle, type, fields, item.id, { data: { departments: [b.id] } });

    // Tags live in `data`, so they travel with the revision — which is the whole reason the
    // assignment table is an index rather than the source of truth.
    const { restoreRevision } = await import('./items.js');
    const { listRevisions } = await import('./revisions.js');
    const first = (await listRevisions(handle.db, item.id)).revisions.find(
      (revision) => revision.revision_number === 1,
    )!;

    await restoreRevision(handle, type, fields, item.id, first.id);

    expect((await termsForItem(handle.db, item.id)).map((term) => term.name)).toEqual([
      'Admissions',
    ]);
  });
});

describe('termIdsFromValue', () => {
  it('accepts both the single and multiple shapes', () => {
    expect(termIdsFromValue('a')).toEqual(['a']);
    expect(termIdsFromValue(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('treats empty and non-string values as no terms', () => {
    expect(termIdsFromValue('')).toEqual([]);
    expect(termIdsFromValue(null)).toEqual([]);
    expect(termIdsFromValue(undefined)).toEqual([]);
    expect(termIdsFromValue([1, 'a', null])).toEqual(['a']);
  });
});
