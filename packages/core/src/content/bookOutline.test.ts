import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createContentType } from './types.js';
import { createItem } from './items.js';
import { bookOutline } from './bookOutline.js';
import { bookNavigation } from './bookNav.js';
import type { ContentTypeRow } from '../db/schema.js';

/**
 * A book's outline.
 *
 * The one property worth defending hardest: **reading order is not path order**. `path` sorts
 * lexicographically and `position` is what an editor arranged, and a book where those two agree —
 * which is any book whose sections were created alphabetically — cannot tell a correct
 * implementation from one that just sorted by path. Every ordering test below is deliberately built
 * so the two disagree.
 */

let handle: TaprootDb;
let pageType: ContentTypeRow;
let bookType: ContentTypeRow;

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

  pageType = await createContentType(handle.db, {
    ...typeInput,
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
  });

  bookType = await createContentType(handle.db, {
    ...typeInput,
    api_id: 'catalog',
    name: 'Catalog',
    name_plural: 'Catalogs',
    kind: 'page',
    book_root: true,
  });
});

async function section(title: string, parentId: string, status: 'published' | 'draft' = 'published') {
  return createItem(handle, pageType, [], {
    contentTypeId: pageType.id,
    title,
    parentId,
    status,
  });
}

async function book(title = 'Catalog') {
  return createItem(handle, bookType, [], {
    contentTypeId: bookType.id,
    title,
    status: 'published',
  });
}

describe('bookOutline', () => {
  it('is undefined for a path that is not a book root', async () => {
    const plain = await createItem(handle, pageType, [], {
      contentTypeId: pageType.id,
      title: 'About',
      status: 'published',
    });

    // Undefined rather than an empty outline, so a route can answer 404: "no such book" and "a book
    // with no sections" are different facts and a consumer acts differently on each.
    expect(await bookOutline(handle.db, plain.path)).toBeUndefined();
    expect(await bookOutline(handle.db, '/nothing-here')).toBeUndefined();
  });

  it('answers an empty outline for a book with no sections', async () => {
    const root = await book();
    const outline = await bookOutline(handle.db, root.path);

    expect(outline?.entries).toEqual([]);
    expect(outline?.complete).toBe(true);
    expect(outline?.root.id).toBe(root.id);
  });

  /**
   * Created in reverse alphabetical order, so `position` and `path` disagree.
   *
   * Sorted by path this comes back Admissions, Policies, Welcome. In reading order it is the order
   * the editor built it in — which is the whole reason the walk happens in memory rather than in an
   * `order by`.
   */
  it('orders siblings by position, not by path', async () => {
    const root = await book();
    await section('Welcome', root.id);
    await section('Policies', root.id);
    await section('Admissions', root.id);

    const outline = await bookOutline(handle.db, root.path);
    expect(outline?.entries.map((entry) => entry.title)).toEqual([
      'Welcome',
      'Policies',
      'Admissions',
    ]);
  });

  it('walks depth-first, so a chapter is followed by its own sections', async () => {
    const root = await book();
    const welcome = await section('Welcome', root.id);
    await section('Zebras', welcome.id);
    await section('Aardvarks', welcome.id);
    await section('Policies', root.id);

    const outline = await bookOutline(handle.db, root.path);

    // Depth-first: the two children come between their parent and the next top-level chapter, and
    // in creation order rather than alphabetically.
    expect(outline?.entries.map((entry) => entry.title)).toEqual([
      'Welcome',
      'Zebras',
      'Aardvarks',
      'Policies',
    ]);
    expect(outline?.entries.map((entry) => entry.depth)).toEqual([0, 1, 1, 0]);
  });

  it('measures depth from the book, not from the site root', async () => {
    // The book is nested two levels down; its first chapter is still depth 0 inside the book.
    const shelf = await createItem(handle, pageType, [], {
      contentTypeId: pageType.id,
      title: 'Publications',
      status: 'published',
    });
    const root = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: '2026-27',
      parentId: shelf.id,
      status: 'published',
    });
    const chapter = await section('Welcome', root.id);
    await section('Hours', chapter.id);

    const outline = await bookOutline(handle.db, root.path);
    expect(outline?.entries.map((entry) => entry.depth)).toEqual([0, 1]);
    expect(root.depth).toBe(1);
  });

  it('carries each entry’s content type, which is what makes filtering the consumer’s call', async () => {
    const root = await book();
    await section('Welcome', root.id);

    const outline = await bookOutline(handle.db, root.path);
    expect(outline?.entries[0]!.typeApiId).toBe('page');
  });

  it('hides unpublished sections from a visitor and shows them to the admin', async () => {
    const root = await book();
    await section('Welcome', root.id);
    await section('Draft chapter', root.id, 'draft');

    const publicView = await bookOutline(handle.db, root.path);
    expect(publicView?.entries.map((entry) => entry.title)).toEqual(['Welcome']);

    const adminView = await bookOutline(handle.db, root.path, { includeUnpublished: true });
    expect(adminView?.entries.map((entry) => entry.title)).toEqual(['Welcome', 'Draft chapter']);
  });

  it('is undefined to a visitor when the book itself is unpublished', async () => {
    const root = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Next year',
      status: 'draft',
    });

    expect(await bookOutline(handle.db, root.path)).toBeUndefined();
    expect(await bookOutline(handle.db, root.path, { includeUnpublished: true })).toBeDefined();
  });

  /**
   * An unpublished chapter orphans its published children, and they are kept.
   *
   * Dropping them would remove from the table of contents pages a visitor can still reach by URL —
   * the navigation would disagree with the site. Same instinct as the taxonomy walk keeping a term
   * whose parent has gone: an odd-looking tree beats a lie.
   */
  it('keeps a published section whose parent is not visible', async () => {
    const root = await book();
    const hidden = await section('Unpublished chapter', root.id, 'draft');
    await section('Visible section', hidden.id);

    const outline = await bookOutline(handle.db, root.path);
    expect(outline?.entries.map((entry) => entry.title)).toEqual(['Visible section']);
  });

  it('does not reach into a sibling whose path merely starts the same way', async () => {
    const root = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Catalog',
      slug: 'catalog',
      status: 'published',
    });
    await section('Welcome', root.id);

    const decoy = await createItem(handle, pageType, [], {
      contentTypeId: pageType.id,
      title: 'Catalog archive',
      slug: 'catalog-archive',
      status: 'published',
    });
    await section('Old stuff', decoy.id);

    const outline = await bookOutline(handle.db, root.path);
    expect(outline?.entries.map((entry) => entry.path)).toEqual(['/catalog/welcome']);
  });

  it('feeds bookNavigation directly, which is the point of the shape', async () => {
    const root = await book();
    const welcome = await section('Welcome', root.id);
    await section('Hours', welcome.id);
    await section('Policies', root.id);

    const outline = await bookOutline(handle.db, root.path);
    const at = bookNavigation(outline!.entries, '/catalog/welcome/hours');

    expect(at.previous?.title).toBe('Welcome');
    expect(at.next?.title).toBe('Policies');
    expect(at.up?.title).toBe('Welcome');
  });
});
