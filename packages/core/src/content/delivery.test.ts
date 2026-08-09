import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createContentType, createField } from './types.js';
import { createItem, getItemByPath, updateItem, getChildren, getRedirect } from './items.js';
import { createMenu, createMenuItem, resolveMenu, termArchivePath } from './menus.js';
import { createTaxonomy, createTerm } from './taxonomies.js';
import { createReusableBlock } from './reusableBlocks.js';
import { resolveSeo } from './seo.js';
import { ancestorPaths } from './paths.js';
import { collectReferences, deliverMenu, deliverySchema, resolveDelivery } from './delivery.js';
// Moved out of `delivery.ts` so it is reachable from `@taprootcms/core/pure` — a consumer runs it,
// and `delivery.ts` imports Kysely.
import { applyTermHrefs } from './menuHrefs.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';
import type { StorageAdapter } from '../storage/types.js';

/**
 * The delivery layer, and the equivalence check the sequencing exists for.
 *
 * Phase 3.75a builds the delivery API while `apps/web` still reads the database directly, which
 * makes it possible to assert the two agree. That comparison stops being available the moment the
 * embedded path is removed in 3.75b, so it is written now and deliberately mirrors what the demo
 * route actually does — `getItemByPath`, `getChildren`, `ancestorPaths`, `resolveSeo`,
 * `resolveMenu` — rather than re-deriving the expected answer from the delivery code.
 */

let handle: TaprootDb;
let pageType: ContentTypeRow;
let fields: FieldRow[];

/** Enough of a storage adapter to build a URL. The real ones have their own tests. */
const storage = {
  name: 'local',
  publicUrl: (key: string) => `/uploads/${key}`,
} as unknown as StorageAdapter;

const options = { origin: 'https://example.edu', storage };

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
    summary_template: '{{ title }}',
  });

  fields = [
    await createField(handle.db, pageType.id, {
      api_id: 'body',
      label: 'Body',
      type: 'text',
      required: false,
      localized: false,
      position: 0,
      config: {},
      help_text: null,
    }),
  ];
});

afterEach(async () => {
  await handle.destroy();
});

async function page(title: string, parentId: string | null = null, status: 'draft' | 'published' = 'published') {
  return createItem(handle, pageType, fields, {
    contentTypeId: pageType.id,
    title,
    parentId,
    status,
    data: { body: `${title} body` },
  });
}

describe('resolving a path', () => {
  it('answers with the item, its type, and its fields', async () => {
    const item = await page('Admissions');

    const result = await resolveDelivery(handle.db, '/admissions', options);

    expect(result.kind).toBe('item');
    if (result.kind !== 'item') return;
    expect(result.item.id).toBe(item.id);
    expect(result.item.contentType.apiId).toBe('page');
    expect(result.item.fields.map((f) => f.apiId)).toEqual(['body']);
    expect(result.item.data).toEqual({ body: 'Admissions body' });
  });

  it('hides a draft, because visibility is the one shared predicate', async () => {
    await page('Secret', null, 'draft');
    expect((await resolveDelivery(handle.db, '/secret', options)).kind).toBe('not_found');
  });

  /**
   * A scheduled item whose moment has passed is live whether or not a sweep has run. The delivery
   * API must agree with the site about that, or a page goes live on one and not the other.
   */
  it('serves a scheduled item whose time has passed', async () => {
    const item = await createItem(handle, pageType, fields, {
      contentTypeId: pageType.id,
      title: 'Launch',
      status: 'scheduled',
      publishAt: new Date(Date.now() - 1000).toISOString(),
      data: { body: 'x' },
    });

    const result = await resolveDelivery(handle.db, item.path, options);
    expect(result.kind).toBe('item');
  });

  it('reports a redirect rather than following it', async () => {
    const item = await page('Old');
    await updateItem(handle, pageType, fields, item.id, { slug: 'new' });

    const result = await resolveDelivery(handle.db, '/old', options);
    expect(result).toEqual({ kind: 'redirect', to: '/new', status: 301 });
  });

  it('answers not_found for a path with nothing behind it', async () => {
    expect((await resolveDelivery(handle.db, '/nothing', options)).kind).toBe('not_found');
  });
});

