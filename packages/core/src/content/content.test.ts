import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import type { ContentStatus, ContentTypeRow, FieldRow } from '../db/schema.js';
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
import {
  blockTypeRegistry,
  countBlockUsage,
  createContentType,
  createField,
  deleteContentType,
  getContentType,
  listBlockTypes,
  listContentTypes,
  updateContentType,
  updateField,
} from './types.js';
import {
  countItemsByStatus,
  createItem,
  deleteItem,
  getItemByPath,
  getRedirect,
  getSubtree,
  itemDeleteImpact,
  itemsReferencing,
  listItems,
  previewPathFor,
  updateItem,
} from './items.js';
import { createMenu, createMenuItem } from './menus.js';
import { createTaxonomy, createTerm, termIdsForBranch } from './taxonomies.js';
import {
  MAX_BLOCK_DEPTH,
  contentTypeInputSchema,
  validateItemData,
} from '../validation/fields.js';

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

  it('refuses to delete a type a relation field on another type still targets', async () => {
    const { type } = await seedPageType();
    const author = await createContentType(handle.db, {
      api_id: 'author',
      name: 'Author',
      name_plural: 'Authors',
      kind: 'collection',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: null,
    });

    await createField(handle.db, type.id, {
      api_id: 'written_by',
      label: 'Written by',
      type: 'relation',
      required: false,
      localized: false,
      position: 1,
      config: { targetContentTypeId: author.id, multiple: false },
      help_text: null,
    });

    // No items, so nothing the FK cascade can see — but Page's relation field would be left
    // pointing at a type that no longer exists. The message names the type holding the delete.
    await expect(deleteContentType(handle.db, author.id)).rejects.toThrow(/relation field/);
    await expect(deleteContentType(handle.db, author.id)).rejects.toThrow(/Page/);
  });

  it('deletes a type whose only relation field targets itself', async () => {
    const { type } = await seedPageType();

    // A self-reference cascades away with the type that owns it, so it must not count as usage —
    // otherwise "related pages" on Page makes Page permanently undeletable.
    await createField(handle.db, type.id, {
      api_id: 'related',
      label: 'Related pages',
      type: 'relation',
      required: false,
      localized: false,
      position: 1,
      config: { targetContentTypeId: type.id, multiple: true },
      help_text: null,
    });

    await deleteContentType(handle.db, type.id);
    expect(await getContentType(handle.db, type.id)).toBeUndefined();
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

  it('derives the slug from the title when the field is left blank', async () => {
    // Regression: the editor sends `slug: ''`, and `input.slug ?? slugify(title)` let the empty
    // string through — slugifying to nothing and landing on the literal fallback "item".
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'test',
      slug: '',
    });

    expect(item.slug).toBe('test');
    expect(item.path).toBe('/test');
  });

  it('derives the slug when it is only whitespace', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Spring Open House',
      slug: '   ',
    });

    expect(item.slug).toBe('spring-open-house');
  });

  it('keeps the existing slug when an update sends a blank one', async () => {
    // Regenerating here would silently move the page and write a redirect on every save.
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Apply' });

    const updated = await updateItem(handle, type, fields, item.id, { slug: '', title: 'Apply Now' });

    expect(updated.slug).toBe('apply');
    expect(updated.path).toBe('/apply');
    expect(await getRedirect(handle.db, '/apply')).toBeUndefined();
  });

  it('disambiguates a duplicate slug under the same parent', async () => {
    const { type, fields } = await seedPageType();
    const first = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Apply' });
    const second = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Apply' });

    expect(first.slug).toBe('apply');
    expect(second.slug).toBe('apply-2');
  });

  it('lets a root page and a collection item share a slug', async () => {
    // Regression, and the reason `0024_root_slug_scope` exists: `parent_id` is null for a collection
    // item as well as a root page, so the original `(slug) WHERE parent_id IS NULL` index put them
    // in one namespace. `siblingSlugs` scopes by content type and never saw the clash, so the write
    // reached the driver — on D1, as `D1 batch failed at statement 1 of N`. The two address
    // different URLs and must both save, unchanged.
    const { type: pageType, fields: pageFields } = await seedPageType();
    const eventType = await createContentType(handle.db, {
      api_id: 'event',
      name: 'Event',
      name_plural: 'Events',
      kind: 'collection',
      description: null,
      icon: null,
      url_prefix: 'events',
      title_field: null,
    });

    const page = await createItem(handle, pageType, pageFields, {
      contentTypeId: pageType.id,
      title: 'Financial Aid',
    });
    const event = await createItem(handle, eventType, [], {
      contentTypeId: eventType.id,
      title: 'Financial Aid',
    });

    expect(page.slug).toBe('financial-aid');
    expect(page.path).toBe('/financial-aid');
    expect(event.slug).toBe('financial-aid');
    expect(event.path).toBe('/events/financial-aid');
  });

  it('disambiguates two root items of different page types', async () => {
    // The mirror image: these are siblings of neither each other nor anything else `siblingSlugs`
    // would return, and they resolve to the *same* path — so `content_items_path_unique` would have
    // rejected the second. Disambiguating against the path namespace is what catches both directions.
    const { type: pageType, fields: pageFields } = await seedPageType();
    const landingType = await createContentType(handle.db, {
      api_id: 'landing_page',
      name: 'Landing Page',
      name_plural: 'Landing Pages',
      kind: 'page',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: null,
    });

    const first = await createItem(handle, pageType, pageFields, {
      contentTypeId: pageType.id,
      title: 'Apply',
    });
    const second = await createItem(handle, landingType, [], {
      contentTypeId: landingType.id,
      title: 'Apply',
    });

    expect(first.path).toBe('/apply');
    expect(second.path).toBe('/apply-2');
  });

  it('disambiguates a rename that would collide across content types', async () => {
    // `updateItem` has its own slug branch, so it needs its own proof — a rename is the likelier
    // route into this than a create, because the editor picks the word deliberately.
    const { type: pageType, fields: pageFields } = await seedPageType();
    const eventType = await createContentType(handle.db, {
      api_id: 'event',
      name: 'Event',
      name_plural: 'Events',
      kind: 'collection',
      description: null,
      icon: null,
      url_prefix: 'events',
      title_field: null,
    });

    await createItem(handle, eventType, [], { contentTypeId: eventType.id, title: 'Open House' });
    const second = await createItem(handle, eventType, [], {
      contentTypeId: eventType.id,
      title: 'Spring Fair',
    });

    const renamed = await updateItem(handle, eventType, [], second.id, { slug: 'open-house' });

    expect(renamed.path).toBe('/events/open-house-2');

    // And a rename that collides with nothing still gets the slug it asked for — the events one
    // above sits at /events/open-house, which is a different path from this page's /open-house.
    const page = await createItem(handle, pageType, pageFields, {
      contentTypeId: pageType.id,
      title: 'Visit',
    });
    const moved = await updateItem(handle, pageType, pageFields, page.id, { slug: 'open-house' });
    expect(moved.path).toBe('/open-house');
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

  /**
   * The fact that made auto-creating a singleton wrong.
   *
   * `/admin/singleton/{api_id}` used to call `createItem` with no `data`, which succeeds only when
   * every field is optional — and the test above passes `[]` for exactly that reason, which is why
   * nothing caught it. Add one required field and the screen an editor reaches the singleton
   * through answers 500, with no form on it to fix the item from.
   *
   * `createItem` is right to refuse; the route was wrong to assume it would not. It now sends an
   * editor to the create form instead, so the row is written with real values. Pinned here because
   * the route is an `.astro` file with no way to render it under vitest — this is the invariant it
   * has to be built around, not a test of the route.
   */
  /**
   * `previewPathFor` is what the pane, both mint endpoints, and the editor's path link all ask.
   *
   * It replaced `kindHasPublicPath` at those call sites, which answered "no" for every singleton —
   * right about `/__singleton/{api_id}` and wrong about singletons, since a homepage built from
   * blocks is one. The null case is the one that must not regress: it is the whole reason a
   * settings singleton does not get a preview pointed at somebody else's page.
   */
  describe('previewPathFor', () => {
    const type = (
      kind: ContentTypeRow['kind'],
      preview_path: string | null = null,
      item_pages = 1,
    ): Pick<ContentTypeRow, 'kind' | 'preview_path' | 'item_pages'> => ({
      kind,
      preview_path,
      item_pages,
    });

    it('answers a page or collection with the item path, ignoring the column', () => {
      // Those items already know where they live; reading a second source is how the two drift.
      expect(previewPathFor(type('page', '/ignored'), { path: '/apply' })).toBe('/apply');
      expect(previewPathFor(type('collection', '/ignored'), { path: '/news/open-day' })).toBe(
        '/news/open-day',
      );
    });

    it('answers null for a collection whose items have no pages', () => {
      /**
       * A staff directory. There is no page to open, so offering a preview would frame something
       * this item is not — and `resolveDelivery` answers `not_found` at that path, so a link built
       * from it would 404. The listing the person appears on is a route the *site* serves, which
       * Taproot does not know and must not guess at.
       */
      expect(previewPathFor(type('collection', null, 0), { path: '/people/nia' })).toBeNull();
    });

    it('answers a singleton with its configured path', () => {
      expect(previewPathFor(type('singleton', '/'), { path: '/__singleton/homepage' })).toBe('/');
    });

    it('answers null for a singleton nobody has configured, and for a block', () => {
      expect(previewPathFor(type('singleton'), { path: '/__singleton/site_settings' })).toBeNull();
      expect(previewPathFor(type('singleton', ''), { path: '/__singleton/x' })).toBeNull();
      expect(previewPathFor(type('block'), { path: '/x' })).toBeNull();
    });
  });

  it('keeps a preview path only for singletons, and clears it on request', async () => {
    const singleton = await createContentType(handle.db, {
      api_id: 'homepage',
      name: 'Homepage',
      name_plural: 'Homepage',
      kind: 'singleton',
      description: null,
      icon: null,
      url_prefix: null,
      preview_path: '/',
      title_field: null,
    });
    expect(singleton.preview_path).toBe('/');

    // `undefined` keeps it. `??` in the update path would collapse this with the clear below and
    // silently ignore an editor turning preview off — the shape of bug a `.partial()` PATCH keeps
    // producing, and the same one `publish_at` already had.
    const untouched = await updateContentType(handle.db, singleton.id, { name: 'Front page' });
    expect(untouched.preview_path).toBe('/');

    const cleared = await updateContentType(handle.db, singleton.id, { preview_path: null });
    expect(cleared.preview_path).toBeNull();

    // A kind that derives its own address must not carry one, however the API was called — the
    // column means one thing, the way `url_prefix` is nulled for everything but a collection.
    const page = await createContentType(handle.db, {
      api_id: 'article',
      name: 'Article',
      name_plural: 'Articles',
      kind: 'page',
      description: null,
      icon: null,
      url_prefix: null,
      preview_path: '/sneaky',
      title_field: null,
    });
    expect(page.preview_path).toBeNull();
  });

  it('refuses a preview path that is not root-relative', () => {
    const base = {
      api_id: 'homepage',
      name: 'Homepage',
      name_plural: 'Homepage',
      kind: 'singleton' as const,
    };

    // An absolute URL would point the pane at another origin, making "which site is this" a
    // question with two answers — `TAPROOT_SITE_URL` is the one place that decides it.
    expect(
      contentTypeInputSchema.safeParse({ ...base, preview_path: 'https://elsewhere.test/' }).success,
    ).toBe(false);
    // A trailing slash would make `/about/` and `/about` two different settings.
    expect(contentTypeInputSchema.safeParse({ ...base, preview_path: '/about/' }).success).toBe(
      false,
    );
    expect(contentTypeInputSchema.safeParse({ ...base, preview_path: 'about' }).success).toBe(false);

    expect(contentTypeInputSchema.safeParse({ ...base, preview_path: '/' }).success).toBe(true);
    expect(contentTypeInputSchema.safeParse({ ...base, preview_path: '/about' }).success).toBe(true);
    expect(contentTypeInputSchema.safeParse({ ...base, preview_path: null }).success).toBe(true);
  });

  it('refuses an empty create against a type with a required field', async () => {
    const type = await createContentType(handle.db, {
      api_id: 'homepage',
      name: 'Homepage',
      name_plural: 'Homepage',
      kind: 'singleton',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: null,
    });

    const headline = await createField(handle.db, type.id, {
      api_id: 'headline',
      label: 'Headline',
      type: 'text',
      required: true,
      localized: false,
      position: 0,
      config: {},
      help_text: null,
    });

    await expect(
      createItem(handle, type, [headline], { contentTypeId: type.id, title: 'Homepage' }),
    ).rejects.toThrow(/validation/i);
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

  describe('richtext', () => {
    const rich = (config: Record<string, unknown> = {}, required: 0 | 1 = 0) =>
      field({ api_id: 'body', type: 'richtext', required, config: JSON.stringify(config) });

    it('sanitises on the way in, not on the way out', () => {
      // The path that matters: anything reaching the database has already been through the
      // sanitiser, so no consumer has to remember to escape it.
      const result = validateItemData([rich()], {
        body: '<p>Hello</p><script>alert(1)</script><img src=x onerror=alert(1)>',
      });

      expect(result.success).toBe(true);
      expect(result.data?.body).toBe('<p>Hello</p>');
    });

    it('measures length against the visible text, not the markup', () => {
      // Otherwise `<strong>` silently eats eight characters of an editor's stated budget.
      const result = validateItemData([rich({ maxLength: 10 })], {
        body: '<p><strong>0123456789</strong></p>',
      });

      expect(result.success).toBe(true);
    });

    it('rejects text past the limit once tags are discounted', () => {
      expect(validateItemData([rich({ maxLength: 5 })], { body: '<p>123456</p>' }).success).toBe(
        false,
      );
    });

    it('treats an empty editor as empty even though it emits markup', () => {
      // A richtext editor produces `<p></p>` for "nothing typed". A `.min(1)` on the HTML string
      // would accept that as satisfying a required field.
      const result = validateItemData([rich({}, 1)], { body: '<p></p>' });

      expect(result.success).toBe(false);
      expect(result.errors.body).toBeDefined();
    });

    it('honours a narrowed allowedFormats', () => {
      const result = validateItemData([rich({ allowedFormats: ['strong', 'em'] })], {
        body: '<h2>Heading</h2><p><strong>kept</strong></p>',
      });

      expect(result.data?.body).toBe('Heading<strong>kept</strong>');
    });
  });

  describe('blocks', () => {
    const blockField = (config: Record<string, unknown> = {}) =>
      field({ api_id: 'sections', type: 'block', config: JSON.stringify(config) });

    const heroType = {
      fields: [
        field({ id: 'h1', api_id: 'heading', type: 'text', required: 1 }),
        field({ id: 'h2', api_id: 'lead', type: 'text' }),
      ],
    };

    const registry = new Map([['hero', heroType]]);

    const block = (data: Record<string, unknown>, type = 'hero') => ({ id: 'b1', type, data });

    it('validates each block against its own type', () => {
      const result = validateItemData(
        [blockField()],
        { sections: [block({ heading: 'Hello', lead: 'There' })] },
        { blockTypes: registry },
      );

      expect(result.success).toBe(true);
      expect(result.data?.sections).toEqual([
        { id: 'b1', type: 'hero', data: { heading: 'Hello', lead: 'There' } },
      ]);
    });

    it('reports a missing required field inside a block, with its position', () => {
      // The editor renders blocks as a list under one label and has nowhere to put a per-block
      // error map, so the message has to say which block and which field itself.
      const result = validateItemData(
        [blockField()],
        { sections: [block({ heading: 'ok' }), block({ lead: 'no heading' })] },
        { blockTypes: registry },
      );

      expect(result.success).toBe(false);
      expect(result.errors.sections?.join(' ')).toMatch(/Block 2.*heading/);
    });

    it('rejects an unknown block type rather than dropping it', () => {
      // Silently dropping would delete an editor's content on the next save.
      const result = validateItemData(
        [blockField()],
        { sections: [block({}, 'nope')] },
        { blockTypes: registry },
      );

      expect(result.success).toBe(false);
      expect(result.errors.sections?.join(' ')).toContain('unknown block type');
    });

    it('enforces allowedBlocks', () => {
      const result = validateItemData(
        [blockField({ allowedBlocks: ['quote'] })],
        { sections: [block({ heading: 'x' })] },
        { blockTypes: registry },
      );

      expect(result.success).toBe(false);
      expect(result.errors.sections?.join(' ')).toContain('not allowed');
    });

    it('treats an empty allowedBlocks as "any", matching the config default', () => {
      const result = validateItemData(
        [blockField({ allowedBlocks: [] })],
        { sections: [block({ heading: 'x' })] },
        { blockTypes: registry },
      );

      expect(result.success).toBe(true);
    });

    it('enforces maxBlocks', () => {
      const result = validateItemData(
        [blockField({ maxBlocks: 1 })],
        { sections: [block({ heading: 'a' }), { ...block({ heading: 'b' }), id: 'b2' }] },
        { blockTypes: registry },
      );

      expect(result.success).toBe(false);
      expect(result.errors.sections?.join(' ')).toContain('At most 1 block');
    });

    it('requires the envelope, so a bare object cannot pose as a block', () => {
      const result = validateItemData(
        [blockField()],
        { sections: [{ heading: 'no id or type' }] },
        { blockTypes: registry },
      );

      expect(result.success).toBe(false);
    });

    it('sanitises richtext inside a block, exactly as at the top level', () => {
      // The recursion is the point: a block's fields go through the same validation, so nothing is
      // safe outside a block and hostile inside one.
      const withRichtext = new Map([
        ['prose', { fields: [field({ id: 'p1', api_id: 'body', type: 'richtext' })] }],
      ]);

      const result = validateItemData(
        [blockField()],
        { sections: [block({ body: '<p>hi</p><script>alert(1)</script>' }, 'prose')] },
        { blockTypes: withRichtext },
      );

      expect(result.success).toBe(true);
      expect((result.data?.sections as { data: { body: string } }[])[0]!.data.body).toBe('<p>hi</p>');
    });

    it('leaves block contents alone when no registry is supplied', () => {
      // The content-type builder's preview has no blocks loaded and must not reject content it
      // cannot check.
      const result = validateItemData([blockField()], { sections: [block({ heading: 'x' })] });

      expect(result.success).toBe(true);
    });

    describe('nesting', () => {
      /** A block type holding a block field, so validation has somewhere to recurse. */
      const nesting = new Map([
        [
          'section',
          { fields: [field({ id: 's1', api_id: 'blocks', type: 'block', config: '{}' })] },
        ],
        ['hero', heroType],
      ]);

      /**
       * `depth` levels of section wrapping one hero, under the top-level `sections` field.
       *
       * The outermost key is the content type's field; every level below it is the section type's
       * own `blocks` field.
       */
      const nest = (depth: number, leaf: Record<string, unknown> = { heading: 'bottom' }) => {
        let blocks: unknown[] = [{ id: 'leaf', type: 'hero', data: leaf }];
        for (let i = 0; i < depth; i += 1) {
          blocks = [{ id: `s${i}`, type: 'section', data: { blocks } }];
        }
        return { sections: blocks };
      };

      it('validates a block nested inside a block', () => {
        const result = validateItemData([blockField()], nest(1), { blockTypes: nesting });
        expect(result.success).toBe(true);
      });

      it('reports a required field missing several levels down', () => {
        const result = validateItemData([blockField()], nest(2, { lead: 'no heading' }), {
          blockTypes: nesting,
        });

        expect(result.success).toBe(false);
        expect(result.errors.sections?.join(' ')).toMatch(/heading/);
      });

      it('refuses a payload nested past the limit rather than truncating it', () => {
        /**
         * The bound used to be a comment claiming the editor never offered a block field inside a
         * block type. It did — the field builder renders every field type for a block type — so
         * the real bound was however deep a request nested, and a hand-written payload could
         * recurse until the stack gave out. Refusing beats truncating: a stored value silently
         * missing its tail is worse than a rejected write.
         */
        const result = validateItemData([blockField()], nest(MAX_BLOCK_DEPTH + 2), {
          blockTypes: nesting,
        });

        expect(result.success).toBe(false);
        expect(JSON.stringify(result.errors)).toMatch(/nested more than/);
      });

      it('allows nesting right up to the limit', () => {
        // Off-by-one here would be invisible in the failure case above and would reject a page a
        // template legitimately builds.
        const result = validateItemData([blockField()], nest(MAX_BLOCK_DEPTH - 1), {
          blockTypes: nesting,
        });

        expect(result.success).toBe(true);
      });
    });
  });

});

describe('filtering a list by term', () => {
  /**
   * The read `taxonomy_assignments` exists for.
   *
   * The index has been rebuilt from `data` on every write since taxonomies shipped, justified by
   * exactly this query — filtering a list by term without scanning every row and parsing its JSON
   * blob — and the query was never written. These are its first callers.
   */
  async function seedTagged() {
    const taxonomy = await createTaxonomy(handle.db, {
      api_id: 'department',
      name: 'Department',
      name_plural: 'Departments',
      hierarchical: true,
    });
    const academics = await createTerm(handle.db, taxonomy.id, { name: 'Academics' });
    const sciences = await createTerm(handle.db, taxonomy.id, {
      name: 'Sciences',
      parentId: academics.id,
    });
    const services = await createTerm(handle.db, taxonomy.id, { name: 'Student Services' });

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

    const tags = await createField(handle.db, type.id, {
      api_id: 'departments',
      label: 'Departments',
      type: 'taxonomy',
      required: false,
      localized: false,
      position: 0,
      config: { taxonomyId: taxonomy.id, multiple: true },
      help_text: null,
    });

    const make = (title: string, termIds: string[]) =>
      createItem(handle, type, [tags], {
        contentTypeId: type.id,
        title,
        status: 'published',
        userId: null,
        data: { departments: termIds },
      });

    return {
      make,
      academics,
      sciences,
      services,
      physics: await make('Physics', [sciences.id]),
      admissions: await make('Admissions', [services.id]),
      untagged: await make('About', []),
    };
  }

  it('returns only items carrying the term', async () => {
    const { services, admissions } = await seedTagged();

    const { items } = await listItems(handle.db, {
      termIds: await termIdsForBranch(handle.db, services.id),
    });

    expect(items.map((item) => item.id)).toEqual([admissions.id]);
  });

  it('includes items filed under a descendant term', async () => {
    // Filtering by "Academics" has to find a page filed under "Sciences", or the tree is
    // decoration and every editor has to know which leaf someone else picked.
    const { academics, physics } = await seedTagged();

    const { items } = await listItems(handle.db, {
      termIds: await termIdsForBranch(handle.db, academics.id),
    });

    expect(items.map((item) => item.id)).toEqual([physics.id]);
  });

  it('counts an item once even when it carries several terms in the branch', async () => {
    const { academics, sciences, make } = await seedTagged();
    const { id } = await make('Both', [academics.id, sciences.id]);

    const { items, total } = await listItems(handle.db, {
      termIds: await termIdsForBranch(handle.db, academics.id),
    });

    // EXISTS rather than a join, so two matching assignments do not duplicate the row.
    expect(items.filter((item) => item.id === id)).toHaveLength(1);
    expect(total).toBe(items.length);
  });

  it('combines with the other filters rather than replacing them', async () => {
    const { services } = await seedTagged();

    const { items } = await listItems(handle.db, {
      termIds: await termIdsForBranch(handle.db, services.id),
      search: 'nothing-matches-this',
    });

    expect(items).toEqual([]);
  });

  it('matches nothing for an empty term list, rather than everything', async () => {
    /**
     * `listMedia`'s trap, in a different table. `in ()` is a syntax error, so the tempting
     * fallthrough is to drop the clause — which turns "filter by a term with no members" into
     * "show the whole site", on a screen whose entire purpose is narrowing.
     */
    await seedTagged();
    const { items } = await listItems(handle.db, { termIds: [] });
    expect(items).toEqual([]);
  });

  it('applies to the status facet counts too', async () => {
    // The counts label the list. A facet that ignored the term filter would promise rows the list
    // then refuses to show.
    const { services } = await seedTagged();

    const counts = await countItemsByStatus(handle.db, {
      termIds: await termIdsForBranch(handle.db, services.id),
    });

    expect(counts.published).toBe(1);
  });
});

describe('itemsReferencing', () => {
  /** A Page type, plus an Event type with a relation field pointing at pages. */
  async function seedRelation() {
    const page = await seedPageType();

    const event = await createContentType(handle.db, {
      api_id: 'event',
      name: 'Event',
      name_plural: 'Events',
      kind: 'collection',
      description: null,
      icon: null,
      url_prefix: 'events',
      title_field: 'title',
    });

    const hostPage = await createField(handle.db, event.id, {
      api_id: 'host_page',
      label: 'Part of',
      type: 'relation',
      required: false,
      localized: false,
      position: 0,
      config: { targetContentTypeId: page.type.id, multiple: false, reverseLabel: 'Events' },
      help_text: null,
    });

    const target = await createItem(handle, page.type, page.fields, {
      contentTypeId: page.type.id,
      title: 'Admissions',
      status: 'published',
      userId: null,
      data: {},
    });

    return { page, event, hostPage, target };
  }

  it('finds an item pointing here through a relation field', async () => {
    const { event, hostPage, target } = await seedRelation();

    await createItem(handle, event, [hostPage], {
      contentTypeId: event.id,
      title: 'Spring Open House',
      status: 'published',
      userId: null,
      data: { host_page: target.id },
    });

    const references = await itemsReferencing(handle.db, target.id);

    expect(references).toHaveLength(1);
    expect(references[0]!.title).toBe('Spring Open House');
    // The label the config has always stored and nothing ever read.
    expect(references[0]!.reverseLabel).toBe('Events');
    expect(references[0]!.contentTypeName).toBe('Event');
  });

  it('finds an item pointing here from a multi-value relation', async () => {
    const page = await seedPageType();
    const related = await createField(handle.db, page.type.id, {
      api_id: 'related',
      label: 'Related pages',
      type: 'relation',
      required: false,
      localized: false,
      position: 1,
      config: { targetContentTypeId: page.type.id, multiple: true, reverseLabel: 'Referenced by' },
      help_text: null,
    });

    const target = await createItem(handle, page.type, page.fields, {
      contentTypeId: page.type.id,
      title: 'Tuition',
      status: 'published',
      userId: null,
      data: {},
    });

    await createItem(handle, page.type, [...page.fields, related], {
      contentTypeId: page.type.id,
      title: 'Financial Aid',
      status: 'published',
      userId: null,
      data: { related: ['someone-else', target.id] },
    });

    const references = await itemsReferencing(handle.db, target.id);
    expect(references.map((reference) => reference.title)).toEqual(['Financial Aid']);
  });

  it('does not report an id that merely appears in a text field', async () => {
    /**
     * The reason this is two queries rather than one `LIKE`.
     *
     * Searching every item's `data` for the bare id would match it sitting in a body, a slug
     * someone pasted, or a block's media reference, and would report a relationship that does not
     * exist — on the screen whose whole job is to say what depends on this item.
     */
    const { page, target } = await seedRelation();

    await createItem(handle, page.type, page.fields, {
      contentTypeId: page.type.id,
      title: 'Notes',
      status: 'draft',
      userId: null,
      data: { body: `See item ${target.id} for details.` },
    });

    expect(await itemsReferencing(handle.db, target.id)).toEqual([]);
  });

  it('does not report a relation field pointing at a different type', async () => {
    const { event, target } = await seedRelation();

    // A relation on Event targeting Event, holding this page's id anyway. The field cannot point
    // here, so neither can the item.
    const other = await createField(handle.db, event.id, {
      api_id: 'sibling',
      label: 'Sibling event',
      type: 'relation',
      required: false,
      localized: false,
      position: 1,
      config: { targetContentTypeId: event.id, multiple: false },
      help_text: null,
    });

    await createItem(handle, event, [other], {
      contentTypeId: event.id,
      title: 'Autumn Tour',
      status: 'published',
      userId: null,
      data: { sibling: target.id },
    });

    expect(await itemsReferencing(handle.db, target.id)).toEqual([]);
  });

  it('returns nothing when no relation field targets this type', async () => {
    const page = await seedPageType();
    const item = await createItem(handle, page.type, page.fields, {
      contentTypeId: page.type.id,
      title: 'Lonely',
      status: 'draft',
      userId: null,
      data: {},
    });

    // Short-circuits before touching content_items at all, which is what keeps the common case
    // from being a scan of every row on every editor load.
    expect(await itemsReferencing(handle.db, item.id)).toEqual([]);
  });

  it('returns nothing for an item that does not exist', async () => {
    expect(await itemsReferencing(handle.db, 'missing')).toEqual([]);
  });
});

describe('deletion', () => {
  it('removes an item', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Temp' });
    await deleteItem(handle, item.id);
    expect(await getItemByPath(handle.db, '/temp', { publishedOnly: false })).toBeUndefined();
  });

  it('refuses to delete an item that has children', async () => {
    /**
     * This used to orphan them instead, on the reasoning that silently deleting a whole page tree
     * is not a recoverable mistake. That reasoning holds; orphaning was the wrong way to honour it.
     * `parent_id` is `ON DELETE SET NULL`, so the children stayed at their old `path` and `depth`
     * while becoming roots — the materialised path and the tree disagreed, and nothing downstream
     * expects that. Refusing protects the same content without leaving the inconsistency behind.
     */
    const { type, fields } = await seedPageType();
    const parent = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Parent' });
    const child = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Child', parentId: parent.id });

    await expect(deleteItem(handle, parent.id)).rejects.toThrow(/sit beneath it/);

    const { items } = await listItems(handle.db, {});
    expect(items.map((i) => i.id).sort()).toEqual([parent.id, child.id].sort());
  });

  it('deletes once the children are gone', async () => {
    const { type, fields } = await seedPageType();
    const parent = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Parent' });
    const child = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Child', parentId: parent.id });

    await deleteItem(handle, child.id);
    await deleteItem(handle, parent.id);

    const { items } = await listItems(handle.db, {});
    expect(items).toEqual([]);
  });

  it('reports a menu entry as a warning rather than a blocker', async () => {
    // A menu item nulls its reference and stays visible in the admin as a broken entry. That is
    // the designed behaviour, so it is something to tell the editor, not something to stop them.
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'Visit' });

    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main' });
    await createMenuItem(handle.db, menu.id, {
      label: 'Visit',
      targetType: 'item',
      contentItemId: item.id,
    });

    const impact = await itemDeleteImpact(handle.db, item.id);

    expect(impact.blockers).toEqual([]);
    expect(impact.warnings.join(' ')).toMatch(/menu item\(s\) point at it/);
    await expect(deleteItem(handle, item.id)).resolves.toBeUndefined();
  });
});

