import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createContentType } from './types.js';
import { createItem, getItem } from './items.js';
import { updateSubtree, visibleCountUnder } from './bulkSubtree.js';
import type { ContentTypeRow } from '../db/schema.js';

/**
 * Applying one change across a branch — superseding a catalog year.
 *
 * The properties worth defending: it must not become a route around the single-item status guard, it
 * must not erase SEO an editor wrote while setting one flag on it, and one refusal must not sink the
 * batch.
 */

let handle: TaprootDb;
let pageType: ContentTypeRow;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;

  pageType = await createContentType(handle.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    preview_path: null,
    summary_template: null,
    list_columns: null,
    list_sort: null,
    list_sort_field: null,
    default_og_image_id: null,
  });
});

async function page(
  title: string,
  parentId: string | null,
  status: 'published' | 'draft' = 'published',
  seo = {},
) {
  return createItem(handle, pageType, [], {
    contentTypeId: pageType.id,
    title,
    parentId,
    status,
    seo,
  });
}

describe('updateSubtree', () => {
  it('changes every descendant and leaves the root alone by default', async () => {
    const root = await page('2026-27', null);
    const a = await page('Admissions', root.id);
    const b = await page('Policies', root.id);

    const result = await updateSubtree(handle, root.id, { status: 'archived' });

    expect(result.changed).toBe(2);
    expect((await getItem(handle.db, a.id))?.status).toBe('archived');
    expect((await getItem(handle.db, b.id))?.status).toBe('archived');
    // The root is excluded unless asked for, matching `pathPrefix` everywhere else.
    expect((await getItem(handle.db, root.id))?.status).toBe('published');
  });

  it('includes the root when asked', async () => {
    const root = await page('2026-27', null);
    await page('Admissions', root.id);

    const result = await updateSubtree(handle, root.id, { status: 'archived', includeRoot: true });

    expect(result.changed).toBe(2);
    expect((await getItem(handle.db, root.id))?.status).toBe('archived');
  });

  it('sets noIndex without erasing the rest of an SEO panel', async () => {
    const root = await page('2026-27', null);
    const child = await page('Admissions', root.id, 'published', {
      title: 'Apply now',
      description: 'How to apply.',
    });

    await updateSubtree(handle, root.id, { noIndex: true });

    const after = await getItem(handle.db, child.id);
    expect(after?.seo).toMatchObject({
      title: 'Apply now',
      description: 'How to apply.',
      noIndex: true,
    });
  });

  it('clears noIndex by removing it, so unset has one spelling', async () => {
    const root = await page('2026-27', null);
    const child = await page('Admissions', root.id, 'published', { noIndex: true });

    await updateSubtree(handle, root.id, { noIndex: false });

    expect((await getItem(handle.db, child.id))?.seo.noIndex).toBeUndefined();
  });

  /**
   * The guard that stops a bulk tool being a way around the single-item path.
   *
   * `archived → published` is an arrow that does not exist, refused here for the same reason
   * `canChangeStatus` refuses it for an admin: a page coming back from the archive goes through
   * draft so somebody reads it first.
   */
  it('refuses an illegal transition and keeps going', async () => {
    const root = await page('2026-27', null);
    const archived = await page('Old', root.id, 'published');
    await updateSubtree(handle, root.id, { status: 'archived' });

    const legal = await page('New', root.id, 'draft');
    const result = await updateSubtree(handle, root.id, { status: 'published' });

    expect(result.refused.map((entry) => entry.id)).toEqual([archived.id]);
    expect(result.refused[0]!.reason).toContain('cannot go from archived to published');
    // The one it could move, it moved — a refusal must not sink the batch.
    expect((await getItem(handle.db, legal.id))?.status).toBe('published');
    expect(result.changed).toBe(1);
  });

  it('asks the permission callback and reports what it refused', async () => {
    const root = await page('2026-27', null);
    await page('Admissions', root.id, 'draft');

    const result = await updateSubtree(handle, root.id, {
      status: 'published',
      canChange: () => false,
    });

    expect(result.changed).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]!.reason).toContain('permission');
  });

  it('skips items already in the desired state, so a rerun writes nothing', async () => {
    const root = await page('2026-27', null);
    await page('Admissions', root.id, 'draft');

    const first = await updateSubtree(handle, root.id, { status: 'published' });
    const second = await updateSubtree(handle, root.id, { status: 'published' });

    expect(first.changed).toBe(1);
    // No revision recording a change nobody made.
    expect(second.changed).toBe(0);
  });

  it('stops at the limit and reports the remainder', async () => {
    const root = await page('2026-27', null);
    for (const title of ['A', 'B', 'C']) await page(title, root.id, 'draft');

    const first = await updateSubtree(handle, root.id, { status: 'published', limit: 2 });
    expect(first.changed).toBe(2);
    expect(first.remaining).toBe(1);

    const second = await updateSubtree(handle, root.id, { status: 'published', limit: 2 });
    expect(second.changed).toBe(1);
    expect(second.remaining).toBe(0);
  });

  it('refuses a call that would change nothing', async () => {
    const root = await page('2026-27', null);
    await expect(updateSubtree(handle, root.id, {})).rejects.toMatchObject({
      code: 'nothing_to_do',
    });
  });

  it('does not reach a sibling whose path merely starts the same way', async () => {
    const root = await createItem(handle, pageType, [], {
      contentTypeId: pageType.id,
      title: 'Catalog',
      slug: 'catalog',
      status: 'published',
    });
    const decoy = await createItem(handle, pageType, [], {
      contentTypeId: pageType.id,
      title: 'Catalog archive',
      slug: 'catalog-archive',
      status: 'published',
    });
    const inDecoy = await page('Old', decoy.id);

    await updateSubtree(handle, root.id, { status: 'archived' });
    expect((await getItem(handle.db, inDecoy.id))?.status).toBe('published');
  });
});

describe('visibleCountUnder', () => {
  it('counts what a visitor can currently see under a branch', async () => {
    const root = await page('2026-27', null);
    await page('Admissions', root.id, 'published');
    await page('Draft chapter', root.id, 'draft');

    // The number a confirmation screen needs: "this takes N pages off the site" reads, where "this
    // changes N rows" does not.
    expect(await visibleCountUnder(handle, root.id)).toBe(1);
  });
});