describe('what one call replaces', () => {
  it('returns breadcrumbs the embedded route walks one query at a time', async () => {
    const top = await page('Admissions');
    const mid = await page('Apply', top.id);
    const leaf = await page('Deadlines', mid.id);

    const result = await resolveDelivery(handle.db, leaf.path, options);
    if (result.kind !== 'item') throw new Error('expected an item');

    // The embedded route's own method, run here as the expectation.
    const expected = await Promise.all(
      ancestorPaths(leaf.path).map((p) => getItemByPath(handle.db, p)),
    );

    expect(result.breadcrumbs.map((b) => b.path)).toEqual(expected.map((i) => i!.path));
  });

  it('returns visible children and omits drafts', async () => {
    const parent = await page('Admissions');
    await page('Apply', parent.id);
    await page('Hidden', parent.id, 'draft');

    const result = await resolveDelivery(handle.db, parent.path, options);
    if (result.kind !== 'item') throw new Error('expected an item');

    const embedded = (await getChildren(handle.db, parent.id)).filter(
      (child) => child.status === 'published',
    );

    expect(result.children.map((c) => c.path)).toEqual(embedded.map((c) => c.path));
    expect(result.children.map((c) => c.title)).not.toContain('Hidden');
  });

  it('resolves SEO through the same function the site calls', async () => {
    const item = await page('Apply');
    await updateItem(handle, pageType, fields, item.id, {
      seo: { metaTitle: 'Apply to Riverbend', metaDescription: 'How to apply.' },
    });

    const result = await resolveDelivery(handle.db, item.path, options);
    if (result.kind !== 'item') throw new Error('expected an item');

    const fresh = await getItemByPath(handle.db, item.path);
    const embedded = resolveSeo(fresh!, pageType);

    expect(result.item.seo.title).toBe(embedded.title);
    expect(result.item.seo.description).toBe(embedded.description);
  });
});