describe('block types share the content_types table', () => {
  async function seedBlockType(apiId = 'hero') {
    return createContentType(handle.db, {
      api_id: apiId,
      name: 'Hero',
      name_plural: 'Heroes',
      kind: 'block',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: null,
    });
  }

  it('accepts kind "block" through the input schema', () => {
    // `createContentType` takes a typed object and does no runtime validation, so the seed passed
    // while the admin form — which parses through this schema — did not. Only the form path caught
    // it, and only a test on the schema itself keeps it caught.
    const parsed = contentTypeInputSchema.safeParse({
      api_id: 'hero',
      name: 'Hero',
      name_plural: 'Heroes',
      kind: 'block',
    });

    expect(parsed.success).toBe(true);
  });

  it('keeps block types out of listContentTypes by default', async () => {
    // The load-bearing default: the sidebar, the "new content item" picker, and the relation
    // target list all call this, and none of them should ever offer a block.
    await seedPageType();
    await seedBlockType();

    const listed = await listContentTypes(handle.db);

    expect(listed.map((type) => type.api_id)).toEqual(['page']);
  });

  it('returns them when asked', async () => {
    await seedPageType();
    await seedBlockType();

    expect((await listContentTypes(handle.db, { includeBlocks: true })).length).toBe(2);
    expect((await listBlockTypes(handle.db)).map((t) => t.api_id)).toEqual(['hero']);
  });

  it('refuses to create a content item of a block type', async () => {
    // A POST carrying a block type's id would otherwise create an item with no URL, invisible in
    // every list that filters blocks out.
    const blockType = await seedBlockType();

    await expect(
      createItem(handle, blockType, [], { contentTypeId: blockType.id, title: 'Nope' }),
    ).rejects.toThrow(/block type/i);
  });

  it('builds a registry of block types with their fields', async () => {
    const blockType = await seedBlockType();
    await createField(handle.db, blockType.id, {
      api_id: 'heading',
      label: 'Heading',
      type: 'text',
      required: true,
      localized: false,
      position: 0,
      config: {},
      help_text: null,
    });

    const registry = await blockTypeRegistry(handle.db);

    expect(registry.get('hero')?.fields.map((f) => f.api_id)).toEqual(['heading']);
  });

  it('refuses to delete a block type still placed on an item', async () => {
    // Deleting one that is in use would quietly empty pages on their next save.
    const { type: pageType } = await seedPageType();
    const sections = await createField(handle.db, pageType.id, {
      api_id: 'sections',
      label: 'Sections',
      type: 'block',
      required: false,
      localized: false,
      position: 1,
      config: {},
      help_text: null,
    });
    const blockType = await seedBlockType();

    await createItem(handle, pageType, [sections], {
      contentTypeId: pageType.id,
      title: 'Composed',
      data: { sections: [{ id: 'b1', type: 'hero', data: {} }] },
    });

    await expect(deleteContentType(handle.db, blockType.id)).rejects.toThrow(/still place it/);
    expect(await countBlockUsage(handle.db, 'hero')).toBe(1);
  });

  it('allows deleting an unused block type', async () => {
    const blockType = await seedBlockType();

    await deleteContentType(handle.db, blockType.id);

    expect(await listBlockTypes(handle.db)).toEqual([]);
  });

  it('does not confuse a block type with one whose name it prefixes', async () => {
    // The usage query matches the exact `"type":"hero"` shape the block envelope guarantees, so
    // `hero` and `hero_wide` cannot be mistaken for each other.
    const { type: pageType } = await seedPageType();
    const sections = await createField(handle.db, pageType.id, {
      api_id: 'sections',
      label: 'Sections',
      type: 'block',
      required: false,
      localized: false,
      position: 1,
      config: {},
      help_text: null,
    });
    await seedBlockType('hero_wide');

    await createItem(handle, pageType, [sections], {
      contentTypeId: pageType.id,
      title: 'Composed',
      data: { sections: [{ id: 'b1', type: 'hero_wide', data: {} }] },
    });

    expect(await countBlockUsage(handle.db, 'hero_wide')).toBe(1);
    expect(await countBlockUsage(handle.db, 'hero')).toBe(0);
  });
});

