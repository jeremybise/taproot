import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createContentType,
  createField,
  createItem,
  createRelease,
  getItem,
  getRelease,
  getStagedItem,
  stageItem,
  type ContentItem,
  type ContentTypeRow,
  type FieldRow,
  type User,
} from '@taprootcms/core';

import { createHarness, body, location, type Harness } from './testHarness.js';

import { GET as releasesGet, POST as releasesPost } from './releases/index.js';
import { PATCH as releasePatch, POST as releaseFormPost } from './releases/[id].js';
import { POST as releaseItemsPost } from './releases/[id]/items.js';
import { PATCH as stagedPatch } from './releases/[id]/items/[itemId].js';
import { POST as publishPost } from './releases/[id]/publish.js';

/**
 * The release routes' own behaviour, as opposed to the service behind them.
 *
 * The role split is the part worth pinning down here and nowhere else: staging is a contributor's
 * act and publishing is an editor's, and the two live on adjacent URLs. Getting that backwards in a
 * refactor would either lock content authors out of assembling their own launch or hand them a way
 * to publish without approval, and no service test would notice either.
 */

let h: Harness;
let editor: User;
let contributor: User;
let viewer: User;
let type: ContentTypeRow;
let fields: FieldRow[];

beforeEach(async () => {
  h = await createHarness();
  editor = await h.user('editor');
  contributor = await h.user('contributor');
  viewer = await h.user('viewer');

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

async function page(title: string, status: 'draft' | 'published' = 'draft'): Promise<ContentItem> {
  return createItem(h.db, type, fields, {
    contentTypeId: type.id,
    title,
    status,
    data: { body: 'original' },
  });
}

describe('who may do what', () => {
  it('lets a contributor stage an item — queuing is not publishing', async () => {
    const release = await createRelease(h.db.db, { name: 'Spring' });
    const item = await page('Tuition');

    h.as(contributor);
    const response = await releaseItemsPost(
      h.context({ params: { id: release.id }, json: { contentItemId: item.id } }),
    );

    expect(response.status).toBe(201);
    expect(await getStagedItem(h.db.db, release.id, item.id)).toBeDefined();
  });

  it('lets a contributor edit the version waiting in a release', async () => {
    const release = await createRelease(h.db.db, { name: 'Spring' });
    const item = await page('Tuition');
    await stageItem(h.db.db, release.id, item.id);

    h.as(contributor);
    const response = await stagedPatch(
      h.context({
        method: 'PATCH',
        params: { id: release.id, itemId: item.id },
        json: { data: { body: 'rewritten' } },
      }),
    );

    expect(response.status).toBe(200);
    expect((await getStagedItem(h.db.db, release.id, item.id))!.data).toEqual({
      body: 'rewritten',
    });
  });

  it('refuses to let a contributor create a release', async () => {
    h.as(contributor);
    const response = await releasesPost(h.context({ json: { name: 'Spring' } }));
    expect(response.status).toBe(403);
  });

  /**
   * The one that matters most. Publishing a release performs a transition into `published` for
   * every item in it, which the workflow graph prices at editor — so a release must not become a
   * route to a change `canChangeStatus` would refuse one item at a time.
   */
  it('refuses to let a contributor publish a release', async () => {
    const release = await createRelease(h.db.db, { name: 'Spring' });
    const item = await page('Tuition');
    await stageItem(h.db.db, release.id, item.id);

    h.as(contributor);
    const response = await publishPost(h.context({ params: { id: release.id } }));

    expect(response.status).toBe(403);
    expect((await getItem(h.db.db, item.id))!.status).toBe('draft');
  });

  it('refuses a viewer entirely', async () => {
    const release = await createRelease(h.db.db, { name: 'Spring' });
    const item = await page('Tuition');

    h.as(viewer);
    const response = await releaseItemsPost(
      h.context({ params: { id: release.id }, json: { contentItemId: item.id } }),
    );
    expect(response.status).toBe(403);
  });

  it('refuses an anonymous request', async () => {
    h.as(undefined);
    expect((await releasesGet(h.context())).status).toBe(401);
  });
});

describe('creating and scheduling', () => {
  it('sends a form-created release straight to its own screen', async () => {
    h.as(editor);
    const response = await releasesPost(h.context({ form: { name: 'Spring launch' } }));

    // A release with nothing in it is not a thing anybody wanted, so the next step is always
    // adding content to it.
    expect(response.status).toBe(303);
    expect(location(response)).toMatch(/^\/admin\/releases\/[\w-]+$/);
  });

  it('refuses to schedule without a moment', async () => {
    const release = await createRelease(h.db.db, { name: 'Spring' });

    h.as(editor);
    const response = await releaseFormPost(
      h.context({ params: { id: release.id }, form: { _method: 'schedule', publishAt: '' } }),
    );

    expect(location(response)).toContain('error=');
    expect((await getRelease(h.db.db, release.id))!.status).toBe('open');
  });

  /**
   * `publish_at` is cleared whenever a release leaves `scheduled`, in every path — the same rule
   * content items keep. A stale time is a booby trap: reschedule later without picking a moment and
   * it inherits one in the past, which is to say it goes live at the next sweep.
   */
  it('clears the scheduled moment when a release is reopened', async () => {
    const release = await createRelease(h.db.db, { name: 'Spring' });

    h.as(editor);
    await releaseFormPost(
      h.context({
        params: { id: release.id },
        form: { _method: 'schedule', publishAt: '2027-09-01T09:00' },
      }),
    );
    expect((await getRelease(h.db.db, release.id))!.publish_at).not.toBeNull();

    await releaseFormPost(
      h.context({ params: { id: release.id }, form: { _method: 'reopen' } }),
    );

    const after = await getRelease(h.db.db, release.id);
    expect(after!.status).toBe('open');
    expect(after!.publish_at).toBeNull();
  });

  it('will not set status to published through PATCH', async () => {
    const release = await createRelease(h.db.db, { name: 'Spring' });

    h.as(editor);
    const response = await releasePatch(
      h.context({ method: 'PATCH', params: { id: release.id }, json: { status: 'published' } }),
    );

    // Publishing applies content, cascades paths, and writes redirects. A status field that did
    // all that would be a second way in with no pre-flight behind it.
    expect(response.status).toBe(422);
    expect((await getRelease(h.db.db, release.id))!.status).toBe('open');
  });
});

describe('publishing', () => {
  it('publishes every staged item and reports what went live', async () => {
    const release = await createRelease(h.db.db, { name: 'Spring' });
    const first = await page('Tuition');
    const second = await page('Aid');
    await stageItem(h.db.db, release.id, first.id);
    await stageItem(h.db.db, release.id, second.id);

    h.as(editor);
    const response = await publishPost(h.context({ params: { id: release.id } }));

    expect(response.status).toBe(200);
    const result = await body<{ ok: boolean; published: unknown[] }>(response);
    expect(result.ok).toBe(true);
    expect(result.published).toHaveLength(2);
  });

  it('answers 409 when pre-flight refuses, because the request was fine and the state was not', async () => {
    const release = await createRelease(h.db.db, { name: 'Spring' });

    h.as(editor);
    const response = await publishPost(h.context({ params: { id: release.id } }));

    expect(response.status).toBe(409);
    const result = await body<{ ok: boolean; problems: { reason: string }[] }>(response);
    expect(result.ok).toBe(false);
    expect(result.problems[0]!.reason).toContain('no content in it');
  });

  /**
   * The reasons are recomputed by the screen rather than carried in the URL. A list of reasons in a
   * query string survives being fixed — the editor corrects the field, comes back, and is still
   * being told about it.
   */
  it('sends a form publish back with a flag, not with the reasons', async () => {
    const release = await createRelease(h.db.db, { name: 'Spring' });

    h.as(editor);
    const response = await publishPost(
      h.context({ params: { id: release.id }, form: { confirm: '1' } }),
    );

    expect(response.status).toBe(303);
    expect(location(response)).toBe(`/admin/releases/${release.id}?blocked=1`);
  });
});

describe('the staged endpoint', () => {
  it('does not accept a status', async () => {
    const release = await createRelease(h.db.db, { name: 'Spring' });
    const item = await page('Tuition');
    await stageItem(h.db.db, release.id, item.id);

    h.as(editor);
    const response = await stagedPatch(
      h.context({
        method: 'PATCH',
        params: { id: release.id, itemId: item.id },
        json: { status: 'published' },
      }),
    );

    // Accepting one would be a way to move an item's status without going through
    // `canChangeStatus` — and "what status does this end up in" is the release's question anyway.
    expect(response.status).toBe(200);
    expect((await getItem(h.db.db, item.id))!.status).toBe('draft');
  });

  it('reports validation failures per field, like every other content write', async () => {
    const release = await createRelease(h.db.db, { name: 'Spring' });
    await createField(h.db.db, type.id, {
      api_id: 'summary',
      label: 'Summary',
      type: 'text',
      required: true,
      localized: false,
      position: 1,
      config: {},
      help_text: null,
    });
    const item = await page('Tuition');
    await stageItem(h.db.db, release.id, item.id);

    h.as(editor);
    const response = await stagedPatch(
      h.context({
        method: 'PATCH',
        params: { id: release.id, itemId: item.id },
        json: { data: { body: 'x' } },
      }),
    );

    expect(response.status).toBe(422);
    const result = await body<{ fields: Record<string, string[]> }>(response);
    expect(result.fields.summary).toBeDefined();
  });

  it('404s for an item that is not in the release', async () => {
    const release = await createRelease(h.db.db, { name: 'Spring' });
    const item = await page('Tuition');

    h.as(editor);
    const response = await stagedPatch(
      h.context({
        method: 'PATCH',
        params: { id: release.id, itemId: item.id },
        json: { title: 'New' },
      }),
    );

    expect(response.status).toBe(404);
  });
});
