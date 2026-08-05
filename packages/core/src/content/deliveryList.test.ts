import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createContentType, createField } from './types.js';
import { createItem } from './items.js';
import { createTaxonomy, createTerm, termIdsForBranch } from './taxonomies.js';
import { deliverItems, deliverTaxonomyTerms, resolveDelivery } from './delivery.js';
import type { ContentTypeRow, FieldRow, TermRow } from '../db/schema.js';
import type { StorageAdapter } from '../storage/types.js';

/**
 * The delivered listing, and the terms a facet is built from.
 *
 * What is being defended is that an index page and a `query` field's results are **one shape**. A
 * consumer's card component is written once and rendered from either, so anything this carries that
 * a query result does not — or the other way round — is a branch somebody has to write and a place
 * the two can drift.
 *
 * And that a facet's numbers describe the rows clicking it returns. A count that meant something
 * subtly different from the filter is worse than no count: it is wrong on exactly the terms nobody
 * checks.
 */

let handle: TaprootDb;
let personType: ContentTypeRow;
let fields: FieldRow[];
let department: { id: string };
let terms: Record<string, TermRow>;

const storage = {
  name: 'local',
  publicUrl: (key: string) => `/uploads/${key}`,
} as unknown as StorageAdapter;

const options = { origin: 'https://example.edu', storage };

async function field(
  type: FieldRow['type'],
  api_id: string,
  config: Record<string, unknown> = {},
  position = 0,
) {
  return createField(handle.db, personType.id, {
    api_id,
    label: api_id,
    type,
    required: false,
    localized: false,
    position,
    config,
    help_text: null,
  });
}

async function media(alt: string): Promise<string> {
  const id = crypto.randomUUID();
  await handle.db
    .insertInto('media')
    .values({
      id,
      storage_key: `2026/08/${alt}.png`,
      filename: `${alt}.png`,
      mime_type: 'image/png',
      size_bytes: 1000,
      width: 800,
      height: 800,
      alt_text: alt,
      title: null,
      hotspot_x: null,
      hotspot_y: null,
      crop_top: null,
      crop_right: null,
      crop_bottom: null,
      crop_left: null,
      uploaded_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
  return id;
}

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const migrated = await migrateToLatest(handle.db);
  if (migrated.error) throw migrated.error;

  const taxonomy = await createTaxonomy(handle.db, {
    api_id: 'department',
    name: 'Department',
    name_plural: 'Departments',
    description: null,
    hierarchical: 1,
  });
  department = taxonomy;

  const sciences = await createTerm(handle.db, taxonomy.id, { name: 'Sciences', slug: 'sciences' });
  const biology = await createTerm(handle.db, taxonomy.id, {
    name: 'Biology',
    slug: 'biology',
    parentId: sciences.id,
  });
  const admissions = await createTerm(handle.db, taxonomy.id, {
    name: 'Admissions',
    slug: 'admissions',
  });
  terms = { sciences, biology, admissions };

  personType = await createContentType(handle.db, {
    api_id: 'person',
    name: 'Person',
    name_plural: 'People',
    kind: 'collection',
    description: null,
    icon: null,
    url_prefix: '/people',
    title_field: 'title',
  });

  const blockType = await createContentType(handle.db, {
    api_id: 'quote',
    name: 'Quote',
    name_plural: 'Quotes',
    kind: 'block',
    description: null,
    icon: null,
    url_prefix: null,
    title_field: null,
  });
  await createField(handle.db, blockType.id, {
    api_id: 'words',
    label: 'Words',
    type: 'text',
    required: false,
    localized: false,
    position: 0,
    config: {},
    help_text: null,
  });

  fields = [
    await field('text', 'role', {}, 0),
    await field('media', 'photo', {}, 1),
    // Several departments per person, which is the case a directory actually has.
    await field('taxonomy', 'departments', { taxonomyApiId: 'department', multiple: true }, 2),
    await field('richtext', 'bio', {}, 3),
    await field('block', 'sections', {}, 4),
  ];
});

async function person(title: string, data: Record<string, unknown>) {
  return createItem(handle, personType, fields, {
    contentTypeId: personType.id,
    title,
    status: 'published',
    data,
  });
}

