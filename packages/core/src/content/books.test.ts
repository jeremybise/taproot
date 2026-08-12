import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createContentType, createField, updateContentType } from './types.js';
import { createItem, updateItem, ContentItemError } from './items.js';
import {
  bookRootBlockers,
  bookRootFor,
  bookRootWithin,
  holdsSharedContent,
  typeIsBookRoot,
  wouldNestBook,
} from './books.js';
import { createReusableBlock } from './reusableBlocks.js';
import { createSnippet } from './snippets.js';
import { descendantPathRange } from './paths.js';
import type { ContentTypeRow } from '../db/schema.js';

/**
 * Books — the content type flag, and the one structural rule it carries.
 *
 * The flag itself is small. What is worth testing is the pair of invariants everything else assumes:
 * that `book_root` is meaningless for any kind that has no tree, and that two book roots can never
 * end up on one ancestor chain — because `bookRootFor` answers "which book is this in" and a nested
 * pair makes that question have two right answers.
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
    api_id: 'handbook',
    name: 'Handbook',
    name_plural: 'Handbooks',
    kind: 'page',
    book_root: true,
  });
});

describe('the book_root column', () => {
  it('is set for a page that asked for it', () => {
    expect(bookType.book_root).toBe(1);
    expect(typeIsBookRoot(bookType)).toBe(true);
  });

  it('defaults off, so no existing deployment gains a book it did not ask for', () => {
    expect(pageType.book_root).toBe(0);
    expect(typeIsBookRoot(pageType)).toBe(false);
  });

  /**
   * The rule `url_prefix`, `preview_path` and `item_pages` all follow: forced by the write path
   * rather than trusted from the input, so changing a type's kind cannot leave a column saying
   * something its reader will never consult.
   */
  it('is forced off for every kind that has no tree, even when asked for', async () => {
    for (const kind of ['collection', 'singleton', 'block'] as const) {
      const type = await createContentType(handle.db, {
        ...typeInput,
        api_id: `thing_${kind}`,
        name: kind,
        name_plural: kind,
        kind,
        book_root: true,
      });

      expect(type.book_root).toBe(0);
      expect(typeIsBookRoot(type)).toBe(false);
    }
  });

  it('is cleared when a book type is switched to a kind that cannot be one', async () => {
    const switched = await updateContentType(handle.db, bookType.id, { kind: 'collection' });
    expect(switched.book_root).toBe(0);

    // And does not come back on its own when switched away and back, which is the trap `item_pages`
    // names: a 0 left behind for whoever switches it back.
    const returned = await updateContentType(handle.db, bookType.id, { kind: 'page' });
    expect(returned.book_root).toBe(0);
  });

  it('keeps what is stored when a patch does not mention it', async () => {
    const renamed = await updateContentType(handle.db, bookType.id, { name: 'Manual' });
    expect(renamed.book_root).toBe(1);
  });
});

describe('bookRootFor', () => {
  it('finds the book from any depth in one query, and includes the root itself', async () => {
    const book = await createItem(handle, bookType, [], { contentTypeId: bookType.id, title: 'Nursing Handbook' });
    const chapter = await createItem(handle, pageType, [], {
      contentTypeId: pageType.id,
      title: 'Attendance',
      parentId: book.id,
    });
    const section = await createItem(handle, pageType, [], {
      contentTypeId: pageType.id,
      title: 'Absences',
      parentId: chapter.id,
    });

    expect((await bookRootFor(handle.db, section.path))?.id).toBe(book.id);
    expect((await bookRootFor(handle.db, chapter.path))?.id).toBe(book.id);
    // Its own book — which is what makes the nesting check read as `wouldNestBook(parent)`.
    expect((await bookRootFor(handle.db, book.path))?.id).toBe(book.id);
  });

  it('answers undefined outside any book', async () => {
    const loose = await createItem(handle, pageType, [], {
      contentTypeId: pageType.id,
      title: 'About',
    });

    expect(await bookRootFor(handle.db, loose.path)).toBeUndefined();
    expect(await wouldNestBook(handle.db, null)).toBeUndefined();
  });

  /**
   * A sibling whose path is a string prefix of the book's is not in the book.
   *
   * `/nursing-handbook-archive` starts with `/nursing-handbook`, so any implementation reaching for
   * `startsWith` or `like 'path%'` puts it inside. This one asks about *ancestors*, which is a
   * different question and the right one.
   */
  it('does not claim a sibling whose path merely starts the same way', async () => {
    const book = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Handbook',
      slug: 'handbook',
    });
    const sibling = await createItem(handle, pageType, [], {
      contentTypeId: pageType.id,
      title: 'Handbook archive',
      slug: 'handbook-archive',
    });

    expect(book.path).toBe('/handbook');
    expect(sibling.path).toBe('/handbook-archive');
    expect(await bookRootFor(handle.db, sibling.path)).toBeUndefined();
  });
});

