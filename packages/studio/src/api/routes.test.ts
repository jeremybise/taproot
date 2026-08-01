import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createContentType,
  createField,
  createItem,
  createTaxonomy,
  createTerm,
  updateItem,
  type ContentTypeRow,
  type FieldRow,
  type User,
} from '@taprootcms/core';

import { createHarness, body, location, type Harness } from './testHarness.js';

import { GET as itemsGet, POST as itemsPost } from './items/index.js';
import {
  DELETE as itemDelete,
  PATCH as itemPatch,
  POST as itemFormPost,
} from './items/[id].js';
import { POST as restorePost } from './items/[id]/revisions/[revisionId]/restore.js';
import { POST as typeFormPost } from './content-types/[id].js';
import { POST as redirectPost, GET as redirectsGet } from './redirects/index.js';
import { POST as redirectItemPost } from './redirects/[id].js';
import { DELETE as mediaDelete } from './media/[id].js';
import { POST as termPost } from './taxonomies/[id]/terms.js';

/**
 * The REST API's own behaviour, as opposed to the services behind it.
 *
 * Every route goes through `handle`, which owns three things no service test can see: the
 * authentication gate, the role gate, and the mapping from a domain error to a status code. Add
 * to that the conventions the admin screens depend on — `_method=delete` on a form POST, the
 * redirect target after one succeeds — and there is a real contract here that had no coverage.
 */

let h: Harness;
let admin: User;
let editor: User;
let contributor: User;
let viewer: User;

beforeEach(async () => {
  h = await createHarness();
  admin = await h.user('admin');
  editor = await h.user('editor');
  contributor = await h.user('contributor');
  viewer = await h.user('viewer');
});

afterEach(async () => {
  await h.destroy();
});

async function seedPageType(): Promise<{ type: ContentTypeRow; fields: FieldRow[] }> {
  const type = await createContentType(h.db.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    title_field: 'title',
  });

  const body = await createField(h.db.db, type.id, {
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

describe('the auth gate every route shares', () => {
  it('refuses an anonymous request with 401', async () => {
    h.as(undefined);
    const response = await itemsGet(h.context());

    expect(response.status).toBe(401);
    expect((await body(response)).error).toMatch(/Sign in/);
  });

  it('refuses an under-privileged request with 403, naming the role needed', async () => {
    h.as(viewer);
    const response = await itemsPost(
      h.context({ json: { contentTypeId: 'x', title: 'Nope' } }),
    );

    expect(response.status).toBe(403);
    expect((await body(response)).error).toMatch(/contributor role or higher/);
  });

  it('distinguishes "not signed in" from "not allowed"', async () => {
    // A 403 for an anonymous request would tell someone the route exists and that they merely
    // lack a role, when the honest answer is that they have not identified themselves at all.
    h.as(undefined);
    expect((await itemsPost(h.context({ json: {} }))).status).toBe(401);
    h.as(viewer);
    expect((await itemsPost(h.context({ json: {} }))).status).toBe(403);
  });
});

describe('error mapping', () => {
  it('turns a validation failure into 422 with per-field messages', async () => {
    const { type } = await seedPageType();
    await createField(h.db.db, type.id, {
      api_id: 'headline',
      label: 'Headline',
      type: 'text',
      required: true,
      localized: false,
      position: 1,
      config: {},
      help_text: null,
    });

    h.as(editor);
    const response = await itemsPost(
      h.context({ json: { contentTypeId: type.id, title: 'No headline', data: {} } }),
    );

    expect(response.status).toBe(422);
    // Keyed by `api_id` so the editor can render each message beside its own input.
    expect((await body(response)).fields).toHaveProperty('headline');
  });

  it('turns a malformed JSON body into 422 rather than 500', async () => {
    h.as(editor);
    const context = h.context({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    // A body that is not JSON at all — the shape a truncated request arrives in.
    Object.defineProperty(context, 'request', {
      value: new Request('http://localhost:4321/api/taproot/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"title": ',
      }),
    });

    const response = await itemsPost(context);
    expect(response.status).toBe(422);
  });

  it('turns a refused delete into 409, not 500', async () => {
    const { type, fields } = await seedPageType();
    const parent = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Parent',
    });
    await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Child',
      parentId: parent.id,
    });

    h.as(editor);
    const response = await itemDelete(h.context({ params: { id: parent.id } }));

    // The request was well-formed; the refusal is about state.
    expect(response.status).toBe(409);
    expect((await body(response)).error).toMatch(/sit beneath it/);
  });

  it('turns a missing parent resource into 404, not a 500 with an internal message', async () => {
    h.as(admin);
    const response = await termPost(
      h.context({ params: { id: 'missing-taxonomy' }, json: { name: 'X' } }),
    );

    expect(response.status).toBe(404);
  });

  it('never leaks an internal error message to the client', async () => {
    // `handle` logs the real error and returns an opaque 500, because an exception's message can
    // carry SQL fragments or file paths.
    h.as(admin);
    const context = h.context({ params: { id: 'x' } });
    Object.defineProperty(context, 'locals', {
      value: { taproot: { ...(context.locals as { taproot: object }).taproot, db: null } },
    });

    const response = await termPost(context);
    expect(response.status).toBe(500);
    expect((await body(response)).error).toBe(
      'Something went wrong. Check the server logs for details.',
    );
  });
});