describe('references', () => {
  it('returns media as absolute URLs with focal point and dimensions', async () => {
    const mediaId = crypto.randomUUID();
    await handle.db
      .insertInto('media')
      .values({
        id: mediaId,
        storage_key: '2026/08/quad.png',
        filename: 'quad.png',
        mime_type: 'image/png',
        size_bytes: 1000,
        width: 1600,
        height: 900,
        alt_text: 'The quad',
        title: null,
        hotspot_x: 0.3,
        hotspot_y: 0.4,
        crop_top: null,
        crop_right: null,
        crop_bottom: null,
        crop_left: null,
        uploaded_by: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    const withMedia = await createField(handle.db, pageType.id, {
      api_id: 'image',
      label: 'Image',
      type: 'media',
      required: false,
      localized: false,
      position: 1,
      config: {},
      help_text: null,
    });

    const item = await createItem(handle, pageType, [...fields, withMedia], {
      contentTypeId: pageType.id,
      title: 'Campus',
      status: 'published',
      data: { body: 'x', image: mediaId },
    });

    const result = await resolveDelivery(handle.db, item.path, options);
    if (result.kind !== 'item') throw new Error('expected an item');

    const asset = result.media[mediaId];
    // Absolute, because a relative URL is useless to a consumer on another origin.
    expect(asset!.url).toBe('https://example.edu/uploads/2026/08/quad.png');
    expect(asset!.alt).toBe('The quad');
    expect(asset!.hotspot).toEqual({ x: 0.3, y: 0.4 });
    expect(asset!.width).toBe(1600);

    // `data` keeps the stored id rather than the object, so it still matches the field's type.
    expect(result.item.data.image).toBe(mediaId);
  });

  it('does not name a draft through a relation field', async () => {
    const target = await page('Draft target', null, 'draft');

    const relation = await createField(handle.db, pageType.id, {
      api_id: 'related',
      label: 'Related',
      type: 'relation',
      required: false,
      localized: false,
      position: 1,
      config: { targetContentTypeId: pageType.id },
      help_text: null,
    });

    const item = await createItem(handle, pageType, [...fields, relation], {
      contentTypeId: pageType.id,
      title: 'Source',
      status: 'published',
      data: { body: 'x', related: target.id },
    });

    const result = await resolveDelivery(handle.db, item.path, options);
    if (result.kind !== 'item') throw new Error('expected an item');

    // The id is still in `data` — the CMS stores what the editor chose — but the lookup map omits
    // it, so a consumer cannot render a title or a path for something not publicly visible.
    expect(result.item.data.related).toBe(target.id);
    expect(result.references[target.id]).toBeUndefined();
  });

  it('dereferences a reusable block so a page is not a second round trip', async () => {
    const blockType = await createContentType(handle.db, {
      api_id: 'cta',
      name: 'Call to action',
      name_plural: 'Calls to action',
      kind: 'block',
      description: null,
      icon: null,
      url_prefix: null,
      summary_template: null,
    });
    const headingField = await createField(handle.db, blockType.id, {
      api_id: 'heading',
      label: 'Heading',
      type: 'text',
      required: false,
      localized: false,
      position: 0,
      config: {},
      help_text: null,
    });

    // The block type's own fields, because a library entry is only ever written validated — which
    // is exactly what lets a page referencing it skip field validation.
    const entry = await createReusableBlock(handle.db, [headingField], {
      name: 'Visit prompt',
      blockType: 'cta',
      data: { heading: 'Come and see us' },
    });

    const blockField = await createField(handle.db, pageType.id, {
      api_id: 'sections',
      label: 'Sections',
      type: 'block',
      required: false,
      localized: false,
      position: 1,
      config: {},
      help_text: null,
    });

    const item = await createItem(handle, pageType, [...fields, blockField], {
      contentTypeId: pageType.id,
      title: 'Visit',
      status: 'published',
      data: {
        body: 'x',
        sections: [{ id: 'b1', type: 'cta', reusable: true, ref: entry.id }],
      },
    });

    const result = await resolveDelivery(handle.db, item.path, options);
    if (result.kind !== 'item') throw new Error('expected an item');

    const blocks = result.item.data.sections as { data?: { heading?: string } }[];
    expect(blocks[0]!.data?.heading).toBe('Come and see us');
  });
});

describe('menus, and the callback that cannot cross HTTP', () => {
  /**
   * `SITE_TAG` was emitted by nothing while two write paths purged it, so a release publish and the
   * scheduler sweep both cleared zero entries and reported success. A menu is the response most
   * exposed to that: it has no `updated_at` to build a validator from, so a purge is the *only*
   * thing that can invalidate it inside its TTL.
   */
  it('tags a menu with site and its own api_id, or nothing can purge it', async () => {
    const menu = await createMenu(handle.db, {
      api_id: 'utility',
      name: 'Utility',
      description: null,
    });
    await createMenuItem(handle.db, menu.id, { targetType: 'url', label: 'Apply', url: '/apply' });

    const { cacheTags } = await deliverMenu(handle.db, 'utility');

    expect(cacheTags).toContain('site');
    expect(cacheTags).toContain('menu:utility');
  });

  it('returns a term target unresolved, for the consumer to route', async () => {
    const taxonomy = await createTaxonomy(handle.db, {
      api_id: 'department',
      name: 'Department',
      name_plural: 'Departments',
      description: null,
      hierarchical: 1,
    });
    const term = await createTerm(handle.db, taxonomy.id, {
      name: 'Student Services',
      slug: 'student-services',
    });

    const menu = await createMenu(handle.db, {
      api_id: 'main',
      name: 'Main',
      description: null,
    });
    await createMenuItem(handle.db, menu.id, { targetType: 'term', termId: term.id });

    const { items: delivered } = await deliverMenu(handle.db, 'main');

    /**
     * The whole point. `resolveMenu` takes a `termHref` callback and a function cannot cross an
     * HTTP boundary, so the endpoint hands back what the callback would have been given — and
     * "Taproot has no opinion about term URLs" survives the split intact.
     */
    expect(delivered[0]!.target).toEqual({
      type: 'term',
      id: term.id,
      name: 'Student Services',
      slug: 'student-services',
      taxonomyApiId: 'department',
    });
  });

  /** The equivalence that matters: applying the site's resolver gives what it had before. */
  it('produces the same hrefs as resolveMenu once the site applies its own policy', async () => {
    const taxonomy = await createTaxonomy(handle.db, {
      api_id: 'department',
      name: 'Department',
      name_plural: 'Departments',
      description: null,
      hierarchical: 1,
    });
    const term = await createTerm(handle.db, taxonomy.id, {
      name: 'Sciences',
      slug: 'sciences',
    });
    const item = await page('Admissions');

    const menu = await createMenu(handle.db, {
      api_id: 'main',
      name: 'Main',
      description: null,
    });
    await createMenuItem(handle.db, menu.id, { targetType: 'item', contentItemId: item.id });
    await createMenuItem(handle.db, menu.id, { targetType: 'term', termId: term.id });

    const termHref = (t: { taxonomyApiId: string; slug: string }) =>
      t.taxonomyApiId === 'department' ? termArchivePath(t.taxonomyApiId, t.slug) : null;

    const embedded = await resolveMenu(handle.db, 'main', { termHref });
    const delivered = applyTermHrefs((await deliverMenu(handle.db, 'main')).items, termHref);

    expect(delivered.map((e) => ({ label: e.label, href: e.href }))).toEqual(
      embedded.map((e) => ({ label: e.label, href: e.href })),
    );
  });

  it('drops a term the site publishes no page for, exactly as resolveMenu does', async () => {
    const taxonomy = await createTaxonomy(handle.db, {
      api_id: 'review_status',
      name: 'Review status',
      name_plural: 'Review statuses',
      description: null,
      hierarchical: 0,
    });
    const term = await createTerm(handle.db, taxonomy.id, { name: 'Needs review', slug: 'needs-review' });

    const menu = await createMenu(handle.db, { api_id: 'main', name: 'Main', description: null });
    await createMenuItem(handle.db, menu.id, { targetType: 'term', termId: term.id });

    // The delivered menu still carries it — the CMS does not decide — and the consumer's resolver
    // is what declines it.
    expect((await deliverMenu(handle.db, 'main')).items).toHaveLength(1);
    expect(applyTermHrefs((await deliverMenu(handle.db, 'main')).items, () => null)).toEqual([]);
  });
});

describe('the schema endpoint', () => {
  it('separates content types from block types', async () => {
    await createContentType(handle.db, {
      api_id: 'hero',
      name: 'Hero',
      name_plural: 'Heroes',
      kind: 'block',
      description: null,
      icon: null,
      url_prefix: null,
      summary_template: null,
    });

    const schema = await deliverySchema(handle.db);

    expect(schema.contentTypes.map((t) => t.apiId)).toEqual(['page']);
    expect(schema.blockTypes.map((t) => t.apiId)).toEqual(['hero']);
    expect(schema.contentTypes[0]!.fields.map((f) => f.apiId)).toEqual(['body']);
  });
});

/**
 * References stored inside a repeater row.
 *
 * A row is `{ id, data }` and the sub-field values live under `data`, so a walk that reads the row
 * itself finds nothing — the same envelope mistake `typegen` made. It is invisible from a block,
 * because a block's values go through `collectLoose`, which walks structurally and picks the id up
 * anyway; only a repeater at the top level of a content type is affected.
 */
describe('references inside a repeater row', () => {
  it('collects a media id one level down, under `data`', () => {
    const refs = collectReferences(
      [
        {
          id: 'f-gallery',
          content_type_id: 't1',
          api_id: 'gallery',
          label: 'Gallery',
          type: 'repeater',
          help_text: null,
          position: 0,
          required: 0,
          localized: 0,
          config: JSON.stringify({
            fields: [{ api_id: 'shot', label: 'Shot', type: 'media', required: false, config: {} }],
          }),
        } as unknown as FieldRow,
      ],
      { gallery: [{ id: 'row-1', data: { shot: '11111111-1111-1111-1111-111111111111' } }] },
    );

    expect([...refs.mediaIds]).toContain('11111111-1111-1111-1111-111111111111');
  });
});

/**
 * A link's target has to reach the lookup maps.
 *
 * `{ kind: 'item', id }` is a reference exactly as a relation field's id is, and the maps are the
 * only route from that id to a path — a link field that never reached `collectReferences` would
 * render as a dead button, with nothing anywhere reporting a problem.
 */
describe('references from a link field', () => {
  const linkField = {
    id: 'f-cta',
    content_type_id: 't1',
    api_id: 'cta',
    label: 'Call to action',
    type: 'link',
    help_text: null,
    position: 0,
    required: 0,
    localized: 0,
    config: '{}',
  } as unknown as FieldRow;

  it('collects an item link as an item reference', () => {
    const refs = collectReferences([linkField], {
      cta: { kind: 'item', id: '22222222-2222-2222-2222-222222222222', newTab: false, noFollow: false },
    });

    expect([...refs.itemIds]).toContain('22222222-2222-2222-2222-222222222222');
    expect([...refs.mediaIds]).toEqual([]);
  });

  it('collects a file link as a media reference', () => {
    const refs = collectReferences([linkField], {
      cta: { kind: 'media', id: '33333333-3333-3333-3333-333333333333', newTab: false, noFollow: false },
    });

    expect([...refs.mediaIds]).toContain('33333333-3333-3333-3333-333333333333');
    expect([...refs.itemIds]).toEqual([]);
  });

  /** An address is not a reference, and must not be offered to any of the maps as a lookup key. */
  it('collects nothing from an address', () => {
    const refs = collectReferences([linkField], {
      cta: { kind: 'url', href: 'https://example.edu', newTab: true, noFollow: false },
    });

    expect([...refs.itemIds]).toEqual([]);
    expect([...refs.mediaIds]).toEqual([]);
    expect([...refs.termIds]).toEqual([]);
  });
});