describe('status counts', () => {
  async function seedStatuses() {
    const { type, fields } = await seedPageType();
    const make = (title: string, status: ContentStatus) =>
      createItem(handle, type, fields, { contentTypeId: type.id, title, status });

    await make('Live one', 'published');
    await make('Live two', 'published');
    await make('Unfinished', 'draft');
    await make('Waiting on legal', 'in_review');

    return { type, fields };
  }

  it('reports every status, including the ones with nothing in them', async () => {
    await seedStatuses();

    // Zeros rather than missing keys, so a caller can render a complete filter without treating
    // an absent key as a special case.
    expect(await countItemsByStatus(handle.db)).toEqual({
      draft: 1,
      in_review: 1,
      scheduled: 0,
      published: 2,
      archived: 0,
    });
  });

  it('narrows by content type', async () => {
    const { type: pageType, fields: pageFields } = await seedPageType();
    await createItem(handle, pageType, pageFields, {
      contentTypeId: pageType.id,
      title: 'A page',
      status: 'published',
    });

    const eventType = await createContentType(handle.db, {
      api_id: 'event',
      name: 'Event',
      name_plural: 'Events',
      kind: 'collection',
      description: null,
      icon: null,
      url_prefix: 'events',
      title_field: 'title',
    });
    await createItem(handle, eventType, [], {
      contentTypeId: eventType.id,
      title: 'An event',
      status: 'draft',
    });

    expect((await countItemsByStatus(handle.db, { contentTypeId: eventType.id })).draft).toBe(1);
    expect((await countItemsByStatus(handle.db, { contentTypeId: eventType.id })).published).toBe(0);
  });

  it('applies the same search the list applies', async () => {
    // The counts label the list, so a search the two disagreed about would be worse than no count
    // at all. Both go through the one filter builder; this is the test that says so.
    await seedStatuses();

    const counts = await countItemsByStatus(handle.db, { search: 'live' });
    const { total } = await listItems(handle.db, { search: 'live' });

    expect(counts.published).toBe(2);
    expect(counts.draft).toBe(0);
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(total);
  });

  it('counts across statuses so a facet can answer "what would I get if I switched?"', async () => {
    await seedStatuses();

    // The signature omits `status` on purpose: counting within the current status filter would
    // return the number already on screen and zero everywhere else.
    const counts = await countItemsByStatus(handle.db);
    const { total: draftTotal } = await listItems(handle.db, { status: 'draft' });

    expect(counts.draft).toBe(draftTotal);
    expect(counts.published).toBe(2);
  });
});