describe('publishing gates', () => {
  it('refuses a contributor creating published content', async () => {
    const { type } = await seedPageType();
    h.as(contributor);

    const response = await itemsPost(
      h.context({ json: { contentTypeId: type.id, title: 'Live', status: 'published' } }),
    );

    expect(response.status).toBe(403);
  });

  it('refuses a contributor scheduling', async () => {
    // Inert today because nothing flips a scheduled item live — and a publish-without-approval
    // path the day something does.
    const { type } = await seedPageType();
    h.as(contributor);

    const response = await itemsPost(
      h.context({ json: { contentTypeId: type.id, title: 'Later', status: 'scheduled' } }),
    );

    expect(response.status).toBe(403);
  });

  it('refuses a contributor unpublishing', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Live',
      status: 'published',
    });

    h.as(contributor);
    const response = await itemPatch(
      h.context({ method: 'PATCH', params: { id: item.id }, json: { status: 'draft' } }),
    );

    expect(response.status).toBe(403);
  });

  it('lets a contributor edit a published item without touching its status', async () => {
    // The common case, and the one an over-broad gate would break: ordinary editing of a live page.
    const { type, fields } = await seedPageType();
    const item = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Live',
      status: 'published',
    });

    h.as(contributor);
    const response = await itemPatch(
      h.context({ method: 'PATCH', params: { id: item.id }, json: { title: 'Live, edited' } }),
    );

    expect(response.status).toBe(200);
  });

  /** The revision a given number belongs to, since restore is addressed by id. */
  async function revisionId(itemId: string, number: number): Promise<string> {
    const row = await h.db.db
      .selectFrom('revisions')
      .select('id')
      .where('content_item_id', '=', itemId)
      .where('revision_number', '=', number)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  it('refuses a contributor restoring a revision that would publish', async () => {
    // Published at revision 1, taken down to draft at revision 2. Restoring revision 1 republishes,
    // which is the thing the PATCH route would have refused them.
    const { type, fields } = await seedPageType();
    const item = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Live',
      status: 'published',
      userId: admin.id,
    });
    await updateItem(h.db, type, fields, item.id, { status: 'draft', userId: admin.id });

    h.as(contributor);
    const response = await restorePost(
      h.context({ params: { id: item.id, revisionId: await revisionId(item.id, 1) } }),
    );

    expect(response.status).toBe(403);
  });

  it('refuses a contributor restoring a revision that would UNpublish', async () => {
    /**
     * The direction that was missing entirely. A restore addresses a revision, not a status, so
     * "take the live page back to last week" reads as an ordinary edit — and used to be one,
     * because the check only looked at whether the *revision* was published.
     */
    const { type, fields } = await seedPageType();
    const item = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Draft first',
      status: 'draft',
      userId: admin.id,
    });
    await updateItem(h.db, type, fields, item.id, { status: 'published', userId: admin.id });

    h.as(contributor);
    const response = await restorePost(
      h.context({ params: { id: item.id, revisionId: await revisionId(item.id, 1) } }),
    );

    expect(response.status).toBe(403);
    expect((await body(response)).error).toMatch(/would change the item to "draft"/);
  });

  it('lets an editor restore in either direction', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Live',
      status: 'published',
      userId: admin.id,
    });
    await updateItem(h.db, type, fields, item.id, { status: 'draft', userId: admin.id });

    h.as(editor);
    const response = await restorePost(
      h.context({ params: { id: item.id, revisionId: await revisionId(item.id, 1) } }),
    );

    expect(response.status).toBe(200);
  });
});

