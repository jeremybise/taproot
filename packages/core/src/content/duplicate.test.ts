import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createContentType, createField } from './types.js';
import { createItem, getItem, listItemSummaries } from './items.js';
import { duplicateSubtree } from './duplicate.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';

/**
 * Copying a subtree — the rollover an edition needs.
 *
 * The half worth testing hardest is **reference remapping**, because every way of getting it wrong
 * is invisible: the copy renders, every link works, and each one lands on a real page that looks
 * almost identical to the right one. Only following a link into the *previous* edition reveals it,
 * and by then the year is published. So there is a test per reference-carrying field type, and one
 * for each of the two envelopes they can be nested inside.
 */

let handle: TaprootDb;
let pageType: ContentTypeRow;
let fields: FieldRow[];

const typeInput = {
  description: null,
  icon: null,
  url_prefix: null,
  preview_path: null,
  summary_template: null,
  list_columns: null,
  list_sort: null,
  list_sort_field: null,
  default_og_image_id: null,
};

const fieldInput = {
  required: false,
  localized: false,
  help_text: null,
};

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;

  pageType = await createContentType(handle.db, {
    ...typeInput,
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
  });

  fields = [
    await createField(handle.db, pageType.id, {
      ...fieldInput,
      api_id: 'body',
      label: 'Body',
      type: 'richtext',
      position: 0,
      config: {},
    }),
    await createField(handle.db, pageType.id, {
      ...fieldInput,
      api_id: 'related',
      label: 'Related',
      type: 'relation',
      position: 1,
      config: { targetContentTypeId: pageType.id },
    }),
    await createField(handle.db, pageType.id, {
      ...fieldInput,
      api_id: 'cta',
      label: 'Call to action',
      type: 'link',
      position: 2,
      config: {},
    }),
  ];
});

async function page(title: string, parentId: string | null, data: Record<string, unknown> = {}) {
  return createItem(handle, pageType, fields, {
    contentTypeId: pageType.id,
    title,
    parentId,
    status: 'published',
    data,
  });
}

