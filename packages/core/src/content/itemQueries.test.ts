import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createContentType, createField } from './types.js';
import { createItem } from './items.js';
import { createTaxonomy, createTerm } from './taxonomies.js';
import { resolveDelivery } from './delivery.js';
import { queryKey } from './queryKeys.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';
import type { StorageAdapter } from '../storage/types.js';

/**
 * The `query` field, end to end through the delivery payload.
 *
 * The properties worth defending are all about *where the answer goes and what it costs*: results
 * never overwrite the stored rule, a result's own references resolve through the payload's existing
 * maps rather than a second round of loading, and the whole thing is addressed by placement so the
 * same block type twice on one page gets two answers.
 */

const storage = {
  name: 'local',
  publicUrl: (key: string) => `/uploads/${key}`,
} as unknown as StorageAdapter;

const options = { origin: 'https://example.edu', storage };

let handle: TaprootDb;
let eventType: ContentTypeRow;
let pageType: ContentTypeRow;
let pageFields: FieldRow[];
let departments: { id: string };
let arts: { id: string };
let music: { id: string };

async function makeType(apiId: string, name: string) {
  return createContentType(handle.db, {
    api_id: apiId,
    name,
    name_plural: `${name}s`,
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    title_field: 'title',
  });
}

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const migrated = await migrateToLatest(handle.db);
  if (migrated.error) throw migrated.error;

  departments = await createTaxonomy(handle.db, {
    api_id: 'department',
    name: 'Department',
    name_plural: 'Departments',
    description: null,
  });
  arts = await createTerm(handle.db, departments.id, { name: 'Arts', slug: 'arts', parentId: null });
  // A child of Arts, so branch expansion has something to find.
  music = await createTerm(handle.db, departments.id, {
    name: 'Music',
    slug: 'music',
    parentId: arts.id,
  });

  eventType = await makeType('event', 'Event');
  const eventFields = [
    await createField(handle.db, eventType.id, {
      api_id: 'starts_at',
      label: 'Starts',
      type: 'date',
      required: false,
      localized: false,
      help_text: null,
      config: { includeTime: true },
    }),
    await createField(handle.db, eventType.id, {
      api_id: 'location',
      label: 'Location',
      type: 'text',
      required: false,
      localized: false,
      help_text: null,
      config: {},
    }),
    await createField(handle.db, eventType.id, {
      api_id: 'department',
      label: 'Department',
      type: 'taxonomy',
      required: false,
      localized: false,
      help_text: null,
      config: { taxonomyId: departments.id, multiple: true },
    }),
  ];

  pageType = await makeType('page', 'Page');
  pageFields = [
    await createField(handle.db, pageType.id, {
      api_id: 'events',
      label: 'Events',
      type: 'query',
      required: false,
      localized: false,
      help_text: null,
      config: { targetContentTypeId: eventType.id, taxonomyId: departments.id, maxResults: 10 },
    }),
  ];

  /**
   * Dates far enough from now that the suite cannot race the clock, and deliberately out of
   * alphabetical order so "soonest first" is distinguishable from "by title".
   */
  const events = [
    {
      title: 'Jazz Night',
      slug: 'jazz-night',
      terms: [music.id],
      location: 'Chapel Hall',
      starts_at: '2090-06-01T19:00:00.000Z',
    },
    {
      title: 'Ceramics Open Studio',
      slug: 'ceramics',
      terms: [arts.id],
      location: 'Studio 2',
      starts_at: '2090-01-15T10:00:00.000Z',
    },
    {
      title: 'Physics Colloquium',
      slug: 'physics',
      terms: [],
      location: 'Lecture Room 1',
      starts_at: '2000-03-02T14:00:00.000Z',
    },
  ];

  for (const event of events) {
    await createItem(handle, eventType, eventFields, {
      contentTypeId: eventType.id,
      title: event.title,
      slug: event.slug,
      parentId: null,
      status: 'published',
      data: {
        starts_at: event.starts_at,
        location: event.location,
        department: event.terms,
      },
      seo: {},
      userId: null,
    });
  }
});

async function makePage(data: Record<string, unknown>, slug = 'listing') {
  return createItem(handle, pageType, pageFields, {
    contentTypeId: pageType.id,
    title: 'Listing',
    slug,
    parentId: null,
    status: 'published',
    data,
    seo: {},
    userId: null,
  });
}

async function resolve(path: string) {
  const result = await resolveDelivery(handle.db, path, options);
  if (result.kind !== 'item') throw new Error(`Expected an item, got ${result.kind}`);
  return result;
}