describe('a listing without data', () => {
  it('sends summaries and no maps at all', async () => {
    await person('Marguerite Okafor', { role: 'Registrar' });

    const list = await deliverItems(handle.db, { ...options });

    expect(list.total).toBe(1);
    expect(list.items[0]!.title).toBe('Marguerite Okafor');
    expect(list.items[0]!.data).toBeUndefined();

    /**
     * Absent rather than empty. There is nothing to look up in — a summary carries no ids — and an
     * empty object would read as "asked, and this site has no media", which is a different fact.
     */
    expect(list.media).toBeUndefined();
    expect(list.terms).toBeUndefined();
    expect(list.references).toBeUndefined();
  });

  it('carries the keys a card needs beyond a bare reference', async () => {
    await person('Marguerite Okafor', {});
    const [item] = (await deliverItems(handle.db, { ...options })).items;

    // A superset of DeliveryItemRef, so a component written for a query result renders one of these
    // unchanged — and an index page still gets the slug and timestamps it has always had.
    expect(item).toMatchObject({
      id: expect.any(String),
      title: 'Marguerite Okafor',
      path: '/people/marguerite-okafor',
      status: 'published',
      slug: 'marguerite-okafor',
      updatedAt: expect.any(String),
    });
    expect(item!.publishedAt).not.toBeNull();
  });
});

describe('a listing with data', () => {
  it('carries the fields a card renders and strips what it cannot', async () => {
    const photo = await media('marguerite');
    await person('Marguerite Okafor', {
      role: 'Registrar',
      photo,
      departments: [terms.admissions!.id],
      bio: '<p>Twenty years in admissions.</p>',
      sections: [{ id: 'b1', type: 'quote', data: { words: 'Not in a listing' } }],
    });

    const list = await deliverItems(handle.db, { ...options, includeData: true });
    const item = list.items[0]!;

    expect(item.data).toMatchObject({
      role: 'Registrar',
      photo,
      bio: '<p>Twenty years in admissions.</p>',
    });

    /**
     * `block` is stripped, exactly as it is from a query result. A listing card renders a thumbnail
     * and a name; it does not render another page's page-builder blocks, and carrying them would
     * multiply the payload by the size of every listed page's body.
     */
    expect(item.data).not.toHaveProperty('sections');
  });

  it('resolves ids through maps beside the items, not inlined into data', async () => {
    const photo = await media('marguerite');
    await person('Marguerite Okafor', { photo, departments: [terms.admissions!.id] });

    const list = await deliverItems(handle.db, { ...options, includeData: true });

    // The id stays in `data` — which is what keeps the payload usable for a write and matching the
    // generated types — and the lookup happens in the map, exactly as `resolve` does it.
    expect(list.items[0]!.data!.photo).toBe(photo);
    expect(list.media![photo]!.url).toBe('https://example.edu/uploads/2026/08/marguerite.png');
    expect(list.media![photo]!.alt).toBe('marguerite');
    expect(list.terms![terms.admissions!.id]!.name).toBe('Admissions');
  });

  it('carries every term of a multi-value field, not just the first', async () => {
    /**
     * The case a real directory has: somebody sits in two departments, and a facet built on the
     * first one silently loses the second — on the person most likely to be looked up, since
     * cross-appointments are what people search for.
     */
    await person('Marguerite Okafor', {
      departments: [terms.admissions!.id, terms.biology!.id],
    });

    const list = await deliverItems(handle.db, { ...options, includeData: true });

    expect(list.items[0]!.data!.departments).toEqual([terms.admissions!.id, terms.biology!.id]);
    expect(Object.keys(list.terms!).sort()).toEqual(
      [terms.admissions!.id, terms.biology!.id].sort(),
    );
  });

  it('resolves an internal link in a listed item’s prose', async () => {
    const target = await person('Nadia Vance', {});
    await person('Marguerite Okafor', {
      bio: `<p>Reports to <a href="taproot:item:${target.id}">Nadia</a>.</p>`,
    });

    const list = await deliverItems(handle.db, { ...options, includeData: true, sort: 'title' });
    const bio = list.items[0]!.data!.bio as string;

    /**
     * A marker left in place ships `taproot:item:…` to a visitor the moment a site forgets a helper
     * — and a summary field on a card is exactly where nobody would notice. Same rule the host
     * item's own richtext follows on `resolve`.
     */
    expect(bio).toContain('href="/people/nadia-vance"');
    expect(bio).not.toContain('taproot:item:');
  });

  it('shows a visitor nothing that is not live', async () => {
    await createItem(handle, personType, fields, {
      contentTypeId: personType.id,
      title: 'Unannounced Hire',
      status: 'draft',
      data: { role: 'Incoming' },
    });

    const list = await deliverItems(handle.db, { ...options, includeData: true });

    // In SQL rather than over the results, or `total` counts rows the caller never sees and a page
    // of ten arrives with six on it.
    expect(list.total).toBe(0);
    expect(list.items).toEqual([]);
  });
});

