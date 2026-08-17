import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import {
  createContentType,
  isNavigable,
  listContentTypes,
  updateContentType,
} from './types.js';
import { createItem, listItemSummaries } from './items.js';

/**
 * Keeping a content type out of the sidebar.
 *
 * The tests that matter are the negative ones. A flag called "hide" is one `.filter` away from being
 * a delete that does not delete, and the failure would be silent: an editor's pages still in the
 * database, still at their URLs, and absent from every screen that could find them. So most of what
 * follows asserts that hiding a type changes *nothing* except the sidebar's own list.
 */

let handle: TaprootDb;

const typeInput = {
  description: null,
  icon: null,
  url_prefix: null,
  preview_path: null,
  summary_template: null,
  list_columns: null,
  list_sort: null,
  list_sort_field: null,
  default_og_image_id: null,
};

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

const type = (apiId: string, extra: Record<string, unknown> = {}) =>
  createContentType(handle.db, {
    ...typeInput,
    api_id: apiId,
    name: apiId,
    name_plural: `${apiId}s`,
    kind: 'page',
    ...extra,
  });

describe('isNavigable', () => {
  it('is true by default, so no existing sidebar changes', async () => {
    const plain = await type('page');

    expect(plain.hide_from_nav).toBe(0);
    expect(isNavigable(plain)).toBe(true);
  });

  it('is false for a type that asked to be hidden', async () => {
    const hidden = await type('catalog_section', { hide_from_nav: true });

    expect(hidden.hide_from_nav).toBe(1);
    expect(isNavigable(hidden)).toBe(false);
  });

  /** A block type has no list screen to link to, so a sidebar entry for one would 404. */
  it('is false for a block type whatever the column says', async () => {
    const block = await createContentType(handle.db, {
      ...typeInput,
      api_id: 'hero',
      name: 'Hero',
      name_plural: 'Heroes',
      kind: 'block',
      hide_from_nav: false,
    });

    expect(isNavigable(block)).toBe(false);
  });

  it('applies to every kind, because every kind can clutter', async () => {
    for (const kind of ['page', 'collection', 'singleton'] as const) {
      const hidden = await createContentType(handle.db, {
        ...typeInput,
        api_id: `hidden_${kind}`,
        name: kind,
        name_plural: kind,
        kind,
        hide_from_nav: true,
      });

      // Unlike `url_prefix` and `preview_path`, no write path forces this by kind — a singleton
      // takes a sidebar row exactly as a collection does.
      expect(hidden.hide_from_nav).toBe(1);
      expect(isNavigable(hidden)).toBe(false);
    }
  });

  it('can be turned back on', async () => {
    const hidden = await type('catalog_section', { hide_from_nav: true });
    const shown = await updateContentType(handle.db, hidden.id, { hide_from_nav: false });

    expect(isNavigable(shown)).toBe(true);
  });

  it('is untouched by a patch that does not mention it', async () => {
    const hidden = await type('catalog_section', { hide_from_nav: true });
    const renamed = await updateContentType(handle.db, hidden.id, { name: 'Section' });

    expect(renamed.hide_from_nav).toBe(1);
  });
});

describe('what hiding a type does not do', () => {
  /**
   * The whole point. Filtering anything but the sidebar by this column would strand every item of
   * the type in a deployment whose own UI could not reach them — "never leave a deployment in a
   * state its own UI cannot reach", broken in the cheapest possible place.
   */
  it('leaves the type in listContentTypes, so its own screens still work', async () => {
    const hidden = await type('catalog_section', { hide_from_nav: true });

    const listed = await listContentTypes(handle.db);

    expect(listed.map((t) => t.api_id)).toContain('catalog_section');
    expect(hidden.id).toBeTruthy();
  });

  it('leaves its items in a cross-type listing, which is how they stay reachable', async () => {
    const hidden = await type('catalog_section', { hide_from_nav: true });
    await createItem(handle, hidden, [], {
      contentTypeId: hidden.id,
      title: 'Admissions',
      status: 'published',
    });

    const { items } = await listItemSummaries(handle.db, { limit: 20 });

    expect(items.map((item) => item.title)).toContain('Admissions');
  });

  it('leaves its items findable by search', async () => {
    const hidden = await type('catalog_section', { hide_from_nav: true });
    await createItem(handle, hidden, [], {
      contentTypeId: hidden.id,
      title: 'Admissions',
      status: 'published',
    });

    const { items } = await listItemSummaries(handle.db, { search: 'Admissions', limit: 20 });

    expect(items.map((item) => item.title)).toContain('Admissions');
  });

  it('leaves its own filtered list working', async () => {
    const hidden = await type('catalog_section', { hide_from_nav: true });
    await createItem(handle, hidden, [], {
      contentTypeId: hidden.id,
      title: 'Admissions',
      status: 'published',
    });

    const { items } = await listItemSummaries(handle.db, {
      contentTypeId: hidden.id,
      limit: 20,
    });

    expect(items).toHaveLength(1);
  });
});