describe('resolving a query into the payload', () => {
  it('answers under a key built from the placement, not the field alone', async () => {
    const page = await makePage({ events: { termIds: [], sort: 'title', limit: 10 } });
    const result = await resolve(page.path);

    // Top level, so the container is the item itself.
    const answer = result.queries[queryKey(page.id, 'events')];
    expect(answer).toBeTruthy();
    expect(answer!.total).toBe(3);
    expect(answer!.ids).toHaveLength(3);
  });

  it('leaves the stored rule in `data` rather than overwriting it with the answer', async () => {
    /**
     * The rule that keeps the payload usable for a write, and keeps the generated types honest.
     * Overwriting `data.events` with the results would not round-trip at all — a save would then
     * post a list of items where a query belongs.
     */
    const rule = { termIds: [], sort: 'title' as const, limit: 10, dateFilter: 'any' as const };
    const page = await makePage({ events: rule });
    const result = await resolve(page.path);

    expect(result.item.data.events).toEqual(rule);
  });

  it('expands a term filter down the branch', async () => {
    // Jazz Night is filed under Music, which is inside Arts — asking for Arts has to find it, or
    // filing something precisely would make it disappear from its parent's listing.
    const page = await makePage({ events: { termIds: [arts.id], sort: 'title', limit: 10 } });
    const result = await resolve(page.path);

    const answer = result.queries[queryKey(page.id, 'events')]!;
    const titles = answer.ids.map((id) => result.references[id]!.title);
    expect(titles).toEqual(['Ceramics Open Studio', 'Jazz Night']);
    expect(titles).not.toContain('Physics Colloquium');
  });

  it('treats an empty term selection as no filter, not as "match nothing"', async () => {
    /**
     * The opposite of `ItemFilters.termIds`' own convention, deliberately. There an empty array
     * comes from a caller asking for a term with no members. Here it comes from an editor who has
     * not picked one, and matching nothing would make a freshly placed block look broken.
     */
    const page = await makePage({ events: { termIds: [], sort: 'title', limit: 10 } });
    const result = await resolve(page.path);

    expect(result.queries[queryKey(page.id, 'events')]!.total).toBe(3);
  });

  it('reports the true total even when the limit cuts the list short', async () => {
    // The count is what tells an editor their filter is too narrow, so it must count matches rather
    // than the page of them being returned.
    const page = await makePage({ events: { termIds: [], sort: 'title', limit: 2 } });
    const result = await resolve(page.path);

    const answer = result.queries[queryKey(page.id, 'events')]!;
    expect(answer.ids).toHaveLength(2);
    expect(answer.total).toBe(3);
  });

  it('clamps a limit above the field’s ceiling instead of refusing it', async () => {
    const page = await makePage({ events: { termIds: [], sort: 'title', limit: 500 } });
    const result = await resolve(page.path);

    // `maxResults` is 10 on this field, and only three events exist — so the clamp shows up as the
    // request succeeding at all rather than as a shorter list.
    expect(result.queries[queryKey(page.id, 'events')]!.ids).toHaveLength(3);
  });
});

describe('what a result carries', () => {
  it('carries the matched item’s own fields, so a card can render', async () => {
    const page = await makePage({ events: { termIds: [], sort: 'title', limit: 10 } });
    const result = await resolve(page.path);

    const answer = result.queries[queryKey(page.id, 'events')]!;
    const jazz = answer.ids.map((id) => result.references[id]!).find((ref) => ref.title === 'Jazz Night');

    expect(jazz).toBeTruthy();
    // Without `data` a listing is a row of links, which is not what an events grid is.
    expect(jazz!.data?.location).toBe('Chapel Hall');
    expect(jazz!.path).toBe('/jazz-night');
  });

  it('resolves a result’s own term references through the payload’s maps', async () => {
    /**
     * The reason queries run *before* `collectReferences`. A matched event's department is an id
     * inside *its* data, not the page's — so unless those ids reach `collected` before the loaders,
     * every listing ships ids that resolve to nothing.
     */
    const page = await makePage({ events: { termIds: [], sort: 'title', limit: 10 } });
    const result = await resolve(page.path);

    expect(result.terms[music.id]?.name).toBe('Music');
    expect(result.terms[arts.id]?.name).toBe('Arts');
  });

  it('leaves a page with no query field with an empty map rather than no key', async () => {
    const plain = await createContentType(handle.db, {
      api_id: 'plain',
      name: 'Plain',
      name_plural: 'Plains',
      kind: 'page',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: 'title',
    });
    const item = await createItem(handle, plain, [], {
      contentTypeId: plain.id,
      title: 'Plain',
      slug: 'plain',
      parentId: null,
      status: 'published',
      data: {},
      seo: {},
      userId: null,
    });

    const result = await resolve(item.path);
    expect(result.queries).toEqual({});
  });
});