describe('books cannot be nested', () => {
  it('refuses a book created inside another book', async () => {
    const outer = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Catalog',
    });

    await expect(
      createItem(handle, bookType, [], {
        contentTypeId: bookType.id,
        title: 'Inner',
        parentId: outer.id,
      }),
    ).rejects.toMatchObject({ code: 'nested_book' });
  });

  it('allows a book beside another book, and under an ordinary page', async () => {
    const shelf = await createItem(handle, pageType, [], {
      contentTypeId: pageType.id,
      title: 'Catalog',
    });

    const first = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: '2026-27',
      parentId: shelf.id,
    });
    const second = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: '2027-28',
      parentId: shelf.id,
    });

    // The editions model: two books under an ordinary parent, which is what a year switcher reads.
    expect(first.path).toBe('/catalog/2026-27');
    expect(second.path).toBe('/catalog/2027-28');
  });

  it('refuses moving a book into another book', async () => {
    const book = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Catalog',
    });
    const other = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Handbook',
    });

    await expect(
      updateItem(handle, bookType, [], other.id, { parentId: book.id }),
    ).rejects.toMatchObject({ code: 'nested_book' });
  });

  /**
   * The case the type check alone cannot see, and the reason `bookRootWithin` exists.
   *
   * The item being moved is an ordinary page, so nothing about *it* is a book — but it holds one,
   * and moving it into a book leaves two roots on one ancestor chain.
   */
  it('refuses moving an ordinary page that holds a book into a book', async () => {
    const staging = await createItem(handle, pageType, [], {
      contentTypeId: pageType.id,
      title: 'Staging',
    });
    await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Next year',
      parentId: staging.id,
    });

    const book = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Catalog',
    });

    await expect(
      updateItem(handle, pageType, [], staging.id, { parentId: book.id }),
    ).rejects.toMatchObject({ code: 'nested_book' });
  });

  it('allows an ordinary move and a rename inside a book', async () => {
    const book = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Catalog',
    });
    const one = await createItem(handle, pageType, [], {
      contentTypeId: pageType.id,
      title: 'Admissions',
      parentId: book.id,
    });
    const two = await createItem(handle, pageType, [], {
      contentTypeId: pageType.id,
      title: 'Apply',
      parentId: book.id,
    });

    const moved = await updateItem(handle, pageType, [], two.id, { parentId: one.id });
    expect(moved.path).toBe('/catalog/admissions/apply');

    const renamed = await updateItem(handle, bookType, [], book.id, { slug: 'catalog-2027' });
    expect(renamed.path).toBe('/catalog-2027');
  });

  it('reports which book is already there, so the message can be acted on', async () => {
    const book = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Student Handbook',
    });

    const error = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Inner',
      parentId: book.id,
    }).catch((cause: unknown) => cause as ContentItemError);

    expect(error).toBeInstanceOf(ContentItemError);
    expect(error.message).toContain('Student Handbook');
  });
});

describe('bookRootWithin', () => {
  it('is undefined for an empty set rather than querying for nothing', async () => {
    expect(await bookRootWithin(handle.db, [])).toBeUndefined();
  });
});

/**
 * The bounds the subtree filter is built on.
 *
 * Tested here rather than only through a query because the failure is silent in both directions: a
 * bound that is too wide pulls in a sibling, and one that is too narrow drops a real descendant, and
 * both look like a working filter on the data somebody happens to have.
 */
