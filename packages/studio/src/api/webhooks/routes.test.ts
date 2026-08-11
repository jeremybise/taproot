import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createContentType,
  createField,
  createItem,
  createWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookDeliveries,
  type ContentTypeRow,
  type FieldRow,
  type User,
  type WebhookEventInput,
} from '@taprootcms/core';

import { createHarness, body, location, type Harness } from '../testHarness.js';
import { GET as webhooksGet, POST as webhooksPost } from './index.js';
import { PATCH as webhookPatch, POST as webhookFormPost } from './[id].js';
import { PATCH as itemPatch } from '../items/[id].js';
import { POST as itemsPost } from '../items/index.js';

/**
 * The webhook routes, and the emit sites that feed them.
 *
 * Two different claims are tested here and they are worth keeping apart. The routes own the admin
 * gate, the redaction, and the form conventions the screens post through. The emit sites own
 * something a service test cannot see: **which events a write declares**, which is the half that
 * `SITE_TAG` taught has to be asserted directly — a queue that works perfectly delivers nothing if
 * nobody emits.
 */

let h: Harness;
let admin: User;
let editor: User;
let viewer: User;

beforeEach(async () => {
  h = await createHarness();
  admin = await h.user('admin');
  editor = await h.user('editor');
  viewer = await h.user('viewer');
});

afterEach(async () => {
  await h.destroy();
});

const CREATE = {
  label: 'Site rebuild',
  url: 'https://example.edu/hooks',
  events: ['item.published'],
};

/**
 * What a request declared, read off the context the route was handed.
 *
 * Nothing is dispatched here — the middleware does that, and a test calls a route directly — so this
 * is the half a route test can prove, the same way the existing suite reads `invalidated`. The cast
 * matches how those assertions are already written: `APIContext['locals']` is Astro's, and widening
 * it globally for a test helper is a bigger change than the one line it saves.
 */
function emitted(context: { locals: unknown }): WebhookEventInput[] {
  return (context.locals as { taproot: { emitted: WebhookEventInput[] } }).taproot.emitted;
}

async function seedPageType(): Promise<{ type: ContentTypeRow; fields: FieldRow[] }> {
  const type = await createContentType(h.db.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    summary_template: '{{ title }}',
  });

  const field = await createField(h.db.db, type.id, {
    api_id: 'body',
    label: 'Body',
    type: 'text',
    required: false,
    localized: false,
    position: 0,
    config: {},
    help_text: null,
  });

  return { type, fields: [field] };
}

describe('who may manage webhooks', () => {
  it('refuses anyone below admin', async () => {
    h.as(undefined);
    expect((await webhooksGet(h.context())).status).toBe(401);

    h.as(viewer);
    expect((await webhooksGet(h.context())).status).toBe(403);

    // Editor is not enough either: an endpoint is where unpublished titles leave the deployment.
    h.as(editor);
    expect((await webhooksGet(h.context())).status).toBe(403);

    h.as(admin);
    expect((await webhooksGet(h.context())).status).toBe(200);
  });
});

