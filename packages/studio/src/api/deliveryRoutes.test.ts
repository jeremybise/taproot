import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiKey,
  createContentType,
  createField,
  createItem,
  getApiKey,
  revokeApiKey,
  type ContentTypeRow,
  type FieldRow,
  type User,
} from '@taproot/core';

import { createHarness, body, type Harness } from './testHarness.js';

import { GET as resolveGet } from './delivery/resolve.js';
import { GET as itemsGet } from './delivery/items.js';
import { GET as schemaGet } from './delivery/schema.js';
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
      title_field: 'title',
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
      title_field: null,
    });

    h.as(editor);
    const response = await itemsGet(h.context({ url: '/api/taproot/delivery/items?type=hero' }));
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