describe('descendantPathRange', () => {
  it('brackets exactly the descendants of a path', () => {
    const { start, end } = descendantPathRange('/catalog/2026-27');
    expect(start).toBe('/catalog/2026-27/');
    expect(end).toBe('/catalog/2026-270');

    const inside = '/catalog/2026-27/admissions';
    expect(inside > start && inside < end).toBe(true);
  });

  it('excludes the root itself', () => {
    const { start, end } = descendantPathRange('/catalog');
    const root = '/catalog';
    expect(root > start && root < end).toBe(false);
  });

  /**
   * `-` is 0x2D and sorts *below* `/` at 0x2F, so a hyphenated sibling falls under the range's
   * start; `0` is 0x30 and sorts above it. Both are the reason the bounds are what they are, and
   * both are what a naive `like 'path%'` would get wrong.
   */
  it('excludes siblings that merely share the prefix, on both sides', () => {
    const { start, end } = descendantPathRange('/catalog');

    for (const sibling of ['/catalog-archive', '/catalog0zzz', '/catalogue']) {
      expect(sibling > start && sibling < end).toBe(false);
    }
  });

  it('treats the site root as containing everything but itself', () => {
    const { start, end } = descendantPathRange('/');
    expect(start).toBe('/');
    expect(end).toBe('0');

    expect('/' > start && '/' < end).toBe(false);
    expect('/about' > start && '/about' < end).toBe(true);
  });
});

/**
 * The refusal, through the real write paths.
 *
 * `fields.test.ts` proves the rule at all three walk sites; this proves the write paths actually
 * *derive* it — that an item lands in a book, that the destination decides rather than the origin,
 * and that nothing outside a book is affected.
 */