describe('creating an endpoint', () => {
  it('returns the secret exactly once, and never again from the list', async () => {
    h.as(admin);

    const created = await webhooksPost(h.context({ json: CREATE }));
    expect(created.status).toBe(201);

    const { secret, endpoint } = await body<{ secret: string; endpoint: { id: string } }>(created);
    expect(secret.startsWith('whsec_')).toBe(true);

    const listed = await webhooksGet(h.context());
    const text = await listed.text();
    expect(text).toContain(endpoint.id);
    // The whole point: no response but the creating one may carry a signing secret.
    expect(text).not.toContain(secret);
    expect(text).not.toContain('whsec_');
  });

  it('refuses a plain-http URL with a message naming the rule', async () => {
    h.as(admin);

    const response = await webhooksPost(
      h.context({ json: { ...CREATE, url: 'http://example.edu/hooks' } }),
    );

    expect(response.status).toBe(400);
    expect((await body<{ error: string }>(response)).error).toContain('https');
  });

  /**
   * The form path is the one the admin screen uses, and it fails differently: a 400 with JSON would
   * leave somebody looking at raw text, so a refusal comes back as a redirect carrying the reason.
   */
  it('sends a form submission back to the screen with the reason', async () => {
    h.as(admin);

    const response = await webhooksPost(
      h.context({ form: { label: 'Broken', url: 'http://example.edu/hooks', events: 'item.published' } }),
    );

    expect(response.status).toBe(303);
    expect(location(response)).toContain('error=');
    expect(location(response)).toContain('https');
  });

  /**
   * Refused twice over, and 422 is the schema getting there first — `handle` maps a Zod failure to
   * it before the route body runs. Core refuses an empty list as well (`endpoints.test.ts`), which
   * is the check that matters: the schema guards this route and the service guards every caller.
   */
  it('refuses an endpoint that subscribes to nothing', async () => {
    h.as(admin);

    const response = await webhooksPost(h.context({ json: { ...CREATE, events: [] } }));
    expect(response.status).toBe(422);
  });
});

describe('managing one endpoint', () => {
  it('pauses and resumes through the form', async () => {
    h.as(admin);
    const { endpoint } = await createWebhookEndpoint(h.db.db, CREATE);

    await webhookFormPost(
      h.context({ params: { id: endpoint.id }, form: { _method: 'pause' } }),
    );
    expect((await getWebhookEndpoint(h.db.db, endpoint.id))!.active).toBe(0);

    await webhookFormPost(
      h.context({ params: { id: endpoint.id }, form: { _method: 'resume' } }),
    );
    expect((await getWebhookEndpoint(h.db.db, endpoint.id))!.active).toBe(1);
  });

  it('rotates the secret and hands the new one back through a cookie, not a URL', async () => {
    h.as(admin);
    const { endpoint, secret } = await createWebhookEndpoint(h.db.db, CREATE);

    const response = await webhookFormPost(
      h.context({ params: { id: endpoint.id }, form: { _method: 'rotate' } }),
    );

    expect(response.status).toBe(303);
    // A URL lands in history, in `Referer`, and in access logs. The secret is not in this one.
    expect(location(response)).not.toContain('whsec_');
    expect(response.headers.get('set-cookie')).toContain('taproot_webhook_secret=');

    const after = (await getWebhookEndpoint(h.db.db, endpoint.id))!;
    expect(after.secret).not.toBe(secret);
  });

  it('refuses a delete whose typed confirmation does not match', async () => {
    h.as(admin);
    const { endpoint } = await createWebhookEndpoint(h.db.db, CREATE);

    const response = await webhookFormPost(
      h.context({
        params: { id: endpoint.id },
        form: { _method: 'delete', confirm: 'not the label' },
      }),
    );

    expect(location(response)).toContain('error=');
    expect(await getWebhookEndpoint(h.db.db, endpoint.id)).toBeDefined();
  });

  it('deletes when the confirmation matches', async () => {
    h.as(admin);
    const { endpoint } = await createWebhookEndpoint(h.db.db, CREATE);

    await webhookFormPost(
      h.context({
        params: { id: endpoint.id },
        form: { _method: 'delete', confirm: endpoint.label },
      }),
    );

    expect(await getWebhookEndpoint(h.db.db, endpoint.id)).toBeUndefined();
  });

  it('never puts a secret in a PATCH response', async () => {
    h.as(admin);
    const { endpoint } = await createWebhookEndpoint(h.db.db, CREATE);

    const response = await webhookPatch(
      h.context({ params: { id: endpoint.id }, method: 'PATCH', json: { label: 'Renamed' } }),
    );

    expect(await response.text()).not.toContain('whsec_');
  });

  /**
   * A test send writes its row like any other, so the delivery log shows the attempt whichever way
   * it goes — the whole point being to find out what a real send would do.
   */
  it('records a test send in the delivery log', async () => {
    h.as(admin);
    const { endpoint } = await createWebhookEndpoint(h.db.db, CREATE);

    await webhookFormPost(h.context({ params: { id: endpoint.id }, form: { _method: 'test' } }));

    const { deliveries } = await listWebhookDeliveries(h.db.db, { endpointId: endpoint.id });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.event).toBe('ping');
  });
});

