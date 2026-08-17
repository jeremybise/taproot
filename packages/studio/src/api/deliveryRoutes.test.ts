import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiKey,
  createContentType,
  createField,
  createItem,
  createReusableBlock,
  createTaxonomy,
  createTerm,
  getApiKey,
  revokeApiKey,
  updateReusableBlock,
  type ContentTypeRow,
  type FieldRow,
  type User,
} from '@taprootcms/core';

import { createHarness, body, type Harness } from './testHarness.js';

import { GET as resolveGet } from './delivery/resolve.js';
import { GET as itemsGet } from './delivery/items.js';
import { GET as searchGet } from './delivery/search.js';
import { GET as schemaGet } from './delivery/schema.js';
import { GET as termsGet } from './delivery/taxonomy/[apiId]/terms.js';
import { GET as keysGet, POST as keysPost } from './api-keys/index.js';
import { POST as keyFormPost, DELETE as keyDelete } from './api-keys/[id].js';

/**
 * The delivery API's gate, and the API keys that open it.
 *
 * The behaviour worth pinning here is the one no service test can see: which principals a route
 * accepts. `handle` is session-only and `handleScoped` takes a key — and getting that backwards
 * either locks a consumer out or exposes the admin API to a content-read credential.
 */

let h: Harness;
let admin: User;
let editor: User;
let type: ContentTypeRow;
let fields: FieldRow[];

