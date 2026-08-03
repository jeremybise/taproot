import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PREVIEW_PARAM,
  createContentType,
  createField,
  createItem,
  resolvePreviewToken,
  type ContentTypeRow,
  type FieldRow,
  type User,
} from '@taprootcms/core';

import { createHarness, body, type Harness } from './testHarness.js';

import { GET as previewGet, POST as previewPost, PUT as previewPut } from './preview.js';
import { GET as resolveGet } from './delivery/resolve.js';

/**
 * The preview endpoints, and the one property in the delivery route that makes a split view safe.
 *
 * The token has always been a capability over one item. What is new is that the pane can point its
 * frame anywhere on the site, so "one item" stopped being enforced by the fact that the only caller
 * was a redirect straight to `item.path`. The last describe block is that regression.
 */

let h: Harness;
let contributor: User;
let type: ContentTypeRow;
let fields: FieldRow[];
const SITE = 'http://localhost:4323';

beforeEach(async () => {
  h = await createHarness();
  contributor = await h.user('contributor');
  process.env.TAPROOT_SITE_URL = SITE;

  type = await createContentType(h.db.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    title_field: 'title',
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
  delete process.env.TAPROOT_SITE_URL;
});

async function draft(title = 'Notice') {
  return createItem(h.db, type, fields, {
    contentTypeId: type.id,
    title,
    status: 'draft',
    data: { body: 'unpublished' },
  });
}

const snapshot = { title: 'Notice', slug: 'notice', data: { body: 'typing' }, seo: {} };

describe('minting for the split-view pane', () => {
  it('refuses an anonymous request and a viewer, and answers a contributor', async () => {
    const item = await draft();

    h.as(undefined);
    expect((await previewPost(h.context({ method: 'POST', json: { item: item.id } }))).status).
      toBe(401);

    h.as(await h.user('viewer'));
    expect((await previewPost(h.context({ method: 'POST', json: { item: item.id } }))).status).
      toBe(403);

    h.as(contributor);
    expect((await previewPost(h.context({ method: 'POST', json: { item: item.id } }))).status).
      toBe(200);
  });

  it('returns a working token, never cached', async () => {
    const item = await draft();
    h.as(contributor);

    const response = await previewPost(h.context({ method: 'POST', json: { item: item.id } }));
    const payload = await body<{ token: string; siteUrl: string; itemPath: string }>(response);

    // The URL carries a credential, so a cached response would hand the same one to whoever asked
    // next and it would keep working until the token expired.
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(payload.siteUrl).toBe(SITE);
    expect(payload.itemPath).toBe(item.path);
    expect(await resolvePreviewToken(h.db.db, payload.token)).toBeDefined();
  });

  it('can carry the first draft in the same request', async () => {
    // So the pane's first frame shows unsaved state, rather than the saved page followed a beat
    // later by a reload.
    const item = await draft();
    h.as(contributor);

    const response = await previewPost(
      h.context({ method: 'POST', json: { item: item.id, draft: snapshot } }),
    );
    const { token } = await body<{ token: string }>(response);

    const preview = await resolvePreviewToken(h.db.db, token);
    expect(preview?.item.data).toEqual({ body: 'typing' });
  });

  /** A singleton with no preview path, which is the default and the settings-record case. */
  async function singletonItem(apiId: string, previewPath: string | null) {
    const type = await createContentType(h.db.db, {
      api_id: apiId,
      name: 'Banner',
      name_plural: 'Banners',
      kind: 'singleton',
      description: null,
      icon: null,
      url_prefix: null,
      preview_path: previewPath,
      title_field: 'title',
    });
    return createItem(h.db, type, [], {
      contentTypeId: type.id,
      title: 'Weather',
      status: 'published',
      data: {},
    });
  }

  it('refuses a singleton nobody has given a page', async () => {
    const item = await singletonItem('banner', null);
    h.as(contributor);

    /**
     * Not an over-cautious guard. The token is a capability over `/__singleton/banner`, and the
     * delivery route would answer for it perfectly — so without this the pane frames a URL nobody
     * will ever request and presents it as the site.
     *
     * This is also what keeps the feature honest now that a singleton *can* have a page: a settings
     * record holding an address and social links has none, and the default is off.
     */
    const response = await previewPost(h.context({ method: 'POST', json: { item: item.id } }));
    expect(response.status).toBe(400);
  });

  it('previews a singleton at the path its content type declares', async () => {
    // The homepage case: a singleton assembled from blocks that the site renders at `/`. The pane
    // has to frame that address, not the item's synthetic `/__singleton/homepage`, which 404s.
    const item = await singletonItem('homepage', '/');
    h.as(contributor);

    const response = await previewPost(h.context({ method: 'POST', json: { item: item.id } }));
    expect(response.status).toBe(200);

    const payload = await body<{ token: string; itemPath: string }>(response);
    expect(payload.itemPath).toBe('/');

    // The token still names the item, so the consumer's `resolve('/__singleton/homepage')` matches
    // it. Nothing about the delivery contract moved — only the address the admin opens.
    const preview = await resolvePreviewToken(h.db.db, payload.token);
    expect(preview?.item.id).toBe(item.id);
    expect(preview?.item.path).toBe('/__singleton/homepage');
  });

  it('says so when no site URL is configured', async () => {
    delete process.env.TAPROOT_SITE_URL;
    const item = await draft();
    h.as(contributor);

    const response = await previewPost(h.context({ method: 'POST', json: { item: item.id } }));
    expect(response.status).toBe(503);
    expect((await body<{ error: string }>(response)).error).toContain('TAPROOT_SITE_URL');
  });

  /**
   * The link form of the same thing, which the admin no longer calls.
   *
   * Its button was replaced by the preview pane, so nothing in the UI exercises this any more — and
   * an endpoint with no caller is one that breaks quietly. This is what keeps it honest.
   */
  it('still redirects on GET', async () => {
    const item = await draft();
    h.as(contributor);

    const response = await previewGet(
      h.context({ url: `/api/taproot/preview?item=${item.id}` }),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe(SITE);
    expect(location.pathname).toBe(item.path);
    expect(location.searchParams.get(PREVIEW_PARAM)).toBeTruthy();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('updating the snapshot', () => {
  async function mint(itemId: string) {
    h.as(contributor);
    const response = await previewPost(h.context({ method: 'POST', json: { item: itemId } }));
    return (await body<{ token: string }>(response)).token;
  }

  it('writes to the row the token names, and cannot be aimed elsewhere', async () => {
    const item = await draft();
    const other = await draft('Somewhere else');
    const token = await mint(item.id);

    await previewPut(
      h.context({
        method: 'PUT',
        // `contentItemId` is not part of the schema, and there is deliberately no way to express
        // it: the item is on the row, so no request can point a snapshot at a different page.
        json: { token, ...snapshot },
      }),
    );

    expect((await resolvePreviewToken(h.db.db, token))?.item.id).toBe(item.id);
    const untouched = await h.db.db
      .selectFrom('content_items')
      .select('data')
      .where('id', '=', other.id)
      .executeTakeFirst();
    expect(JSON.parse(untouched!.data)).toEqual({ body: 'unpublished' });
  });

  it('answers 404 for unknown, expired, and somebody else’s token alike', async () => {
    const item = await draft();
    const token = await mint(item.id);

    const unknown = await previewPut(
      h.context({ method: 'PUT', json: { token: 'a'.repeat(64), ...snapshot } }),
    );

    await h.db.db
      .updateTable('preview_tokens')
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .execute();
    const expired = await previewPut(h.context({ method: 'PUT', json: { token, ...snapshot } }));

    const freshToken = await mint(item.id);
    h.as(await h.user('editor', 'someone-else@example.com'));
    const foreign = await previewPut(
      h.context({ method: 'PUT', json: { token: freshToken, ...snapshot } }),
    );

    // Identical, because a distinct status confirms the token exists — which is the thing
    // `resolvePreviewToken` declines to say and this must not say either.
    expect([unknown.status, expired.status, foreign.status]).toEqual([404, 404, 404]);
    expect(await body(unknown)).toEqual(await body(foreign));
  });

  it('reports an over-length field without failing the request', async () => {
    await createField(h.db.db, type.id, {
      api_id: 'code',
      label: 'Code',
      type: 'text',
      required: false,
      localized: false,
      position: 1,
      config: { maxLength: 3 },
      help_text: null,
    });
    const item = await draft();
    const token = await mint(item.id);

    const response = await previewPut(
      h.context({
        method: 'PUT',
        json: { token, ...snapshot, data: { code: 'far too long' } },
      }),
    );

    /**
     * 200 with `stale: true`, not a 4xx.
     *
     * The previous snapshot still renders, so nothing has failed from the pane's point of view. A
     * 4xx would push this into the editor's own error handling, where a message means "your save
     * was rejected" — and that has to keep meaning that.
     */
    expect(response.status).toBe(200);
    expect(await body<{ stale: boolean }>(response)).toMatchObject({ stale: true });
  });

  it('refuses a draft too large to be one', async () => {
    const item = await draft();
    const token = await mint(item.id);

    const response = await previewPut(
      h.context({
        method: 'PUT',
        json: { token, ...snapshot, data: { body: 'x'.repeat(600 * 1024) } },
      }),
    );

    expect(response.status).toBe(413);
  });
});

describe('which page a token may override', () => {
  /**
   * The regression that makes the pane's address box safe.
   *
   * This branch used to ignore `path` entirely, which was invisible while the only caller was a 302
   * straight to `item.path`.
   */
  it('applies the snapshot on the page it was minted for', async () => {
    const item = await draft();
    h.as(contributor);
    const { token } = await body<{ token: string }>(
      await previewPost(h.context({ method: 'POST', json: { item: item.id, draft: snapshot } })),
    );

    const response = await resolveGet(
      h.context({
        url: `/api/taproot/delivery/resolve?path=${item.path}&${PREVIEW_PARAM}=${token}`,
      }),
    );

    const payload = await body<{ item: { data: Record<string, unknown> } }>(response);
    expect(payload.item.data).toEqual({ body: 'typing' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('does not apply it to any other page', async () => {
    const item = await draft();
    const elsewhere = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
      status: 'published',
      data: { body: 'the real page' },
    });

    h.as(contributor);
    const { token } = await body<{ token: string }>(
      await previewPost(h.context({ method: 'POST', json: { item: item.id, draft: snapshot } })),
    );

    // Carrying the token to another address must render *that* page, published, rather than the
    // item being edited. Otherwise every link followed inside the frame shows the draft again.
    const response = await resolveGet(
      h.context({
        url: `/api/taproot/delivery/resolve?path=${elsewhere.path}&${PREVIEW_PARAM}=${token}`,
      }),
    );

    const payload = await body<{ item: { id: string; data: Record<string, unknown> } }>(response);
    expect(payload.item.id).toBe(elsewhere.id);
    expect(payload.item.data).toEqual({ body: 'the real page' });
  });

  it('keeps a token from being a site-wide key to unpublished content', async () => {
    const item = await draft();
    const otherDraft = await draft('Not yours');

    h.as(contributor);
    const { token } = await body<{ token: string }>(
      await previewPost(h.context({ method: 'POST', json: { item: item.id } })),
    );

    const response = await resolveGet(
      h.context({
        url: `/api/taproot/delivery/resolve?path=${otherDraft.path}&${PREVIEW_PARAM}=${token}`,
      }),
    );

    // A different unpublished page is still a 404: the capability is over one item.
    expect(response.status).toBe(404);
  });

  it('never lets a token-bearing URL into a shared cache', async () => {
    const item = await draft();
    const elsewhere = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
      status: 'published',
      data: { body: 'public' },
    });

    h.as(contributor);
    const { token } = await body<{ token: string }>(
      await previewPost(h.context({ method: 'POST', json: { item: item.id } })),
    );

    const response = await resolveGet(
      h.context({
        url: `/api/taproot/delivery/resolve?path=${elsewhere.path}&${PREVIEW_PARAM}=${token}`,
      }),
    );

    // The body is public; the URL is a cache key carrying a credential, and that is what must not
    // be stored.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