describe('what a content write declares', () => {
  it('emits nothing but a create for a draft', async () => {
    const { type } = await seedPageType();
    h.as(editor);

    const context = h.context({
      json: { contentTypeId: type.id, title: 'Draft', data: { body: 'x' } },
    });
    await itemsPost(context);

    expect(emitted(context).map((event) => event.event)).toEqual(['item.created']);
  });

  /**
   * Two events for one request, and neither is derivable from the other: "a row exists" and "the
   * public can see it" are different questions, and an endpoint subscribes to whichever it acts on.
   */
  it('emits both a create and a publish when an item is created live', async () => {
    const { type } = await seedPageType();
    h.as(editor);

    const context = h.context({
      json: {
        contentTypeId: type.id,
        title: 'Live',
        status: 'published',
        data: { body: 'x' },
      },
    });
    await itemsPost(context);

    expect(emitted(context).map((event) => event.event)).toEqual([
      'item.created',
      'item.published',
    ]);
  });

  it('emits an update on an ordinary save, with no publication event', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Draft',
      data: { body: 'x' },
    });

    h.as(editor);
    const context = h.context({ params: { id: item.id }, json: { title: 'Edited' } });
    await itemPatch(context);

    expect(emitted(context).map((event) => event.event)).toEqual(['item.updated']);
  });

  /**
   * Publication is about crossing the boundary, not about the destination status — which is why
   * `published → archived` is an unpublish and not merely an archive.
   */
  it('emits an unpublish when a live item leaves published, whatever it moves to', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Live',
      status: 'published',
      data: { body: 'x' },
    });

    h.as(editor);
    const context = h.context({ params: { id: item.id }, json: { status: 'archived' } });
    await itemPatch(context);

    expect(emitted(context).map((event) => event.event)).toEqual([
      'item.updated',
      'item.unpublished',
    ]);
  });

  /**
   * The subject is built from the row read *before* the delete — the only moment it can be. A
   * receiver handed nothing but an id has nothing to act on, because the item is gone.
   */
  it('describes a deleted item rather than naming it by id', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(h.db, type, fields, {
      contentTypeId: type.id,
      title: 'Doomed',
      data: { body: 'x' },
    });

    h.as(admin);
    const context = h.context({ params: { id: item.id }, method: 'DELETE' });
    const { DELETE: itemDelete } = await import('../items/[id].js');
    await itemDelete(context);

    const [declared] = emitted(context);
    expect(declared!.event).toBe('item.deleted');
    expect(declared!.subject).toMatchObject({ kind: 'item', title: 'Doomed', contentType: 'page' });
  });

  /**
   * A routeless collection's items are real content and none of them is a URL, so sending the
   * stored path would have a consumer rebuild an address the site answers 404 at.
   */
  it('sends a null path for an item with no page of its own', async () => {
    const type = await createContentType(h.db.db, {
      api_id: 'person',
      name: 'Person',
      name_plural: 'People',
      kind: 'collection',
      description: null,
      icon: null,
      url_prefix: 'people',
      item_pages: false,
      summary_template: '{{ title }}',
    });
    const field = await createField(h.db.db, type.id, {
      api_id: 'role',
      label: 'Role',
      type: 'text',
      required: false,
      localized: false,
      position: 0,
      config: {},
      help_text: null,
    });
    const person = await createItem(h.db, type, [field], {
      contentTypeId: type.id,
      title: 'Marguerite',
      data: { role: 'Dean' },
    });

    h.as(editor);
    const context = h.context({ params: { id: person.id }, json: { title: 'Marguerite O.' } });
    await itemPatch(context);

    expect(emitted(context)[0]!.subject).toMatchObject({ path: null });
    // The row still has one — the flag governs what is served, not what is stored.
    expect(person.path).not.toBeNull();
  });
});