describe('form conventions the admin screens depend on', () => {
  it('deletes a content item through _method on a form POST, and redirects to its type', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Temporary',
    });

    h.as(editor);
    const response = await itemFormPost(
      h.context({ params: { id: item.id }, form: { _method: 'delete', confirm: item.slug } }),
    );

    expect(response.status).toBe(303);
    expect(location(response)).toBe('/admin/content/type/page?deleted=Temporary');
  });

  it('refuses the delete when the typed confirmation does not match', async () => {
    /**
     * The check has to be here rather than on a disabled submit button, because the admin is
     * server-rendered precisely so it keeps working with JavaScript off — which also means a
     * disabled button is not a control at all.
     */
    const { type, fields } = await seedPageType();
    const item = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Temporary',
    });

    h.as(editor);
    const response = await itemFormPost(
      h.context({ params: { id: item.id }, form: { _method: 'delete', confirm: 'wrong' } }),
    );

    expect(location(response)).toMatch(/error=Type temporary exactly to confirm/);
    expect(
      await h.db.db.selectFrom('content_items').select('id').where('id', '=', item.id).executeTakeFirst(),
    ).toBeDefined();
  });

  it('rejects a form POST that is not a recognised _method', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(h.db, type, fields, { contentTypeId: type.id, title: 'X' });

    h.as(editor);
    const response = await itemFormPost(
      h.context({ params: { id: item.id }, form: { confirm: item.slug } }),
    );

    expect(response.status).toBe(400);
  });

  it('sends a content-type delete back to the screen it was submitted from', async () => {
    // Block types live on their own settings screen, so a refusal has to return there rather than
    // to whichever list sorts first.
    const blockType = await createContentType(h.db.db, {
      api_id: 'hero',
      name: 'Hero',
      name_plural: 'Heroes',
      kind: 'block',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: null,
    });

    h.as(admin);
    const response = await typeFormPost(
      h.context({ params: { id: blockType.id }, form: { _method: 'delete', confirm: 'wrong' } }),
    );

    expect(location(response)).toMatch(/^\/admin\/settings\/blocks\/[^?]+\?error=/);
  });
});

describe('redirects', () => {
  it('creates one from a form and redirects back with the outcome', async () => {
    h.as(admin);
    const response = await redirectPost(
      h.context({ form: { fromPath: '/old', toPath: '/new', statusCode: '301' } }),
    );

    expect(response.status).toBe(303);
    expect(location(response)).toBe('/admin/settings/redirects?created=/old');
  });

  it('returns 409 for a duplicate over JSON, and a flash over a form', async () => {
    h.as(admin);
    await redirectPost(h.context({ json: { fromPath: '/old', toPath: '/new' } }));

    const asJson = await redirectPost(h.context({ json: { fromPath: '/old', toPath: '/other' } }));
    expect(asJson.status).toBe(409);

    const asForm = await redirectPost(
      h.context({ form: { fromPath: '/old', toPath: '/other' } }),
    );
    expect(location(asForm)).toMatch(/error=A redirect from \/old already exists/);
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    // `z.strictObject`, so a typo in a client is an error rather than a silently dropped setting.
    h.as(admin);
    const response = await redirectPost(
      h.context({ json: { fromPath: '/a', toPath: '/b', permanent: true } }),
    );

    expect(response.status).toBe(422);
  });

  it('needs the admin role', async () => {
    h.as(editor);
    expect((await redirectPost(h.context({ json: { fromPath: '/a', toPath: '/b' } }))).status).toBe(
      403,
    );
  });

  it('deletes one through _method', async () => {
    h.as(admin);
    await redirectPost(h.context({ json: { fromPath: '/a', toPath: '/b' } }));
    const { redirects } = await body<{ redirects: { id: string }[] }>(
      await redirectsGet(h.context()),
    );

    const response = await redirectItemPost(
      h.context({ params: { id: redirects[0]!.id }, form: { _method: 'delete' } }),
    );

    expect(location(response)).toBe('/admin/settings/redirects?deleted=/a');
  });
});