describe('filtering and ordering by the item’s own date', () => {
  /** A second page type whose query field nominates the events' own `starts_at`. */
  async function datedPage(value: Record<string, unknown>, slug: string) {
    const type = await createContentType(handle.db, {
      api_id: `dated_${slug}`,
      name: 'Dated',
      name_plural: 'Dated',
      kind: 'page',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: 'title',
    });
    const field = await createField(handle.db, type.id, {
      api_id: 'events',
      label: 'Events',
      type: 'query',
      required: false,
      localized: false,
      help_text: null,
      config: {
        targetContentTypeId: eventType.id,
        taxonomyId: departments.id,
        dateFieldApiId: 'starts_at',
        maxResults: 10,
      },
    });

    return createItem(handle, type, [field], {
      contentTypeId: type.id,
      title: 'Dated',
      slug,
      parentId: null,
      status: 'published',
      data: { events: value },
      seo: {},
      userId: null,
    });
  }

  it('orders by the event’s own date, not by when it was published', async () => {
    /**
     * The case the whole value index exists for. All three events were created in the same second,
     * so `newest` cannot distinguish them — only `starts_at` can, and it lives inside `data`, which
     * is TEXT. Ceramics is in January and Jazz in June, so the order is the reverse of both their
     * creation order and their titles.
     */
    const page = await datedPage(
      { termIds: [], sort: 'field_asc', limit: 10, dateFilter: 'any' },
      'soonest',
    );
    const result = await resolve(page.path);

    const answer = result.queries[queryKey(page.id, 'events')]!;
    expect(answer.ids.map((id) => result.references[id]!.title)).toEqual([
      'Physics Colloquium',
      'Ceramics Open Studio',
      'Jazz Night',
    ]);
  });

  it('reverses cleanly', async () => {
    const page = await datedPage(
      { termIds: [], sort: 'field_desc', limit: 10, dateFilter: 'any' },
      'latest',
    );
    const result = await resolve(page.path);

    const answer = result.queries[queryKey(page.id, 'events')]!;
    expect(answer.ids.map((id) => result.references[id]!.title)[0]).toBe('Jazz Night');
  });

  it('lists only what is still to come', async () => {
    // "Upcoming" is resolved against the clock at read time, never stored — a saved bound would be
    // frozen at whenever somebody last pressed save, and the page would stop listing anything.
    const page = await datedPage(
      { termIds: [], sort: 'field_asc', limit: 10, dateFilter: 'upcoming' },
      'upcoming',
    );
    const result = await resolve(page.path);

    const answer = result.queries[queryKey(page.id, 'events')]!;
    const titles = answer.ids.map((id) => result.references[id]!.title);
    expect(titles).toEqual(['Ceramics Open Studio', 'Jazz Night']);
    expect(answer.total).toBe(2);
  });

  it('lists only what has already happened', async () => {
    const page = await datedPage(
      { termIds: [], sort: 'field_desc', limit: 10, dateFilter: 'past' },
      'past',
    );
    const result = await resolve(page.path);

    const answer = result.queries[queryKey(page.id, 'events')]!;
    expect(answer.ids.map((id) => result.references[id]!.title)).toEqual(['Physics Colloquium']);
  });

  it('combines the date window with a term filter', async () => {
    // Two conditions on a listing mean both — the AND is what makes "upcoming Arts events" a thing
    // somebody can express rather than two listings side by side.
    const page = await datedPage(
      { termIds: [arts.id], sort: 'field_asc', limit: 10, dateFilter: 'upcoming' },
      'upcoming-arts',
    );
    const result = await resolve(page.path);

    const answer = result.queries[queryKey(page.id, 'events')]!;
    expect(answer.ids.map((id) => result.references[id]!.title)).toEqual([
      'Ceramics Open Studio',
      'Jazz Night',
    ]);
  });

  it('degrades to site order when the nominated date field has been deleted', async () => {
    /**
     * A query outlives the content type it points at. Refusing to answer would take down a live
     * page for a configuration mistake made on a different screen weeks earlier, so the bound is
     * dropped and the order falls back — the listing shows too much rather than erroring.
     */
    const type = await createContentType(handle.db, {
      api_id: 'stale',
      name: 'Stale',
      name_plural: 'Stale',
      kind: 'page',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: 'title',
    });
    const field = await createField(handle.db, type.id, {
      api_id: 'events',
      label: 'Events',
      type: 'query',
      required: false,
      localized: false,
      help_text: null,
      config: {
        targetContentTypeId: eventType.id,
        dateFieldApiId: 'a_field_that_never_existed',
        maxResults: 10,
      },
    });

    const item = await createItem(handle, type, [field], {
      contentTypeId: type.id,
      title: 'Stale',
      slug: 'stale',
      parentId: null,
      status: 'published',
      data: { events: { termIds: [], sort: 'field_asc', limit: 10, dateFilter: 'upcoming' } },
      seo: {},
      userId: null,
    });

    const result = await resolve(item.path);
    // All three, because the "upcoming" bound had nothing to apply to.
    expect(result.queries[queryKey(item.id, 'events')]!.total).toBe(3);
  });
});