describe('a book refuses shared content', () => {
  let library: string;

  beforeEach(async () => {
    const blockType = await createContentType(handle.db, {
      ...typeInput,
      api_id: 'card',
      name: 'Card',
      name_plural: 'Cards',
      kind: 'block',
    });
    const blockFields = [
      await createField(handle.db, blockType.id, {
        api_id: 'body',
        label: 'Body',
        type: 'richtext',
        required: false,
        localized: false,
        position: 0,
        config: {},
      }),
    ];

    const entry = await createReusableBlock(handle.db, blockFields, {
      name: 'Accreditation',
      blockType: 'card',
      data: { body: '<p>Accredited since 1970.</p>' },
    });
    library = entry.id;

    await createSnippet(handle.db, {
      api_id: 'tuition',
      name: 'Tuition',
      kind: 'text',
      value: '$4,500',
    });
  });

  async function bodyField(type: ContentTypeRow, fieldType: 'richtext' | 'block') {
    return [
      await createField(handle.db, type.id, {
        api_id: 'body',
        label: 'Body',
        type: fieldType,
        required: false,
        localized: false,
        position: 0,
        config: {},
      }),
    ];
  }

  it('refuses a snippet token in a section, and allows it outside the book', async () => {
    const fields = await bodyField(pageType, 'richtext');
    const book = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Catalog',
    });

    await expect(
      createItem(handle, pageType, fields, {
        contentTypeId: pageType.id,
        title: 'Costs',
        parentId: book.id,
        data: { body: '<p>Tuition is {{ tuition }}.</p>' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    // The same content is fine on an ordinary page — the rule is about books, not about snippets.
    const loose = await createItem(handle, pageType, fields, {
      contentTypeId: pageType.id,
      title: 'Costs',
      data: { body: '<p>Tuition is {{ tuition }}.</p>' },
    });
    expect(loose.id).toBeTruthy();
  });

  it('refuses a reusable block placed in a section', async () => {
    const fields = await bodyField(pageType, 'block');
    const book = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Catalog',
    });

    await expect(
      createItem(handle, pageType, fields, {
        contentTypeId: pageType.id,
        title: 'Front matter',
        parentId: book.id,
        data: { body: [{ id: 'b1', type: 'card', data: {}, ref: library }] },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  /** A book root is inside its own book — front matter goes stale exactly as a section does. */
  it('refuses shared content on the book root itself', async () => {
    const fields = await bodyField(bookType, 'richtext');

    await expect(
      createItem(handle, bookType, fields, {
        contentTypeId: bookType.id,
        title: 'Catalog',
        data: { body: '<p>Tuition is {{ tuition }}.</p>' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('reaches a section nested several levels down', async () => {
    const fields = await bodyField(pageType, 'richtext');
    const book = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Catalog',
    });
    const chapter = await createItem(handle, pageType, fields, {
      contentTypeId: pageType.id,
      title: 'Admissions',
      parentId: book.id,
    });

    await expect(
      createItem(handle, pageType, fields, {
        contentTypeId: pageType.id,
        title: 'Apply',
        parentId: chapter.id,
        data: { body: '<p>{{ tuition }}</p>' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  /**
   * The destination decides, not the origin.
   *
   * Reading the item's *current* path would let somebody author a snippet outside a book and then
   * drag the page in, which is the same violation arrived at sideways.
   */
  it('refuses moving a page carrying a snippet into a book', async () => {
    const fields = await bodyField(pageType, 'richtext');
    const book = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Catalog',
    });
    const loose = await createItem(handle, pageType, fields, {
      contentTypeId: pageType.id,
      title: 'Costs',
      data: { body: '<p>Tuition is {{ tuition }}.</p>' },
    });

    await expect(
      updateItem(handle, pageType, fields, loose.id, {
        parentId: book.id,
        data: { body: '<p>Tuition is {{ tuition }}.</p>' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('lets a section save ordinary content, which is the common case', async () => {
    const fields = await bodyField(pageType, 'richtext');
    const book = await createItem(handle, bookType, [], {
      contentTypeId: bookType.id,
      title: 'Catalog',
    });

    const section = await createItem(handle, pageType, fields, {
      contentTypeId: pageType.id,
      title: 'Admissions',
      parentId: book.id,
      data: { body: '<p>Apply by August.</p>' },
    });

    expect(section.path).toBe('/catalog/admissions');
  });
});

describe('holdsSharedContent', () => {
  it('finds a ref and a token at any depth, and is quiet otherwise', () => {
    expect(holdsSharedContent({ body: [{ id: 'b', type: 'c', data: {}, ref: 'lib-1' }] })).toBe(true);
    expect(holdsSharedContent({ rows: [{ data: { note: 'Costs {{ tuition }}' } }] })).toBe(true);
    expect(holdsSharedContent({ title: 'Plain', n: 3, ok: true, empty: null })).toBe(false);
    // An empty `ref` is not a placement — it is the absence of one written out.
    expect(holdsSharedContent({ body: [{ id: 'b', type: 'c', data: {}, ref: '' }] })).toBe(false);
  });
});

/**
 * Ticking the box is a rule change applied to content written weeks earlier, so the screen has to
 * say what it would break before the write — see `bookRootBlockers`.
 */
describe('bookRootBlockers', () => {
  it('is empty for a type with nothing stored under it', async () => {
    expect(await bookRootBlockers(handle.db, bookType)).toEqual([]);
    expect(await bookRootBlockers(handle.db, pageType)).toEqual([]);
  });

  it('names the sections that would stop saving, and why', async () => {
    await createSnippet(handle.db, {
      api_id: 'tuition',
      name: 'Tuition',
      kind: 'text',
      value: '$4,500',
    });

    /**
     * A dedicated type for the would-be book, because making `page` one would make *every* page a
     * book root — and then a loose page is its own book and legitimately conflicts. That is correct
     * behaviour and a confusing fixture, which is the whole reason this is worth a note.
     */
    const catalogType = await createContentType(handle.db, {
      ...typeInput,
      api_id: 'catalog',
      name: 'Catalog',
      name_plural: 'Catalogs',
      kind: 'page',
    });

    const pageFields = [
      await createField(handle.db, pageType.id, {
        api_id: 'body',
        label: 'Body',
        type: 'richtext',
        required: false,
        localized: false,
        position: 0,
        config: {},
      }),
    ];

    // Nothing is a book yet, so all of this is legal today — which is the situation the guard is for.
    const future = await createItem(handle, catalogType, [], {
      contentTypeId: catalogType.id,
      title: 'Catalog',
    });
    await createItem(handle, pageType, pageFields, {
      contentTypeId: pageType.id,
      title: 'Costs',
      parentId: future.id,
      data: { body: '<p>Tuition is {{ tuition }}.</p>' },
    });
    const outside = await createItem(handle, pageType, pageFields, {
      contentTypeId: pageType.id,
      title: 'Elsewhere',
      data: { body: '<p>Also {{ tuition }}.</p>' },
    });

    const blockers = await bookRootBlockers(handle.db, catalogType);

    // Only what falls inside a would-be book — the page outside one is nobody's problem.
    expect(blockers.map((entry) => entry.path)).toEqual(['/catalog/costs']);
    expect(blockers[0]!.reason).toBe('snippet');
    expect(blockers.some((entry) => entry.id === outside.id)).toBe(false);
  });

  it('distinguishes a reusable block from a snippet, so the message can say which', async () => {
    const catalogType = await createContentType(handle.db, {
      ...typeInput,
      api_id: 'catalog',
      name: 'Catalog',
      name_plural: 'Catalogs',
      kind: 'page',
    });
    const blockType = await createContentType(handle.db, {
      ...typeInput,
      api_id: 'card',
      name: 'Card',
      name_plural: 'Cards',
      kind: 'block',
    });
    const blockFields = [
      await createField(handle.db, blockType.id, {
        api_id: 'body',
        label: 'Body',
        type: 'richtext',
        required: false,
        localized: false,
        position: 0,
        config: {},
      }),
    ];
    const entry = await createReusableBlock(handle.db, blockFields, {
      name: 'Accreditation',
      blockType: 'card',
      data: { body: '<p>Accredited.</p>' },
    });

    const pageFields = [
      await createField(handle.db, pageType.id, {
        api_id: 'body',
        label: 'Body',
        type: 'block',
        required: false,
        localized: false,
        position: 0,
        config: {},
      }),
    ];

    const root = await createItem(handle, catalogType, [], {
      contentTypeId: catalogType.id,
      title: 'Catalog',
    });
    await createItem(handle, pageType, pageFields, {
      contentTypeId: pageType.id,
      title: 'Front matter',
      parentId: root.id,
      data: { body: [{ id: 'b1', type: 'card', data: {}, ref: entry.id }] },
    });

    const blockers = await bookRootBlockers(handle.db, catalogType);
    expect(blockers.map((conflict) => conflict.reason)).toEqual(['reusable_block']);
  });

  /**
   * A token naming no snippet still counts, and that is deliberate rather than sloppy.
   *
   * It renders as itself today, so this reads as a false positive — until somebody creates a snippet
   * with that name next year and every archived edition silently starts substituting it. Checking
   * whether the snippet currently exists would also make the write-path gate asynchronous, which is
   * exactly the cost it exists to avoid. See `holdsSharedContent`.
   */
  it('counts a token that names no snippet, because one can be created later', async () => {
    const catalogType = await createContentType(handle.db, {
      ...typeInput,
      api_id: 'catalog',
      name: 'Catalog',
      name_plural: 'Catalogs',
      kind: 'page',
    });
    const pageFields = [
      await createField(handle.db, pageType.id, {
        api_id: 'body',
        label: 'Body',
        type: 'richtext',
        required: false,
        localized: false,
        position: 0,
        config: {},
      }),
    ];

    const root = await createItem(handle, catalogType, [], {
      contentTypeId: catalogType.id,
      title: 'Catalog',
    });
    await createItem(handle, pageType, pageFields, {
      contentTypeId: pageType.id,
      title: 'Syntax',
      parentId: root.id,
      data: { body: '<p>A dormant {{ tuition }} nobody has created yet.</p>' },
    });

    expect((await bookRootBlockers(handle.db, catalogType)).map((c) => c.path)).toEqual([
      '/catalog/syntax',
    ]);
  });

  it('ignores data that merely contains the letters the prefilter looks for', async () => {
    // The `like` narrows and never decides — `holdsSharedContent` is what answers. `{{ some text }}`
    // is not a token, because the grammar is the `api_id` character set and cannot span prose.
    const catalogType = await createContentType(handle.db, {
      ...typeInput,
      api_id: 'catalog',
      name: 'Catalog',
      name_plural: 'Catalogs',
      kind: 'page',
    });
    const pageFields = [
      await createField(handle.db, pageType.id, {
        api_id: 'body',
        label: 'Body',
        type: 'richtext',
        required: false,
        localized: false,
        position: 0,
        config: {},
      }),
    ];

    const root = await createItem(handle, catalogType, [], {
      contentTypeId: catalogType.id,
      title: 'Catalog',
    });
    await createItem(handle, pageType, pageFields, {
      contentTypeId: pageType.id,
      title: 'Syntax',
      parentId: root.id,
      data: { body: '<p>A template looks like {{ some text }} in prose.</p>' },
    });

    expect(await bookRootBlockers(handle.db, catalogType)).toEqual([]);
  });
});