describe('the terms a facet is built from', () => {
  it('answers the taxonomy flat, with parents before their children', async () => {
    const taxonomy = await deliverTaxonomyTerms(handle.db, 'department');

    expect(taxonomy!.hierarchical).toBe(true);
    expect(taxonomy!.terms.map((term) => term.name)).toEqual(['Sciences', 'Biology', 'Admissions']);

    const biology = taxonomy!.terms.find((term) => term.slug === 'biology');
    expect(biology!.parentId).toBe(terms.sciences!.id);
    // Not counted unless asked, so a menu that only needs names pays for one query rather than two.
    expect(biology!.itemCount).toBeUndefined();
  });

  it('takes the taxonomy by id as well as by name', async () => {
    /**
     * The consumer most likely to want this endpoint is the one reading the content model — and a
     * `taxonomy` field's schema entry carries `config.taxonomyId` and no `api_id`. Accepting only
     * the name made "here is a field, show me its terms" impossible without a human opening the
     * admin to look the name up. An `api_id` is a slug and an id is a uuid, so neither can be
     * mistaken for the other.
     */
    const byName = await deliverTaxonomyTerms(handle.db, 'department');
    const byId = await deliverTaxonomyTerms(handle.db, department.id);

    expect(byId).toEqual(byName);
    expect(byId!.terms).toHaveLength(3);
  });

  it('is undefined for a taxonomy that does not exist', async () => {
    // The route turns this into a 404. An empty list would read as "no terms yet", which is a real
    // state — so a misspelled api_id would hide until somebody happened to add a term.
    expect(await deliverTaxonomyTerms(handle.db, 'departmnet')).toBeUndefined();
  });

  it('counts a whole branch, and counts an item in two of its terms once', async () => {
    await person('In Biology', { departments: [terms.biology!.id] });
    await person('In both', { departments: [terms.sciences!.id, terms.biology!.id] });
    await person('In Admissions', { departments: [terms.admissions!.id] });

    const taxonomy = await deliverTaxonomyTerms(handle.db, 'department', { counts: true });
    const count = (slug: string) =>
      taxonomy!.terms.find((term) => term.slug === slug)!.itemCount;

    /**
     * Sciences is two, not three. Summing a child's count into its parent is the obvious
     * implementation and reports the person filed under both twice — on precisely the people a
     * directory is most likely to have, since a cross-appointment is why anybody tags two.
     */
    expect(count('biology')).toBe(2);
    expect(count('sciences')).toBe(2);
    expect(count('admissions')).toBe(1);
  });

  it('counts what filtering by the term returns', async () => {
    await person('In Biology', { departments: [terms.biology!.id] });
    await person('In both', { departments: [terms.sciences!.id, terms.biology!.id] });

    const taxonomy = await deliverTaxonomyTerms(handle.db, 'department', { counts: true });
    const sciences = taxonomy!.terms.find((term) => term.slug === 'sciences')!;

    // The number beside a facet and the rows clicking it returns are the same set, or the count is
    // wrong on exactly the terms nobody checks.
    const filtered = await deliverItems(handle.db, {
      ...options,
      termIds: await termIdsForBranch(handle.db, terms.sciences!.id),
    });

    expect(sciences.itemCount).toBe(filtered.total);
  });

  it('counts only the type the listing beside it shows', async () => {
    const newsType = await createContentType(handle.db, {
      api_id: 'news',
      name: 'News',
      name_plural: 'News',
      kind: 'collection',
      description: null,
      icon: null,
      url_prefix: '/news',
      title_field: 'title',
    });
    const tagged = await createField(handle.db, newsType.id, {
      api_id: 'departments',
      label: 'Departments',
      type: 'taxonomy',
      required: false,
      localized: false,
      position: 0,
      config: { taxonomyApiId: 'department', multiple: true },
      help_text: null,
    });

    await person('In Admissions', { departments: [terms.admissions!.id] });
    await createItem(handle, newsType, [tagged], {
      contentTypeId: newsType.id,
      title: 'Admissions opens',
      status: 'published',
      data: { departments: [terms.admissions!.id] },
    });

    const everything = await deliverTaxonomyTerms(handle.db, 'department', { counts: true });
    const people = await deliverTaxonomyTerms(handle.db, 'department', {
      counts: true,
      contentTypeId: personType.id,
    });

    const admissions = (taxonomy: Awaited<ReturnType<typeof deliverTaxonomyTerms>>) =>
      taxonomy!.terms.find((term) => term.slug === 'admissions')!.itemCount;

    expect(admissions(everything)).toBe(2);
    // "Admissions (2)" beside a grid of people showing one is the facet lying about its own filter.
    expect(admissions(people)).toBe(1);
  });

  it('counts only what a visitor can see', async () => {
    await createItem(handle, personType, fields, {
      contentTypeId: personType.id,
      title: 'Unannounced Hire',
      status: 'draft',
      data: { departments: [terms.admissions!.id] },
    });

    const taxonomy = await deliverTaxonomyTerms(handle.db, 'department', { counts: true });

    expect(taxonomy!.terms.find((term) => term.slug === 'admissions')!.itemCount).toBe(0);
  });

  it('leaves a taxonomy nobody has used at zero rather than absent', async () => {
    const taxonomy = await deliverTaxonomyTerms(handle.db, 'department', { counts: true });

    // A term with no content is a checkbox with "(0)", not a missing checkbox — the second reads as
    // a term that does not exist, which is what an editor is about to file something under.
    expect(taxonomy!.terms.every((term) => term.itemCount === 0)).toBe(true);
    expect(taxonomy!.terms).toHaveLength(3);
  });
});