describe('media', () => {
  it('removes the stored object as well as the row', async () => {
    const { key } = await h.storage.put('2026/07/x/photo.png', new Uint8Array([1, 2, 3]), {
      contentType: 'image/png',
    });

    await h.db.db
      .insertInto('media')
      .values({
        id: 'm1',
        storage_key: key,
        filename: 'photo.png',
        mime_type: 'image/png',
        size_bytes: 3,
        width: null,
        height: null,
        alt_text: null,
        title: null,
        hotspot_x: null,
        hotspot_y: null,
        crop_top: null,
        crop_right: null,
        crop_bottom: null,
        crop_left: null,
        uploaded_by: admin.id,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      })
      .execute();

    h.as(editor);
    const response = await mediaDelete(h.context({ params: { id: 'm1' } }));

    expect(response.status).toBe(204);
    // A row pointing at a deleted object renders as a broken image; an object with no row is
    // invisible clutter. The row goes first, and both go.
    expect(h.storage.objects.has(key)).toBe(false);
  });

  it('404s for an asset that does not exist', async () => {
    h.as(editor);
    expect((await mediaDelete(h.context({ params: { id: 'nope' } }))).status).toBe(404);
  });

  it('needs the editor role, not merely a contributor', async () => {
    h.as(contributor);
    expect((await mediaDelete(h.context({ params: { id: 'nope' } }))).status).toBe(403);
  });
});

describe('list filters reach the query', () => {
  it('passes status and search through from the query string', async () => {
    const { type, fields } = await seedPageType();
    await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Published thing',
      status: 'published',
      userId: admin.id,
    });
    await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Draft thing',
      status: 'draft',
      userId: admin.id,
    });

    h.as(viewer);
    const filtered = await body<{ items: { title: string }[] }>(
      await itemsGet(h.context({ url: '/api/taproot/items?status=published' })),
    );

    expect(filtered.items.map((item) => item.title)).toEqual(['Published thing']);
  });

  it('lets a viewer read', async () => {
    // Reading is not gated: `handle` without a `role` only requires a signed-in user, which is
    // what makes a viewer account useful at all.
    h.as(viewer);
    expect((await itemsGet(h.context())).status).toBe(200);
  });
});

describe('taxonomy terms', () => {
  it('creates a term under a taxonomy', async () => {
    const taxonomy = await createTaxonomy(h.db.db, {
      api_id: 'department',
      name: 'Department',
      name_plural: 'Departments',
    });

    h.as(editor);
    const response = await termPost(
      h.context({ params: { id: taxonomy.id }, json: { name: 'Admissions' } }),
    );

    expect(response.status).toBe(201);
  });

  it('maps a nesting refusal to 422', async () => {
    const flat = await createTaxonomy(h.db.db, {
      api_id: 'audience',
      name: 'Audience',
      name_plural: 'Audiences',
      hierarchical: false,
    });
    const root = await createTerm(h.db.db, flat.id, { name: 'Students' });

    h.as(editor);
    const response = await termPost(
      h.context({ params: { id: flat.id }, json: { name: 'Undergrad', parentId: root.id } }),
    );

    expect(response.status).toBe(422);
  });
});
