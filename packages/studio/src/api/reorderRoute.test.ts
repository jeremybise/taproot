import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createContentType,
  createItem,
  getChildren,
  itemTag,
  typeTag,
  type ContentTypeRow,
  type User,
} from '@taprootcms/core';

import { createHarness, body, type Harness } from './testHarness.js';
import { POST as reorderPost } from './items/[id]/children/reorder.js';

/**
 * Arranging a sibling group over HTTP.
 *
 * The service test in core covers what an order means; what needs a route test is the part core
 * cannot decide — who may do it, and **which cache tags the write declares**. The second is the one
 * this repository has been bitten by repeatedly: a tag nothing emits purges nothing, and Cloudflare
 * reports success either way, so the only defence is asserting the tags a write names.
 */

let h: Harness;
let viewer: User;
let contributor: User;
let pageType: ContentTypeRow;
let sectionType: ContentTypeRow;

const typeInput = {
  description: null,
  icon: null,
  url_prefix: null,
  summary_template: null,
};

beforeEach(async () => {
  h = await createHarness();
  viewer = await h.user('viewer');
  contributor = await h.user('contributor');

  pageType = await createContentType(h.db.db, {
    ...typeInput,
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
  });

  sectionType = await createContentType(h.db.db, {
    ...typeInput,
    api_id: 'catalog_section',
    name: 'Catalog section',
    name_plural: 'Catalog sections',
    kind: 'page',
  });
});

afterEach(async () => {
  await h.destroy();
});

const item = (type: ContentTypeRow, title: string, parentId: string | null) =>
  createItem(h.db, type, [], {
    contentTypeId: type.id,
    title,
    parentId,
    status: 'published',
  });

function request(parentId: string, orderedIds: string[]) {
  return h.context({
    url: `/api/taproot/items/${parentId}/children/reorder`,
    method: 'POST',
    json: { orderedIds },
    params: { id: parentId },
  });
}

const titlesUnder = async (parentId: string) =>
  (await getChildren(h.db.db, parentId)).map((child) => child.title);

/** `Locals` is Astro's own interface here, so the harness's extras need naming to be read. */
const purgedBy = (context: { locals: unknown }) =>
  (context.locals as { taproot: { invalidated: Set<string> } }).taproot.invalidated;

describe('POST /items/[id]/children/reorder', () => {
  it('reorders the level', async () => {
    const root = await item(pageType, 'Catalog', null);
    const a = await item(pageType, 'Admissions', root.id);
    const b = await item(pageType, 'Welcome', root.id);
    h.as(contributor);

    const response = await reorderPost(request(root.id, [b.id, a.id]));

    expect(response.status).toBe(200);
    expect(await body<{ ok: boolean }>(response)).toEqual({ ok: true });
    expect(await titlesUnder(root.id)).toEqual(['Welcome', 'Admissions']);
  });

  /**
   * The parent's own response carries these children in this order, and `type:` is what reaches
   * every listing showing them — tagged by type rather than by the items a query happened to match,
   * so a reorder that changes which of them a capped listing returns is covered.
   */
  it('purges the parent and every content type among its children', async () => {
    const root = await item(pageType, 'Catalog', null);
    const a = await item(pageType, 'Admissions', root.id);
    const b = await item(sectionType, 'Policies', root.id);
    h.as(contributor);

    const context = request(root.id, [b.id, a.id]);
    await reorderPost(context);

    const tags = purgedBy(context);
    expect(tags.has(itemTag(root.id))).toBe(true);
    expect(tags.has(typeTag('page'))).toBe(true);
    // Both types, not only the first one found — one level routinely holds more than one type.
    expect(tags.has(typeTag('catalog_section'))).toBe(true);
  });

  /**
   * Contributor, matching `PATCH /items/[id]`: this is an edit to content somebody may already edit
   * one item at a time, and nothing becomes visible that was not visible before.
   */
  it('refuses a viewer', async () => {
    const root = await item(pageType, 'Catalog', null);
    const a = await item(pageType, 'Admissions', root.id);
    const b = await item(pageType, 'Welcome', root.id);
    h.as(viewer);

    const response = await reorderPost(request(root.id, [b.id, a.id]));

    expect(response.status).toBe(403);
    expect(await titlesUnder(root.id)).toEqual(['Admissions', 'Welcome']);
  });

  it('refuses an anonymous request', async () => {
    const root = await item(pageType, 'Catalog', null);
    const a = await item(pageType, 'Admissions', root.id);
    const b = await item(pageType, 'Welcome', root.id);
    h.as(undefined);

    expect((await reorderPost(request(root.id, [b.id, a.id]))).status).toBe(401);
  });

  it('404s for a parent that does not exist', async () => {
    h.as(contributor);
    const response = await reorderPost(request('00000000-0000-4000-8000-000000000000', ['x']));
    expect(response.status).toBe(404);
  });

  /**
   * 409 rather than 400: the order was valid when the screen rendered it and something else has
   * since changed the level, so the client's answer is to reload. A 400 would say the request was
   * malformed, which sends somebody to look at the wrong thing.
   */
  it('answers 409 for an order that no longer matches the level', async () => {
    const root = await item(pageType, 'Catalog', null);
    const a = await item(pageType, 'Admissions', root.id);
    const b = await item(pageType, 'Welcome', root.id);
    h.as(contributor);

    const stale = [b.id, a.id];
    await item(pageType, 'Policies', root.id);

    const context = request(root.id, stale);
    const response = await reorderPost(context);

    expect(response.status).toBe(409);
    expect(await titlesUnder(root.id)).toEqual(['Admissions', 'Welcome', 'Policies']);
    // Nothing was written, so nothing should have been purged either.
    expect(purgedBy(context).size).toBe(0);
  });

  it('writes an audit entry naming the parent', async () => {
    const root = await item(pageType, 'Catalog', null);
    const a = await item(pageType, 'Admissions', root.id);
    const b = await item(pageType, 'Welcome', root.id);
    h.as(contributor);

    await reorderPost(request(root.id, [b.id, a.id]));

    const entries = await h.db.db.selectFrom('audit_log').selectAll().execute();
    const entry = entries.find((row) => row.action === 'item.reorder_children');
    expect(entry?.subject_id).toBe(root.id);
    // Copied at write time, so the entry still reads after the parent is renamed or deleted.
    expect(entry?.subject_label).toBe('Catalog');
  });
});