describe('one shape for a listing and a query result', () => {
  /**
   * The promise the whole feature rests on: a card component written against a `query` field's
   * results renders a listing's items unchanged.
   *
   * Asserted by building both answers for the *same person* and comparing them, rather than by
   * checking each against a list of expected keys — a list would pass while the two drifted apart,
   * which is the only failure that matters here. The consequence of drift is a card that silently
   * gains a key it cannot render or loses one it relies on, on whichever of the two pages nobody
   * opened.
   */
  it('answers the same item identically through both paths', async () => {
    const photo = await media('marguerite');
    const subject = await person('Marguerite Okafor', {
      role: 'Registrar',
      photo,
      departments: [terms.admissions!.id, terms.biology!.id],
      bio: '<p>Twenty years in admissions.</p>',
      sections: [{ id: 'b1', type: 'quote', data: { words: 'Not in a listing' } }],
    });

    const hostType = await createContentType(handle.db, {
      api_id: 'landing',
      name: 'Landing',
      name_plural: 'Landings',
      kind: 'page',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: 'title',
    });
    const listing = await createField(handle.db, hostType.id, {
      api_id: 'people',
      label: 'People',
      type: 'query',
      required: false,
      localized: false,
      position: 0,
      config: { targetContentTypeId: personType.id, taxonomyId: department.id, maxResults: 10 },
      help_text: null,
    });

    await createItem(handle, hostType, [listing], {
      contentTypeId: hostType.id,
      title: 'Directory',
      status: 'published',
      data: { people: { limit: 5, sort: 'title' } },
    });

    const page = await resolveDelivery(handle.db, '/directory', options);
    if (page.kind !== 'item') throw new Error('expected an item');

    const list = await deliverItems(handle.db, { ...options, includeData: true });

    const fromQuery = page.references[subject.id]!;
    const fromListing = list.items.find((entry) => entry.id === subject.id)!;

    expect(fromQuery.data).toEqual(fromListing.data);
    // And the reference half of the shape, which is what a card links with.
    expect(fromListing).toMatchObject({
      id: fromQuery.id,
      title: fromQuery.title,
      path: fromQuery.path,
      status: fromQuery.status,
    });
  });
});