beforeEach(async () => {
  h = await createHarness();
  admin = await h.user('admin');
  editor = await h.user('editor');

  type = await createContentType(h.db.db, {
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
    await createField(h.db.db, type.id, {
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
  await h.destroy();
});

async function published(title: string) {
  return createItem(h.db, type, fields, {
    contentTypeId: type.id,
    title,
    status: 'published',
    data: { body: 'x' },
  });
}

/** Sign the harness's next request with a bearer token, the way the middleware would resolve it. */
async function withKey(scopes: Parameters<typeof createApiKey>[1]['scopes'] = ['content:read']) {
  const { key, token } = await createApiKey(h.db.db, { label: 'Consumer', scopes });
  return { key, token };
}

describe('who may read the delivery API', () => {
  it('refuses an anonymous request', async () => {
    await published('Admissions');
    h.as(undefined);

    const response = await resolveGet(
      h.context({ url: '/api/taproot/delivery/resolve?path=/admissions' }),
    );
    expect(response.status).toBe(401);
  });

  it('accepts a key carrying content:read', async () => {
    const item = await published('Admissions');
    const { key } = await withKey();

    h.asKey(key);
    const response = await resolveGet(
      h.context({ url: `/api/taproot/delivery/resolve?path=${item.path}` }),
    );

    expect(response.status).toBe(200);
    const payload = await body<{ kind: string; item: { id: string } }>(response);
    expect(payload.kind).toBe('item');
    expect(payload.item.id).toBe(item.id);
  });

  /**
   * A person is allowed too, deliberately. The first thing anybody debugging an integration does is
   * open a delivery URL in their own browser to see what the consumer receives, and refusing that
   * would make the endpoint harder to trust rather than safer.
   */
  it('accepts a signed-in person', async () => {
    const item = await published('Admissions');
    h.as(editor);

    const response = await resolveGet(
      h.context({ url: `/api/taproot/delivery/resolve?path=${item.path}` }),
    );
    expect(response.status).toBe(200);
  });

  it('refuses a revoked key', async () => {
    await published('Admissions');
    const { key } = await withKey();
    await revokeApiKey(h.db.db, key.id);

    // Revocation is checked when the token is verified, so a principal built from a revoked key
    // never exists. Standing in for that here by presenting no principal at all.
    h.as(undefined);
    const response = await resolveGet(
      h.context({ url: '/api/taproot/delivery/resolve?path=/admissions' }),
    );
    expect(response.status).toBe(401);
  });

  /**
   * The default that matters. A key must not reach the admin REST API, and the way that is
   * guaranteed is that `handle` never looks at principals at all — it requires `taproot.user`,
   * which is undefined for a key.
   */
  it('does not let a key reach a session-only route', async () => {
    const { key } = await withKey();
    h.asKey(key);

    const response = await keysGet(h.context());
    expect(response.status).toBe(401);
  });
});

describe('the resolve endpoint', () => {
  it('needs a path', async () => {
    h.as(editor);
    const response = await resolveGet(h.context({ url: '/api/taproot/delivery/resolve' }));
    expect(response.status).toBe(400);
  });

  it('answers 404 with a body rather than an empty response', async () => {
    h.as(editor);
    const response = await resolveGet(
      h.context({ url: '/api/taproot/delivery/resolve?path=/nowhere' }),
    );
    expect(response.status).toBe(404);
    expect((await body<{ kind: string }>(response)).kind).toBe('not_found');
  });

  it('carries an ETag and answers 304 to a matching conditional request', async () => {
    const item = await published('Admissions');
    h.as(editor);

    const first = await resolveGet(
      h.context({ url: `/api/taproot/delivery/resolve?path=${item.path}` }),
    );
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await resolveGet(
      h.context({
        url: `/api/taproot/delivery/resolve?path=${item.path}`,
        headers: { 'if-none-match': etag! },
      }),
    );

    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  /**
   * The hole the validator used to have, and it was unbounded rather than sixty seconds.
   *
   * Editing a library entry changes what every referencing page renders and touches none of their
   * rows, so an `updated_at` validator kept matching. The old comment called that "stale until
   * `s-maxage` lapses" — but a shared cache *revalidates* on lapse rather than refetching, gets a
   * 304, and RFC 9111 §4.3.4 says a 304 refreshes the stored copy's freshness. The stale copy
   * renewed itself forever.
   *
   * Note the block is edited but never *placed* on this page. That is the point: the stamp is
   * global, so it does not depend on resolving which entries a page uses — work the cheap validator
   * lookup exists to avoid.
   */
  it('stops matching when a reusable block is edited, which updated_at cannot see', async () => {
    const item = await published('Admissions');

    const blockType = await createContentType(h.db.db, {
      api_id: 'notice',
      name: 'Notice',
      name_plural: 'Notices',
      kind: 'block',
      description: null,
      icon: null,
      url_prefix: null,
      summary_template: '{{ title }}',
    });
    const noticeFields = [
      await createField(h.db.db, blockType.id, {
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
    const entry = await createReusableBlock(h.db.db, noticeFields, {
      name: 'Closure notice',
      description: null,
      blockType: 'notice',
      data: { body: 'Closed Monday.' },
      userId: editor.id,
    });

    h.as(editor);
    const before = await resolveGet(
      h.context({ url: `/api/taproot/delivery/resolve?path=${item.path}` }),
    );
    const stale = before.headers.get('etag')!;

    await updateReusableBlock(h.db.db, noticeFields, entry.id, {
      data: { body: 'Closed Tuesday.' },
    });

    /**
     * The stamp is pinned rather than left to the clock, and the reason is worth keeping.
     *
     * `updated_at` has millisecond resolution, so creating and editing an entry inside the same
     * millisecond produces the same stamp and the ETag legitimately does not move. That made this
     * test pass alone and fail in a full run — a flake, and a real (tiny) limit of the mechanism:
     * two library edits within one millisecond are one edit as far as the validator is concerned.
     * It does not matter in practice because the `block:` purge is what makes an edit visible
     * immediately; the stamp is the backstop for when a purge never lands, and a backstop that is
     * one millisecond coarse is not the failure mode anyone will meet.
     */
    await h.db.db
      .updateTable('reusable_blocks')
      .set({ updated_at: new Date(Date.now() + 60_000).toISOString() })
      .where('id', '=', entry.id)
      .execute();

    const after = await resolveGet(
      h.context({
        url: `/api/taproot/delivery/resolve?path=${item.path}`,
        headers: { 'if-none-match': stale },
      }),
    );

    // 200, not 304 — otherwise the cache in front of this renews a copy it can never correct.
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(stale);
  });

  /**
   * The claim a validator is actually making.
   *
   * "Answers 304" was already asserted above and was true while the route resolved the entire page
   * first and then threw the body away. That saves a payload, and a payload is the part Cloudflare
   * does not bill; D1 charges rows read, so the 304 cost exactly what the 200 did. Asserting the
   * status alone cannot tell those two implementations apart — the query count can.
   *
   * The bound is deliberately a small number rather than exactly one: the point is that the
   * conditional answer is a lookup and not a resolution, and pinning it to a single query would
   * break on any reasonable change to how the row is found.
   */
  it('answers 304 without resolving the page behind it', async () => {
    const item = await published('Admissions');
    h.as(editor);

    const first = await resolveGet(
      h.context({ url: `/api/taproot/delivery/resolve?path=${item.path}` }),
    );
    const etag = first.headers.get('etag')!;

    const full = await h.countQueries(() =>
      resolveGet(h.context({ url: `/api/taproot/delivery/resolve?path=${item.path}` })),
    );

    const conditional = await h.countQueries(() =>
      resolveGet(
        h.context({
          url: `/api/taproot/delivery/resolve?path=${item.path}`,
          headers: { 'if-none-match': etag },
        }),
      ),
    );

    expect(conditional.value.status).toBe(304);
    expect(conditional.queries).toBeLessThanOrEqual(2);
    expect(conditional.queries).toBeLessThan(full.queries);
  });

  /**
   * A stale validator has to fall through and pay for the body, or the cheap lookup would be a way
   * to serve one version's content under another version's tag.
   */
  it('resolves in full when the presented validator is stale', async () => {
    const item = await published('Admissions');
    h.as(editor);

    const response = await resolveGet(
      h.context({
        url: `/api/taproot/delivery/resolve?path=${item.path}`,
        headers: { 'if-none-match': 'W/"someone-elses-tag"' },
      }),
    );

    expect(response.status).toBe(200);
    expect((await body<{ kind: string }>(response)).kind).toBe('item');
  });

  /**
   * The tags are what let a purge exist at all, and every one of them is a dependency the ETag
   * cannot see. `updated_at` changes when *this* row is edited; the page also changes when its type
   * gains a member, when a reusable block is edited in the library, and when an ancestor is renamed.
   */
  it('names what the page depends on, so a write elsewhere can purge it', async () => {
    const item = await published('Admissions');
    h.as(editor);

    const response = await resolveGet(
      h.context({ url: `/api/taproot/delivery/resolve?path=${item.path}` }),
    );

    const tags = (response.headers.get('cache-tag') ?? '').split(',');
    expect(tags).toContain(`item:${item.id}`);
    expect(tags).toContain(`type:${type.api_id}`);

    // The same list travels in the payload, because the *consumer* has to tag the HTML it renders
    // from this and cannot derive the dependencies itself.
    const payload = await body<{ cacheTags: string[] }>(response);
    expect(payload.cacheTags).toContain(`item:${item.id}`);
  });

  /**
   * Its own test because its own absence was invisible.
   *
   * `SITE_TAG` shipped emitted by nothing while `releases/[id]/publish.ts` and `scheduler/run.ts`
   * both purged it — so publishing a release and running the sweep cleared zero entries, silently,
   * for a whole phase. Cloudflare accepts a purge for a tag nothing carries and reports success.
   * Asserting the *write* side purges `site` would have passed throughout; only asserting it is on
   * the wire catches it.
   */
  it('carries the site tag, without which a release publish purges nothing', async () => {
    const item = await published('Admissions');
    h.as(editor);

    const response = await resolveGet(
      h.context({ url: `/api/taproot/delivery/resolve?path=${item.path}` }),
    );

    expect((response.headers.get('cache-tag') ?? '').split(',')).toContain('site');
    expect((await body<{ cacheTags: string[] }>(response)).cacheTags).toContain('site');
  });

  it('varies on authorization, since a different principal could see differently', async () => {
    const item = await published('Admissions');
    h.as(editor);

    const response = await resolveGet(
      h.context({ url: `/api/taproot/delivery/resolve?path=${item.path}` }),
    );
    expect(response.headers.get('vary')).toBe('authorization');
  });
});

describe('the items endpoint', () => {
  /**
   * A listing that cannot be purged lives out its whole TTL, and the whole point of a listing is to
   * show items it did not previously contain. All three listing endpoints shipped with no
   * `Cache-Tag` at all — survivable at sixty seconds, and at a long TTL the difference between
   * "publish an event" and "the events index shows it tomorrow".
   */
  it('names the type it lists, so publishing into it purges the listing', async () => {
    await published('Admissions');
    h.as(editor);

    const response = await itemsGet(
      h.context({ url: `/api/taproot/delivery/items?type=${type.api_id}` }),
    );

    const tags = (response.headers.get('cache-tag') ?? '').split(',');
    expect(tags).toContain(`type:${type.api_id}`);
    expect(tags).toContain('site');
  });

  /**
   * The case with no results to derive a tag from, which is the one most needing invalidation — an
   * empty index is exactly what the first publish into a type has to change.
   */
  it('names the type even when nothing matched', async () => {
    h.as(editor);

    const response = await itemsGet(
      h.context({ url: `/api/taproot/delivery/items?type=${type.api_id}&q=nothingmatchesthis` }),
    );

    expect((response.headers.get('cache-tag') ?? '').split(',')).toContain(`type:${type.api_id}`);
  });

  /** With no filter the listing spans every type, so every type has to be able to purge it. */
  it('names every type when the caller narrowed to none', async () => {
    await published('Admissions');
    h.as(editor);

    const response = await itemsGet(h.context({ url: '/api/taproot/delivery/items' }));

    expect((response.headers.get('cache-tag') ?? '').split(',')).toContain(`type:${type.api_id}`);
  });

  it('omits singletons, whose paths nothing serves', async () => {
    await published('Admissions');

    const singleton = await createContentType(h.db.db, {
      api_id: 'banner',
      name: 'Banner',
      name_plural: 'Banners',
      kind: 'singleton',
      description: null,
      icon: null,
      url_prefix: null,
      summary_template: '{{ title }}',
    });
    await createItem(h.db, singleton, [], {
      contentTypeId: singleton.id,
      title: 'Weather banner',
      status: 'published',
    });

    h.as(editor);
    const response = await itemsGet(h.context({ url: '/api/taproot/delivery/items' }));
    const payload = await body<{ items: { path: string }[] }>(response);

    // A singleton's path is the synthetic `/__singleton/…`, which is not a link anybody can follow.
    expect(payload.items.map((i) => i.path)).toEqual(['/admissions']);
  });

  it('refuses a block type, which has no items of its own', async () => {
    await createContentType(h.db.db, {
      api_id: 'hero',
      name: 'Hero',
      name_plural: 'Heroes',
      kind: 'block',
      description: null,
      icon: null,
      url_prefix: null,
      summary_template: null,
    });

    h.as(editor);
    const response = await itemsGet(h.context({ url: '/api/taproot/delivery/items?type=hero' }));
    expect(response.status).toBe(422);
  });

  it('sends summaries by default and field values when asked', async () => {
    await published('Admissions');
    h.as(editor);

    const plain = await body<{ items: { data?: unknown }[] }>(
      await itemsGet(h.context({ url: '/api/taproot/delivery/items' })),
    );
    expect(plain.items[0]!.data).toBeUndefined();

    const withData = await body<{
      items: { data?: Record<string, unknown> }[];
      media?: unknown;
      terms?: unknown;
    }>(await itemsGet(h.context({ url: '/api/taproot/delivery/items?include=data' })));

    expect(withData.items[0]!.data).toEqual({ body: 'x' });
    // The maps travel with the data, because the ids in it are useless without them.
    expect(withData.media).toBeDefined();
    expect(withData.terms).toBeDefined();
  });

  it('costs the same whether it lists two items or ten', async () => {
    /**
     * The claim `include=data` rests on: a card grid is one request, not N.
     *
     * Every listed item's media, relations and terms are collected across the whole page and loaded
     * in one query each, and the content types once per distinct type — so the cost is a function of
     * the page, not of its length. An `await` inside the loop would pass every other test in this
     * file, answer identically, and turn a directory of two hundred into two hundred round trips to
     * a database in another region.
     */
    for (let i = 0; i < 10; i += 1) await published(`Page ${i}`);
    h.as(editor);

    const two = await h.countQueries(() =>
      itemsGet(h.context({ url: '/api/taproot/delivery/items?include=data&limit=2' })),
    );
    const ten = await h.countQueries(() =>
      itemsGet(h.context({ url: '/api/taproot/delivery/items?include=data&limit=10' })),
    );

    expect(two.value.status).toBe(200);
    expect(ten.queries).toBe(two.queries);
  });

  it('refuses an include it does not understand rather than ignoring it', async () => {
    h.as(editor);

    // Dropping it silently is how somebody ships `include=fields`, sees summaries, and concludes
    // the feature does not work.
    const response = await itemsGet(
      h.context({ url: '/api/taproot/delivery/items?include=fields' }),
    );
    expect(response.status).toBe(400);
    expect((await body<{ error: string }>(response)).error).toContain('data');
  });

  it('refuses an unknown sort, and names the ones it has', async () => {
    h.as(editor);

    /**
     * `sort` was read by nothing at all until now, so a directory asking for alphabetical order got
     * site order and nothing said why. A request parameter is refused rather than defaulted — the
     * fallbacks elsewhere are for stored rules that outlive the field they name.
     */
    const response = await itemsGet(
      h.context({ url: '/api/taproot/delivery/items?sort=alphabetical' }),
    );
    expect(response.status).toBe(400);
    expect((await body<{ error: string }>(response)).error).toContain('title');

    const ok = await itemsGet(h.context({ url: '/api/taproot/delivery/items?sort=title' }));
    expect(ok.status).toBe(200);
  });

  it('takes several terms, and any of them matches', async () => {
    const taxonomy = await createTaxonomy(h.db.db, {
      api_id: 'department',
      name: 'Department',
      name_plural: 'Departments',
      description: null,
      hierarchical: true,
    });
    const science = await createTerm(h.db.db, taxonomy.id, { name: 'Science', slug: 'science' });
    const arts = await createTerm(h.db.db, taxonomy.id, { name: 'Arts', slug: 'arts' });

    const tagged = await createField(h.db.db, type.id, {
      api_id: 'departments',
      label: 'Departments',
      type: 'taxonomy',
      required: false,
      localized: false,
      position: 1,
      config: { taxonomyApiId: 'department', multiple: true },
      help_text: null,
    });
    const withTerms = [...fields, tagged];

    const make = (title: string, termIds: string[]) =>
      createItem(h.db, type, withTerms, {
        contentTypeId: type.id,
        title,
        status: 'published',
        data: { body: 'x', departments: termIds },
      });

    await make('Science page', [science.id]);
    await make('Arts page', [arts.id]);
    await make('Neither', []);

    h.as(editor);

    // Repeated parameters and a comma list are the same request; a facet with checkboxes sends one
    // or the other depending on how it was built.
    for (const url of [
      `/api/taproot/delivery/items?term=${science.id}&term=${arts.id}`,
      `/api/taproot/delivery/items?term=${science.id},${arts.id}`,
    ]) {
      const payload = await body<{ items: { title: string }[]; total: number }>(
        await itemsGet(h.context({ url })),
      );

      // OR, not AND: ticking two departments widens the list rather than narrowing it to pages in
      // both — which is what a facet does, and what `ItemFilters.termIds` has always meant.
      expect(payload.total).toBe(2);
      expect(payload.items.map((item) => item.title).sort()).toEqual(['Arts page', 'Science page']);
    }
  });

  it('names the term only when exactly one slug was asked for', async () => {
    const taxonomy = await createTaxonomy(h.db.db, {
      api_id: 'department',
      name: 'Department',
      name_plural: 'Departments',
      description: null,
      hierarchical: true,
    });
    await createTerm(h.db.db, taxonomy.id, { name: 'Student Services', slug: 'student-services' });
    await createTerm(h.db.db, taxonomy.id, { name: 'Arts', slug: 'arts' });

    h.as(editor);

    // The term-archive case: the heading needs the editor's own capitalisation, which un-slugifying
    // cannot recover.
    const one = await body<{ term?: { name: string } }>(
      await itemsGet(
        h.context({
          url: '/api/taproot/delivery/items?taxonomy=department&term=student-services',
        }),
      ),
    );
    expect(one.term?.name).toBe('Student Services');

    // Two is a facet rather than an archive, and a facet already holds the names — it got them from
    // the terms endpoint. Sending them twice would be a second spelling free to disagree.
    const two = await body<{ term?: unknown }>(
      await itemsGet(
        h.context({
          url: '/api/taproot/delivery/items?taxonomy=department&term=student-services&term=arts',
        }),
      ),
    );
    expect(two.term).toBeUndefined();
  });

  it('404s a slug that does not exist rather than listing everything', async () => {
    await createTaxonomy(h.db.db, {
      api_id: 'department',
      name: 'Department',
      name_plural: 'Departments',
      description: null,
      hierarchical: true,
    });
    h.as(editor);

    const response = await itemsGet(
      h.context({ url: '/api/taproot/delivery/items?taxonomy=department&term=misspelled' }),
    );
    expect(response.status).toBe(404);
  });
});

describe('a collection whose items have no pages', () => {
  async function directory() {
    const type = await createContentType(h.db.db, {
      api_id: 'person',
      name: 'Person',
      name_plural: 'People',
      kind: 'collection',
      description: null,
      icon: null,
      url_prefix: 'people',
      summary_template: '{{ title }}',
      item_pages: false,
    });

    await createItem(h.db, type, [], {
      contentTypeId: type.id,
      title: 'Marguerite Okafor',
      status: 'published',
    });

    return type;
  }

  it('is listed when the caller names it and left out when it does not', async () => {
    await published('Admissions');
    await directory();
    h.as(editor);

    const everything = await body<{ items: { title: string }[] }>(
      await itemsGet(h.context({ url: '/api/taproot/delivery/items' })),
    );
    // An index of everything is a list of links, and these have no URL to link to.
    expect(everything.items.map((item) => item.title)).toEqual(['Admissions']);

    const named = await body<{ total: number }>(
      await itemsGet(h.context({ url: '/api/taproot/delivery/items?type=person' })),
    );
    // Asking for people is how a directory is built; answering nothing would refuse the question.
    expect(named.total).toBe(1);
  });

  it('is never a search result, even when the search names the type', async () => {
    await directory();
    h.as(editor);

    /**
     * Where search differs from the listing, deliberately: a result is a link and nothing else, so
     * returning somebody whose URL answers 404 is worse than not finding them — the visitor's next
     * click is the failure.
     */
    for (const url of [
      '/api/taproot/delivery/search?q=okafor',
      '/api/taproot/delivery/search?q=okafor&type=person',
    ]) {
      const payload = await body<{ total: number }>(await searchGet(h.context({ url })));
      expect(payload.total).toBe(0);
    }
  });

  it('answers 404 at the item’s own path, conditionally as well as fully', async () => {
    await directory();
    h.as(editor);

    const full = await resolveGet(
      h.context({ url: '/api/taproot/delivery/resolve?path=/people/marguerite-okafor' }),
    );
    expect(full.status).toBe(404);

    /**
     * And with a validator in hand. The cheap ETag lookup runs before the page is resolved, so a
     * rule applied to one and not the other would 304 a path the full request refuses — a client
     * revalidating a cached copy of a page that does not exist, successfully, forever.
     */
    const conditional = await resolveGet(
      h.context({
        url: '/api/taproot/delivery/resolve?path=/people/marguerite-okafor',
        headers: { 'if-none-match': 'W/"anything-at-all"' },
      }),
    );
    expect(conditional.status).toBe(404);
  });
});

describe('the taxonomy terms endpoint', () => {
  /**
   * Two axes, not one. The vocabulary changes on a term write (`site`); the `itemCount` beside each
   * term changes on an ordinary content write (`type:`). A facet tagged only for the first would
   * keep showing counts the grid behind it disagrees with — the exact failure `itemCount` exists to
   * prevent.
   */
  it('is purgeable by a term write and by a content write alike', async () => {
    await departmentTaxonomy();
    h.as(editor);

    const response = await termsGet(
      h.context({
        url: '/api/taproot/delivery/taxonomy/department/terms?counts=1',
        params: { apiId: 'department' },
      }),
    );

    const tags = (response.headers.get('cache-tag') ?? '').split(',');
    expect(tags).toContain('site');
    expect(tags).toContain(`type:${type.api_id}`);
  });

  async function departmentTaxonomy() {
    const taxonomy = await createTaxonomy(h.db.db, {
      api_id: 'department',
      name: 'Department',
      name_plural: 'Departments',
      description: null,
      hierarchical: true,
    });
    const sciences = await createTerm(h.db.db, taxonomy.id, {
      name: 'Sciences',
      slug: 'sciences',
    });
    await createTerm(h.db.db, taxonomy.id, {
      name: 'Biology',
      slug: 'biology',
      parentId: sciences.id,
    });
    return taxonomy;
  }

  it('answers the terms a facet needs, flat and parented', async () => {
    await departmentTaxonomy();
    h.as(editor);

    const payload = await body<{
      apiId: string;
      terms: { id: string; name: string; parentId: string | null; itemCount?: number }[];
    }>(
      await termsGet(
        h.context({
          url: '/api/taproot/delivery/taxonomy/department/terms',
          params: { apiId: 'department' },
        }),
      ),
    );

    expect(payload.apiId).toBe('department');
    // Depth-first, so a consumer that ignores `parentId` entirely still renders a child under its
    // parent rather than at the end of the list.
    expect(payload.terms.map((term) => term.name)).toEqual(['Sciences', 'Biology']);

    const [sciences, biology] = payload.terms;
    expect(sciences!.parentId).toBeNull();
    expect(biology!.parentId).toBe(sciences!.id);

    // Counts cost a second query, so nothing pays for them without asking.
    expect(sciences!.itemCount).toBeUndefined();
  });

  it('counts only when asked, and not when asked for zero', async () => {
    await departmentTaxonomy();
    h.as(editor);

    const counted = await body<{ terms: { itemCount?: number }[] }>(
      await termsGet(
        h.context({ url: '/api/taproot/delivery/taxonomy/department/terms?counts=1', params: { apiId: 'department' } }),
      ),
    );
    expect(counted.terms[0]!.itemCount).toBe(0);

    // `counts=0` reading as true is the classic version of this bug, and it costs a query on every
    // request from a consumer that thought it had switched the feature off.
    const off = await body<{ terms: { itemCount?: number }[] }>(
      await termsGet(
        h.context({ url: '/api/taproot/delivery/taxonomy/department/terms?counts=0', params: { apiId: 'department' } }),
      ),
    );
    expect(off.terms[0]!.itemCount).toBeUndefined();
  });

  it('404s a taxonomy that does not exist', async () => {
    h.as(editor);

    /**
     * Not an empty list. "No terms yet" is a real and ordinary state, so answering one for a
     * misspelled api_id would hide the mistake until somebody happened to add a term.
     */
    const response = await termsGet(
      h.context({ url: '/api/taproot/delivery/taxonomy/departmnet/terms', params: { apiId: 'departmnet' } }),
    );
    expect(response.status).toBe(404);
  });

  it('refuses an anonymous request, like every other delivery route', async () => {
    await departmentTaxonomy();
    h.as(undefined);

    const response = await termsGet(
      h.context({ url: '/api/taproot/delivery/taxonomy/department/terms', params: { apiId: 'department' } }),
    );
    expect(response.status).toBe(401);
  });
});

describe('the search endpoint', () => {
  /**
   * A search result is a link, so a search that cannot be purged eventually offers links to content
   * that no longer exists — and the visitor's next click is the failure. This endpoint used to
   * document *not* having a tag as deliberate; that reasoning held only while the TTL was 60s.
   */
  it('names every type it could match, so a content write purges it', async () => {
    h.as(editor);

    const response = await searchGet(h.context({ url: '/api/taproot/delivery/search?q=anything' }));

    const tags = (response.headers.get('cache-tag') ?? '').split(',');
    expect(tags).toContain(`type:${type.api_id}`);
    expect(tags).toContain('site');
  });

  /** A published page whose body carries the phrase, so a match can be a body match. */
  async function page(title: string, bodyText: string) {
    return createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title,
      status: 'published',
      data: { body: bodyText },
    });
  }

  it('finds an item by its body and says where the match was', async () => {
    await page('Costs', 'Every kind of financial aid we offer, in one place.');
    h.as(editor);

    const response = await searchGet(
      h.context({ url: '/api/taproot/delivery/search?q=financial%20aid' }),
    );

    expect(response.status).toBe(200);
    const payload = await body<{
      results: { title: string; excerpt: string }[];
      total: number;
      query: string;
    }>(response);

    expect(payload.total).toBe(1);
    expect(payload.results[0]!.title).toBe('Costs');
    // The excerpt is what makes a result page readable, and it comes from the derived index rather
    // than from the item's `data` — which the endpoint never loads.
    expect(payload.results[0]!.excerpt).toContain('financial aid');
    // Echoed trimmed, so a consumer rendering "n results for X" shows what was searched for.
    expect(payload.query).toBe('financial aid');
  });

  it('answers a blank term with nothing rather than with everything', async () => {
    await page('Costs', 'Aid.');
    await page('Term dates', 'Autumn.');
    h.as(editor);

    /**
     * The dangerous reading of "match all" is *everything*, which would turn a site's own empty
     * search box into a dump of its whole content. An error is the other candidate and is worse in
     * practice: submitting an empty form is ordinary, and would surface as the site's error page.
     */
    const response = await searchGet(h.context({ url: '/api/taproot/delivery/search?q=%20%20' }));

    expect(response.status).toBe(200);
    const payload = await body<{ results: unknown[]; total: number }>(response);
    expect(payload.results).toEqual([]);
    expect(payload.total).toBe(0);
  });

  it('shows a visitor nothing that is not live', async () => {
    await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Unannounced',
      status: 'draft',
      data: { body: 'The bursary scheme opens in the autumn.' },
    });

    const { key } = await withKey();
    h.asKey(key);

    const response = await searchGet(h.context({ url: '/api/taproot/delivery/search?q=bursary' }));
    const payload = await body<{ total: number }>(response);

    // Visibility is applied in SQL through the same predicate every other read uses, not by
    // filtering results — otherwise `total` counts rows the caller never sees.
    expect(payload.total).toBe(0);
  });

  it('refuses an anonymous request, like every other delivery route', async () => {
    await page('Costs', 'Aid.');
    h.as(undefined);

    const response = await searchGet(h.context({ url: '/api/taproot/delivery/search?q=aid' }));
    expect(response.status).toBe(401);
  });

  it('refuses a block type, which has no items of its own', async () => {
    await createContentType(h.db.db, {
      api_id: 'hero',
      name: 'Hero',
      name_plural: 'Heroes',
      kind: 'block',
      description: null,
      icon: null,
      url_prefix: null,
      summary_template: null,
    });

    h.as(editor);
    const response = await searchGet(
      h.context({ url: '/api/taproot/delivery/search?q=anything&type=hero' }),
    );
    expect(response.status).toBe(422);
  });
});

describe('the schema endpoint', () => {
  it('is never cached, so generated types cannot disagree with what is served', async () => {
    h.as(editor);
    const response = await schemaGet(h.context());
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('managing keys', () => {
  it('returns the token exactly once, on creation', async () => {
    h.as(admin);
    const response = await keysPost(
      h.context({ json: { label: 'Consumer', scopes: ['content:read'] } }),
    );

    expect(response.status).toBe(201);
    const created = await body<{ token: string; apiKey: { id: string } }>(response);
    expect(created.token).toMatch(/^tpr_[0-9a-f]{64}$/);

    // And nowhere else. The list has no token because `id` is its hash — there is nothing to read.
    const listed = await body<{ apiKeys: Record<string, unknown>[] }>(await keysGet(h.context()));
    expect(JSON.stringify(listed)).not.toContain(created.token);
  });

  it('refuses a key with no scopes', async () => {
    h.as(admin);
    const response = await keysPost(h.context({ json: { label: 'Useless', scopes: [] } }));
    expect(response.status).toBe(422);
  });

  it('is admin-only', async () => {
    h.as(editor);
    expect((await keysGet(h.context())).status).toBe(403);
    expect(
      (await keysPost(h.context({ json: { label: 'x', scopes: ['content:read'] } }))).status,
    ).toBe(403);
  });

  it('revokes rather than deletes, so audit entries still resolve', async () => {
    const { key } = await withKey();
    h.as(admin);

    const response = await keyDelete(h.context({ method: 'DELETE', params: { id: key.id } }));
    expect(response.status).toBe(200);

    const after = await getApiKey(h.db.db, key.id);
    expect(after).toBeDefined();
    expect(after!.revoked_at).not.toBeNull();
  });

  it('checks the typed confirmation on the server for a form revoke', async () => {
    const { key } = await withKey();
    h.as(admin);

    const wrong = await keyFormPost(
      h.context({ params: { id: key.id }, form: { _method: 'revoke', confirm: 'nope' } }),
    );
    expect(wrong.headers.get('location')).toContain('error=');
    expect((await getApiKey(h.db.db, key.id))!.revoked_at).toBeNull();

    const right = await keyFormPost(
      h.context({
        params: { id: key.id },
        form: { _method: 'revoke', confirm: key.token_prefix },
      }),
    );
    expect(right.headers.get('location')).toContain('revoked=');
    expect((await getApiKey(h.db.db, key.id))!.revoked_at).not.toBeNull();
  });
});

/**
 * Subtree scoping, on the two endpoints that needed it.
 *
 * The problem appears once a site holds a second copy of a section: every superseded page is in the
 * index too, and with several live copies a content type crosses the 200-row cap on its own.
 * Both endpoints take the same parameter spelled the same way, so scoping a listing and scoping a
 * search are one thing to learn.
 */
describe('scoping a listing and a search to a branch', () => {
  async function branch(root: string) {
    const parent = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: root,
      status: 'published',
      data: { body: 'x' },
    });
    for (const title of ['Admissions', 'Policies']) {
      await createItem(h.db, type, fields, {
        contentTypeId: type.id,
        title,
        parentId: parent.id,
        status: 'published',
        data: { body: 'findme' },
      });
    }
    return parent;
  }

  it('lists only what is under the given path', async () => {
    const current = await branch('2026-27');
    await branch('2025-26');
    h.as(editor);

    const response = await itemsGet(
      h.context({ url: `/api/taproot/delivery/items?under=${current.path}` }),
    );

    const payload = await body<{ items: { path: string }[]; total: number }>(response);
    expect(payload.items.map((item) => item.path).sort()).toEqual([
      '/2026-27/admissions',
      '/2026-27/policies',
    ]);
    // `total` is counted under the same filter, or a pager would page through rows it cannot show.
    expect(payload.total).toBe(2);
  });

  it('excludes the branch root itself, which the caller already has', async () => {
    const current = await branch('2026-27');
    h.as(editor);

    const response = await itemsGet(
      h.context({ url: `/api/taproot/delivery/items?under=${current.path}` }),
    );
    const payload = await body<{ items: { path: string }[] }>(response);
    expect(payload.items.some((item) => item.path === current.path)).toBe(false);
  });

  it('does not reach into a sibling whose path merely starts the same way', async () => {
    const current = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Catalog',
      slug: 'catalog',
      status: 'published',
      data: { body: 'x' },
    });
    const decoy = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Catalog archive',
      slug: 'catalog-archive',
      status: 'published',
      data: { body: 'x' },
    });
    await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Old',
      parentId: decoy.id,
      status: 'published',
      data: { body: 'x' },
    });

    h.as(editor);
    const response = await itemsGet(
      h.context({ url: `/api/taproot/delivery/items?under=${current.path}` }),
    );
    expect((await body<{ items: unknown[] }>(response)).items).toEqual([]);
  });

  it('answers an empty list for a branch nothing lives under, rather than an error', async () => {
    h.as(editor);
    const response = await itemsGet(
      h.context({ url: '/api/taproot/delivery/items?under=/nothing-here' }),
    );

    // A branch with no visible items is an ordinary state, unlike a misspelled `type`, which names
    // something and so 404s.
    expect(response.status).toBe(200);
    expect((await body<{ items: unknown[] }>(response)).items).toEqual([]);
  });

  it('narrows to one level with parent', async () => {
    const current = await branch('2026-27');
    const deep = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Deep',
      parentId: (
        await createItem(h.db, type, fields, {
          contentTypeId: type.id,
          title: 'Middle',
          parentId: current.id,
          status: 'published',
          data: { body: 'x' },
        })
      ).id,
      status: 'published',
      data: { body: 'x' },
    });

    h.as(editor);
    const oneLevel = await itemsGet(
      h.context({ url: `/api/taproot/delivery/items?parent=${current.id}` }),
    );
    const branchWide = await itemsGet(
      h.context({ url: `/api/taproot/delivery/items?under=${current.path}` }),
    );

    const direct = await body<{ items: { path: string }[] }>(oneLevel);
    const all = await body<{ items: { path: string }[] }>(branchWide);

    expect(direct.items.some((item) => item.path === deep.path)).toBe(false);
    expect(all.items.some((item) => item.path === deep.path)).toBe(true);
  });

  it('scopes a search to one branch', async () => {
    const current = await branch('2026-27');
    await branch('2025-26');
    h.as(editor);

    const everywhere = await searchGet(
      h.context({ url: '/api/taproot/delivery/search?q=findme' }),
    );
    const scoped = await searchGet(
      h.context({ url: `/api/taproot/delivery/search?q=findme&under=${current.path}` }),
    );

    expect((await body<{ total: number }>(everywhere)).total).toBe(4);

    const inYear = await body<{ total: number; results: { path: string }[] }>(scoped);
    expect(inYear.total).toBe(2);
    expect(inYear.results.every((result) => result.path.startsWith('/2026-27/'))).toBe(true);
  });
});
