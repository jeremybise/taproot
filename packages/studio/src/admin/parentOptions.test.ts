import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createContentType,
  createDb,
  createItem,
  migrateToLatest,
  type ContentTypeRow,
  type TaprootDb,
} from '@taprootcms/core';

import { parentCandidates } from './parentOptions.js';

/**
 * The candidate parents the item editor offers.
 *
 * The bug it exists for: both screens asked for `{ contentTypeId: contentType.id }`, so a tree
 * spanning several content types — Program under Program Group under Program Category — could be
 * written by `createItem` and then not expressed by the admin at all. The picker rendered blank on
 * every correctly-nested item, because a controlled `<select>` whose value matches no option shows
 * nothing.
 */

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

async function pageType(apiId: string, name: string, position: number): Promise<ContentTypeRow> {
  const type = await createContentType(handle.db, {
    api_id: apiId,
    name,
    name_plural: `${name}s`,
    kind: 'page',
  });

  // `createContentType` does not take a position, and the group order is what it drives.
  await handle.db
    .updateTable('content_types')
    .set({ position })
    .where('id', '=', type.id)
    .execute();

  return { ...type, position };
}

const item = (type: ContentTypeRow, title: string, parentId?: string) =>
  createItem(handle, type, [], { contentTypeId: type.id, title, parentId, status: 'published' });

describe('parentCandidates', () => {
  it('offers items of other content types, which is the whole point', async () => {
    const category = await pageType('program_category', 'Program Category', 1);
    const group = await pageType('program_group', 'Program Group', 2);
    const program = await pageType('program', 'Program', 3);

    const healthcare = await item(category, 'Healthcare');
    const nursing = await item(group, 'Nursing', healthcare.id);

    const candidates = await parentCandidates(handle.db, program);

    expect(candidates.map((c) => c.path)).toEqual(['/healthcare', '/healthcare/nursing']);
    expect(candidates.map((c) => c.typeName)).toEqual(['Program Category', 'Program Group']);
    expect(nursing.parent_id).toBe(healthcare.id);
  });

  it('groups contiguously in content type order, keeping path order inside a group', async () => {
    const category = await pageType('program_category', 'Program Category', 1);
    const group = await pageType('program_group', 'Program Group', 2);

    const business = await item(category, 'Business');
    const healthcare = await item(category, 'Healthcare');
    await item(group, 'Nursing', healthcare.id);
    await item(group, 'Accounting', business.id);

    const candidates = await parentCandidates(handle.db, category);

    // Both categories first because their type sorts first, then both groups — and within each,
    // the `path` ordering `listItemSummaries` defaults to.
    expect(candidates.map((c) => c.path)).toEqual([
      '/business',
      '/healthcare',
      '/business/accounting',
      '/healthcare/nursing',
    ]);
  });

  it('excludes the item itself and everything beneath it', async () => {
    const page = await pageType('page', 'Page', 1);

    const about = await item(page, 'About');
    const careers = await item(page, 'Careers', about.id);
    await item(page, 'Benefits', careers.id);
    const academics = await item(page, 'Academics');

    const candidates = await parentCandidates(handle.db, page, about);

    // Only the unrelated branch survives: `about` would be its own parent, and the other two would
    // put a node inside its own subtree.
    expect(candidates.map((c) => c.path)).toEqual([academics.path]);
  });

  it('does not mistake a sibling whose path merely starts with the same characters', async () => {
    const page = await pageType('page', 'Page', 1);

    const apply = await item(page, 'Apply');
    const applyNow = await item(page, 'Apply Now');

    const candidates = await parentCandidates(handle.db, page, apply);

    // `/apply-now` starts with `/apply` but is not under it — the check appends the separator for
    // exactly this reason.
    expect(applyNow.path).toBe('/apply-now');
    expect(candidates.map((c) => c.path)).toEqual(['/apply-now']);
  });

  it('answers nothing for a kind that cannot nest', async () => {
    const page = await pageType('page', 'Page', 1);
    await item(page, 'About');

    const collection = await createContentType(handle.db, {
      api_id: 'event',
      name: 'Event',
      name_plural: 'Events',
      kind: 'collection',
    });
    const singleton = await createContentType(handle.db, {
      api_id: 'homepage',
      name: 'Homepage',
      name_plural: 'Homepage',
      kind: 'singleton',
    });

    // `createItem` force-nulls `parentId` for both, so offering a choice would be offering one that
    // is discarded on save.
    expect(await parentCandidates(handle.db, collection)).toEqual([]);
    expect(await parentCandidates(handle.db, singleton)).toEqual([]);
  });

  it('leaves out items of non-page kinds, which have no place in a tree', async () => {
    const page = await pageType('page', 'Page', 1);
    const collection = await createContentType(handle.db, {
      api_id: 'event',
      name: 'Event',
      name_plural: 'Events',
      kind: 'collection',
    });

    await item(page, 'About');
    await createItem(handle, collection, [], {
      contentTypeId: collection.id,
      title: 'Open House',
      status: 'published',
    });

    const candidates = await parentCandidates(handle.db, page);

    // A collection item's path is `/events/open-house`, which is owned by its `url_prefix` — a page
    // nested under one would claim a path the collection believes it controls.
    expect(candidates.map((c) => c.path)).toEqual(['/about']);
  });
});