describe('duplicateSubtree', () => {
  it('copies the root and every descendant, preserving the shape', async () => {
    const root = await page('2026-27', null);
    const chapter = await page('Admissions', root.id);
    await page('Apply', chapter.id);
    await page('Policies', root.id);

    const result = await duplicateSubtree(handle, root.id, { slug: '2027-28' });

    expect(result.remaining).toBe(0);
    expect(result.root.path).toBe('/2027-28');

    const { items } = await listItemSummaries(handle.db, { pathPrefix: '/2027-28', limit: 50 });
    expect(items.map((item) => item.path).sort()).toEqual([
      '/2027-28/admissions',
      '/2027-28/admissions/apply',
      '/2027-28/policies',
    ]);
  });

  /**
   * A copy of a published page must not go live the moment it is written — the point of an edition
   * is that somebody works on it before anybody sees it.
   */
  it('lands everything as a draft, however the source was published', async () => {
    const root = await page('2026-27', null);
    await page('Admissions', root.id);

    const result = await duplicateSubtree(handle, root.id, { slug: '2027-28' });

    const copies = await listItemSummaries(handle.db, { pathPrefix: '/2027-28', limit: 50 });
    expect(result.root.status).toBe('draft');
    expect(copies.items.every((item) => item.status === 'draft')).toBe(true);
    // And the source is untouched, which is the whole freezing property.
    expect((await getItem(handle.db, root.id))?.status).toBe('published');
  });

  it('leaves the source subtree completely alone', async () => {
    const root = await page('2026-27', null);
    const chapter = await page('Admissions', root.id, { body: '<p>Original</p>' });

    await duplicateSubtree(handle, root.id, { slug: '2027-28' });

    const after = await getItem(handle.db, chapter.id);
    expect(after?.path).toBe('/2026-27/admissions');
    expect(after?.data.body).toBe('<p>Original</p>');
  });

  describe('references inside the subtree are repointed at the copies', () => {
    it('remaps a relation field', async () => {
      const root = await page('2026-27', null);
      const target = await page('Apply', root.id);
      const referrer = await page('Admissions', root.id, { related: target.id });

      const result = await duplicateSubtree(handle, root.id, { slug: '2027-28' });

      const copyOfReferrer = await itemAt('/2027-28/admissions');
      const copyOfTarget = await itemAt('/2027-28/apply');

      expect(copyOfReferrer?.data.related).toBe(copyOfTarget?.id);
      // The decisive assertion: it must not still point into last year.
      expect(copyOfReferrer?.data.related).not.toBe(target.id);
      expect(result.root.id).toBeTruthy();
      expect(referrer.id).not.toBe(copyOfReferrer?.id);
    });

    it('remaps a link field, and leaves a url link alone', async () => {
      const root = await page('2026-27', null);
      const target = await page('Apply', root.id);
      await page('Admissions', root.id, { cta: { kind: 'item', id: target.id } });
      await page('Outside', root.id, { cta: { kind: 'url', href: 'https://example.edu' } });

      await duplicateSubtree(handle, root.id, { slug: '2027-28' });

      const copy = await itemAt('/2027-28/admissions');
      const copyOfTarget = await itemAt('/2027-28/apply');
      expect((copy?.data.cta as { id: string }).id).toBe(copyOfTarget?.id);

      // A url link has no id to remap. Asserted on the two keys that carry the target rather than
      // the whole object, because the link value schema fills in `newTab`/`noFollow` defaults.
      const external = await itemAt('/2027-28/outside');
      expect(external?.data.cta).toMatchObject({ kind: 'url', href: 'https://example.edu' });
    });

    /**
     * The one a `relation`-only implementation misses most quietly: prose reads correctly and every
     * link works, it just goes to the previous edition.
     */
    it('remaps a taproot:item marker inside rich text', async () => {
      const root = await page('2026-27', null);
      const target = await page('Apply', root.id);
      await page('Admissions', root.id, {
        body: `<p>See <a href="taproot:item:${target.id}">how to apply</a>.</p>`,
      });

      await duplicateSubtree(handle, root.id, { slug: '2027-28' });

      const copy = await itemAt('/2027-28/admissions');
      const copyOfTarget = await itemAt('/2027-28/apply');

      expect(copy?.data.body).toContain(`taproot:item:${copyOfTarget?.id}`);
      expect(copy?.data.body).not.toContain(target.id);
      // The marker survives as a marker — writing a path here would freeze the link.
      expect(copy?.data.body).toContain('taproot:item:');
    });

    it('leaves a reference pointing outside the subtree exactly as it was', async () => {
      const outside = await page('Elsewhere', null);
      const root = await page('2026-27', null);
      await page('Admissions', root.id, {
        related: outside.id,
        body: `<p><a href="taproot:item:${outside.id}">Elsewhere</a></p>`,
      });

      await duplicateSubtree(handle, root.id, { slug: '2027-28' });

      const copy = await itemAt('/2027-28/admissions');
      expect(copy?.data.related).toBe(outside.id);
      expect(copy?.data.body).toContain(`taproot:item:${outside.id}`);
    });

    /**
     * A link *forward* in the book — to a page copied after its referrer.
     *
     * The copy loop cannot remap against an id it has not minted yet, which is what the repair pass
     * exists for. Without it this test finds the referrer still pointing at last year.
     */
    it('remaps a reference to a page copied later in the walk', async () => {
      const root = await page('2026-27', null);
      // "Appendix" sorts after "Admissions", so it is created second and copied second.
      const appendix = await page('Appendix', root.id);
      await page('Admissions', root.id, { related: appendix.id });

      // Force the forward-reference case regardless of ordering by pointing the *first* chapter at
      // the last one.
      await duplicateSubtree(handle, root.id, { slug: '2027-28' });

      const copy = await itemAt('/2027-28/admissions');
      const copyOfAppendix = await itemAt('/2027-28/appendix');
      expect(copy?.data.related).toBe(copyOfAppendix?.id);
    });

    it('remaps a reference nested inside a repeater row', async () => {
      const withRepeater = await createField(handle.db, pageType.id, {
        ...fieldInput,
        api_id: 'rows',
        label: 'Rows',
        type: 'repeater',
        position: 3,
        config: {
          fields: [
            { api_id: 'link', label: 'Link', type: 'link', required: false, config: {} },
          ],
        },
      });
      const allFields = [...fields, withRepeater];

      const root = await createItem(handle, pageType, allFields, {
        contentTypeId: pageType.id,
        title: '2026-27',
        status: 'published',
      });
      const target = await createItem(handle, pageType, allFields, {
        contentTypeId: pageType.id,
        title: 'Apply',
        parentId: root.id,
        status: 'published',
      });
      await createItem(handle, pageType, allFields, {
        contentTypeId: pageType.id,
        title: 'Admissions',
        parentId: root.id,
        status: 'published',
        data: { rows: [{ id: 'row-1', data: { link: { kind: 'item', id: target.id } } }] },
      });

      await duplicateSubtree(handle, root.id, { slug: '2027-28' });

      const copy = await itemAt('/2027-28/admissions');
      const copyOfTarget = await itemAt('/2027-28/apply');
      const rows = copy?.data.rows as { id: string; data: { link: { id: string } } }[];

      expect(rows[0]!.data.link.id).toBe(copyOfTarget?.id);
      // And the row's own id is re-minted, because an id should identify one thing.
      expect(rows[0]!.id).not.toBe('row-1');
    });
  });

  describe('chunking', () => {
    it('stops at the limit and reports what is left, then finishes on a second call', async () => {
      const root = await page('2026-27', null);
      for (const title of ['A', 'B', 'C', 'D']) await page(title, root.id);

      const first = await duplicateSubtree(handle, root.id, { slug: '2027-28', limit: 2 });
      expect(first.created).toBe(2);
      expect(first.remaining).toBeGreaterThan(0);

      let guard = 0;
      let remaining = first.remaining;
      while (remaining > 0 && guard < 10) {
        const next = await duplicateSubtree(handle, root.id, { slug: '2027-28', limit: 2 });
        remaining = next.remaining;
        guard += 1;
      }

      expect(remaining).toBe(0);
      const { items } = await listItemSummaries(handle.db, { pathPrefix: '/2027-28', limit: 50 });
      expect(items).toHaveLength(4);
    });

    /**
     * Resuming needs no bookkeeping table: an item is already copied when something exists at its
     * mapped path. So a second full run adds nothing rather than doubling the book.
     */
    it('is idempotent — running it again creates nothing new', async () => {
      const root = await page('2026-27', null);
      await page('Admissions', root.id);

      const first = await duplicateSubtree(handle, root.id, { slug: '2027-28' });
      const second = await duplicateSubtree(handle, root.id, { slug: '2027-28' });

      expect(first.root.id).toBe(second.root.id);
      expect(second.remaining).toBe(0);

      const { total } = await listItemSummaries(handle.db, { pathPrefix: '/2027-28', limit: 50 });
      expect(total).toBe(1);
    });
  });

  it('refuses a kind that has no subtree', async () => {
    const collection = await createContentType(handle.db, {
      ...typeInput,
      api_id: 'event',
      name: 'Event',
      name_plural: 'Events',
      kind: 'collection',
      url_prefix: 'events',
    });
    const item = await createItem(handle, collection, [], {
      contentTypeId: collection.id,
      title: 'Open day',
    });

    await expect(duplicateSubtree(handle, item.id)).rejects.toMatchObject({
      code: 'invalid_target',
    });
  });

  it('refuses an item that does not exist', async () => {
    await expect(duplicateSubtree(handle, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

async function itemAt(path: string) {
  const row = await handle.db
    .selectFrom('content_items')
    .select('id')
    .where('path', '=', path)
    .executeTakeFirst();
  return row ? getItem(handle.db, row.id) : undefined;
}
