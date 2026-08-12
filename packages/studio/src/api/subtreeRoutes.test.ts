import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createContentType,
  createField,
  createItem,
  getItem,
  listItemSummaries,
  type ContentTypeRow,
  type FieldRow,
  type User,
} from '@taprootcms/core';

import { createHarness, body, type Harness } from './testHarness.js';
import { POST as duplicatePost } from './items/[id]/duplicate.js';
import { POST as subtreePost } from './items/[id]/subtree.js';

/**
 * The two subtree endpoints.
 *
 * What needs a route test rather than a service test is the part core cannot decide: who is allowed
 * to do it. `updateSubtree` takes permission as a callback precisely because roles live here, so the
 * wiring of that callback is the thing most worth pinning — a bulk endpoint that skipped it would be
 * a way to make a change `canChangeStatus` refuses one item at a time.
 */

let h: Harness;
let contributor: User;
let editor: User;
let type: ContentTypeRow;
let fields: FieldRow[];

beforeEach(async () => {
  h = await createHarness();
  contributor = await h.user('contributor');
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

async function page(title: string, parentId: string | null, status: 'published' | 'draft' = 'published') {
  return createItem(h.db, type, fields, {
    contentTypeId: type.id,
    title,
    parentId,
    status,
    data: { body: 'x' },
  });
}

/**
 * `params` is passed explicitly rather than parsed out of the URL, because the harness does not
 * route — it hands a context straight to a handler, exactly as Astro would after matching.
 */
function jsonRequest(id: string, suffix: string, payload: unknown) {
  return h.context({
    url: `/api/taproot/items/${id}/${suffix}`,
    method: 'POST',
    json: payload,
    params: { id },
  });
}

describe('duplicating a subtree', () => {
  it('copies the branch as drafts', async () => {
    const root = await page('2026-27', null);
    await page('Admissions', root.id);
    h.as(editor);

    const response = await duplicatePost(
      jsonRequest(root.id, 'duplicate', { slug: '2027-28' }),
    );

    expect(response.status).toBe(200);
    const result = await body<{ created: number; remaining: number; root: { id: string } }>(response);
    expect(result.remaining).toBe(0);

    const copies = await listItemSummaries(h.db.db, { pathPrefix: '/2027-28', limit: 20 });
    expect(copies.items).toHaveLength(1);
    expect((await getItem(h.db.db, result.root.id))?.status).toBe('draft');
  });

  /** Everything it writes is a draft, which reaches nobody — the same bar as creating one item. */
  it('is open to a contributor', async () => {
    const root = await page('2026-27', null);
    h.as(contributor);

    const response = await duplicatePost(
      jsonRequest(root.id, 'duplicate', { slug: '2027-28' }),
    );
    expect(response.status).toBe(200);
  });

  it('404s for an item that does not exist', async () => {
    h.as(editor);
    const response = await duplicatePost(jsonRequest('nope', 'duplicate', {}));
    expect(response.status).toBe(404);
  });

  it('422s for a kind with no subtree', async () => {
    const collection = await createContentType(h.db.db, {
      api_id: 'event',
      name: 'Event',
      name_plural: 'Events',
      kind: 'collection',
      description: null,
      icon: null,
      url_prefix: 'events',
      summary_template: null,
    });
    const item = await createItem(h.db, collection, [], {
      contentTypeId: collection.id,
      title: 'Open day',
    });
    h.as(editor);

    const response = await duplicatePost(
      jsonRequest(item.id, 'duplicate', {}),
    );
    expect(response.status).toBe(422);
  });

  it('reports what is left so a caller can loop', async () => {
    const root = await page('2026-27', null);
    for (const title of ['A', 'B', 'C']) await page(title, root.id);
    h.as(editor);

    const first = await body<{ remaining: number }>(
      await duplicatePost(
        jsonRequest(root.id, 'duplicate', { slug: '2027-28', limit: 2 }),
      ),
    );
    expect(first.remaining).toBeGreaterThan(0);
  });
});

describe('bulk-changing a subtree', () => {
  it('archives everything under an item', async () => {
    const root = await page('2026-27', null);
    const child = await page('Admissions', root.id);
    h.as(editor);

    const response = await subtreePost(
      jsonRequest(root.id, 'subtree', { status: 'archived' }),
    );

    expect(response.status).toBe(200);
    expect((await getItem(h.db.db, child.id))?.status).toBe('archived');
    // The root is left alone unless asked for, matching the filter everywhere else.
    expect((await getItem(h.db.db, root.id))?.status).toBe('published');
  });

  /**
   * The load-bearing wiring. A contributor may not publish, one item at a time or five hundred, and
   * the refusal is reported per item rather than sinking the request.
   */
  it('applies the caller’s own permissions per item', async () => {
    const root = await page('2026-27', null);
    await page('Admissions', root.id, 'draft');
    h.as(contributor);

    const response = await subtreePost(
      jsonRequest(root.id, 'subtree', { status: 'published' }),
    );

    const result = await body<{ changed: number; refused: { reason: string }[] }>(response);
    expect(result.changed).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]!.reason).toContain('permission');

    // And an editor doing the same thing succeeds, so the refusal is about the role rather than a
    // route that simply never works.
    h.as(editor);
    const allowed = await subtreePost(
      jsonRequest(root.id, 'subtree', { status: 'published' }),
    );
    expect((await body<{ changed: number }>(allowed)).changed).toBe(1);
  });

  it('sets noIndex across the branch', async () => {
    const root = await page('2026-27', null);
    const child = await page('Admissions', root.id);
    h.as(editor);

    await subtreePost(jsonRequest(root.id, 'subtree', { noIndex: true }));

    expect((await getItem(h.db.db, child.id))?.seo.noIndex).toBe(true);
  });

  it('400s when asked to change nothing', async () => {
    const root = await page('2026-27', null);
    h.as(editor);

    const response = await subtreePost(jsonRequest(root.id, 'subtree', {}));
    expect(response.status).toBe(400);
  });

  it('404s for an item that does not exist', async () => {
    h.as(editor);
    const response = await subtreePost(
      jsonRequest('nope', 'subtree', { status: 'archived' }),
    );
    expect(response.status).toBe(404);
  });
});