describe('a query inside a block', () => {
  it('gives two placements of one block type two different answers', async () => {
    /**
     * The reason the key is composite rather than the field's `api_id`.
     *
     * A listing block is exactly the sort of thing somebody puts on a page twice — "Arts events"
     * and "everything else" — and both placements share one field definition. Keyed by the field
     * alone the second would overwrite the first, and the page would render the same list twice
     * with no error anywhere.
     */
    const listingBlock = await createContentType(handle.db, {
      api_id: 'event_listing',
      name: 'Event listing',
      name_plural: 'Event listings',
      kind: 'block',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: null,
    });

    await createField(handle.db, listingBlock.id, {
      api_id: 'events',
      label: 'Events',
      type: 'query',
      required: false,
      localized: false,
      help_text: null,
      config: { targetContentTypeId: eventType.id, taxonomyId: departments.id, maxResults: 10 },
    });

    const withBlocks = await createContentType(handle.db, {
      api_id: 'composed',
      name: 'Composed',
      name_plural: 'Composed',
      kind: 'page',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: 'title',
    });
    const sections = await createField(handle.db, withBlocks.id, {
      api_id: 'sections',
      label: 'Sections',
      type: 'block',
      required: false,
      localized: false,
      help_text: null,
      config: { allowedBlocks: ['event_listing'] },
    });

    const item = await createItem(handle, withBlocks, [sections], {
      contentTypeId: withBlocks.id,
      title: 'Composed',
      slug: 'composed',
      parentId: null,
      status: 'published',
      data: {
        sections: [
          {
            id: 'block-arts',
            type: 'event_listing',
            data: { events: { termIds: [arts.id], sort: 'title', limit: 10 } },
          },
          {
            id: 'block-all',
            type: 'event_listing',
            data: { events: { termIds: [], sort: 'title', limit: 10 } },
          },
        ],
      },
      seo: {},
      userId: null,
    });

    const result = await resolve(item.path);

    // Keyed by the *block instance*, not the item and not the field.
    const artsOnly = result.queries[queryKey('block-arts', 'events')];
    const everything = result.queries[queryKey('block-all', 'events')];

    expect(artsOnly?.total).toBe(2);
    expect(everything?.total).toBe(3);
    // And nothing landed under the item's own id, which is what a collapsed key would produce.
    expect(result.queries[queryKey(item.id, 'events')]).toBeUndefined();
  });
});

describe('visibility', () => {
  it('never lists a draft, so the preview matches what will publish', async () => {
    /**
     * The rest of a preview deliberately *does* show unpublished content. A listing is different in
     * kind: it is a claim about what the site will look like once the page is live, so including
     * drafts would let an editor tune a listing to six results and watch four vanish at publish.
     */
    const draftFields = await handle.db
      .selectFrom('fields')
      .selectAll()
      .where('content_type_id', '=', eventType.id)
      .execute();

    await createItem(handle, eventType, draftFields as FieldRow[], {
      contentTypeId: eventType.id,
      title: 'Unannounced Gala',
      slug: 'gala',
      parentId: null,
      status: 'draft',
      data: { location: 'TBC', department: [] },
      seo: {},
      userId: null,
    });

    const page = await makePage({ events: { termIds: [], sort: 'title', limit: 10 } });
    const result = await resolve(page.path);

    const answer = result.queries[queryKey(page.id, 'events')]!;
    expect(answer.total).toBe(3);
    expect(answer.ids.map((id) => result.references[id]!.title)).not.toContain('Unannounced Gala');
  });
});
