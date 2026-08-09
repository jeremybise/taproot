import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';
import { createContentType, createField } from './types.js';
import { createItem, deleteItem, getItem, getRedirect, restoreRevision, updateItem } from './items.js';
import { listRevisions, revisionChanges, revisionSequence } from './revisions.js';

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

async function seedPageType(): Promise<{ type: ContentTypeRow; fields: FieldRow[] }> {
  const type = await createContentType(handle.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    summary_template: '{{ title }}',
  });

  const body = await createField(handle.db, type.id, {
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

describe('revision creation', () => {
  it('records the item as it was created', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
      data: { body: 'first draft' },
    });

    const { revisions, total } = await listRevisions(handle.db, item.id);
    expect(total).toBe(1);
    expect(revisions[0]).toMatchObject({
      revision_number: 1,
      title: 'Admissions',
      slug: 'admissions',
      status: 'draft',
      reason: 'create',
      restored_from: null,
    });
    expect(revisions[0]!.data).toEqual({ body: 'first draft' });
  });

  it('appends a revision on every save, numbered monotonically', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
      data: { body: 'v1' },
    });

    await updateItem(handle, type, fields, item.id, { data: { body: 'v2' } });
    await updateItem(handle, type, fields, item.id, { data: { body: 'v3' } });

    const { revisions } = await listRevisions(handle.db, item.id);
    // Newest first — history is read from the present backwards.
    expect(revisions.map((r) => r.revision_number)).toEqual([3, 2, 1]);
    expect(revisions.map((r) => r.data.body)).toEqual(['v3', 'v2', 'v1']);
    expect(revisions[0]!.reason).toBe('save');
  });

  it('snapshots the state after the save, not the state it replaced', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
      data: { body: 'v1' },
    });

    await updateItem(handle, type, fields, item.id, { data: { body: 'v2' } });

    const { revisions } = await listRevisions(handle.db, item.id);
    // Revision 2 is what the item became, so restoring it is a no-op rather than a rewind.
    expect(revisions.find((r) => r.revision_number === 2)!.data).toEqual({ body: 'v2' });
  });

  it('does not append when a save changes nothing', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
      data: { body: 'v1' },
    });

    // An editor opening an item and saving without edits is common; a history full of identical
    // entries buries the saves that meant something.
    await updateItem(handle, type, fields, item.id, { title: 'Admissions', data: { body: 'v1' } });

    expect((await listRevisions(handle.db, item.id)).total).toBe(1);
  });

  it('records a status change even when the content is untouched', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
      data: { body: 'v1' },
    });

    await updateItem(handle, type, fields, item.id, { status: 'published' });

    const { revisions, total } = await listRevisions(handle.db, item.id);
    expect(total).toBe(2);
    expect(revisions[0]!.status).toBe('published');
  });

  it('backfills a snapshot for an item that predates its history', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
      data: { body: 'v1' },
    });

    // Stand in for a row seeded before the revisions table existed.
    await handle.db.deleteFrom('revisions').where('content_item_id', '=', item.id).execute();

    // An unchanged save would normally skip — but with no history at all there is nothing to diff
    // against later, so the current state gets written as the floor.
    await updateItem(handle, type, fields, item.id, { title: 'Admissions', data: { body: 'v1' } });

    const { revisions, total } = await listRevisions(handle.db, item.id);
    expect(total).toBe(1);
    expect(revisions[0]!.data).toEqual({ body: 'v1' });
  });

  it('deletes an item’s revisions along with the item', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
    });

    await deleteItem(handle, item.id);

    expect((await revisionSequence(handle.db, item.id)).count).toBe(0);
  });

  it('refuses two revisions sharing a number on one item', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
    });

    // The next number is computed before the batch is submitted, because a batch cannot read its
    // own writes. Two racing saves would compute the same number; the unique index has to be what
    // stops that, or "restore revision 2" becomes ambiguous forever.
    await expect(
      handle.db
        .insertInto('revisions')
        .values({
          id: 'duplicate',
          content_item_id: item.id,
          revision_number: 1,
          title: 'Admissions',
          slug: 'admissions',
          path: '/admissions',
          status: 'draft',
          data: '{}',
          seo: '{}',
          reason: 'save',
          restored_from: null,
          created_by: null,
          created_at: new Date().toISOString(),
        })
        .execute(),
    ).rejects.toThrow();
  });
});

describe('restore', () => {
  it('brings back earlier content and appends rather than rewinding', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
      data: { body: 'v1' },
    });
    await updateItem(handle, type, fields, item.id, { data: { body: 'v2' } });

    const { revisions } = await listRevisions(handle.db, item.id);
    const first = revisions.find((r) => r.revision_number === 1)!;

    const restored = await restoreRevision(handle, type, fields, item.id, first.id);
    expect(restored.data).toEqual({ body: 'v1' });

    const after = await listRevisions(handle.db, item.id);
    // Three entries, not one: restoring the wrong revision has to be undoable too.
    expect(after.total).toBe(3);
    expect(after.revisions[0]).toMatchObject({
      revision_number: 3,
      reason: 'restore',
      restored_from: 1,
    });
  });

  it('cascades paths and writes a redirect when the restored slug differs', async () => {
    const { type, fields } = await seedPageType();
    const parent = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Admissions',
    });
    const child = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Apply',
      parentId: parent.id,
    });

    const original = (await listRevisions(handle.db, parent.id)).revisions[0]!;

    await updateItem(handle, type, fields, parent.id, { slug: 'admission' });
    expect((await getItem(handle.db, child.id))!.path).toBe('/admission/apply');

    // The restore moves the page back, so the subtree and its redirects have to move with it.
    // Writing the snapshot's row back verbatim would restore the content and strand the children.
    await restoreRevision(handle, type, fields, parent.id, original.id);

    expect((await getItem(handle.db, parent.id))!.path).toBe('/admissions');
    expect((await getItem(handle.db, child.id))!.path).toBe('/admissions/apply');
    expect(await getRedirect(handle.db, '/admission/apply')).toMatchObject({
      to: '/admissions/apply',
    });
  });

  it('refuses a revision belonging to a different item', async () => {
    const { type, fields } = await seedPageType();
    const a = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'A' });
    const b = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'B' });

    const bRevision = (await listRevisions(handle.db, b.id)).revisions[0]!;

    await expect(
      restoreRevision(handle, type, fields, a.id, bRevision.id),
    ).rejects.toThrow(/different content item/);
  });

  it('reports a missing revision rather than silently doing nothing', async () => {
    const { type, fields } = await seedPageType();
    const item = await createItem(handle, type, fields, { contentTypeId: type.id, title: 'A' });

    await expect(
      restoreRevision(handle, type, fields, item.id, 'nope'),
    ).rejects.toThrow(/not found/);
  });
});

describe('revisionChanges', () => {
  const fields = [
    { api_id: 'body', label: 'Body' },
    { api_id: 'summary', label: 'Summary' },
  ] as FieldRow[];

  it('names the item columns that changed', () => {
    const changes = revisionChanges(
      { title: 'A', slug: 'a', status: 'draft', data: {} },
      { title: 'B', slug: 'b', status: 'published', data: {} },
      fields,
    );
    expect(changes.map((c) => c.label)).toEqual(['Title', 'Slug', 'Status']);
  });

  it('names changed fields by their label', () => {
    const changes = revisionChanges(
      { title: 'A', slug: 'a', status: 'draft', data: { body: 'one', summary: 'same' } },
      { title: 'A', slug: 'a', status: 'draft', data: { body: 'two', summary: 'same' } },
      fields,
    );
    expect(changes).toEqual([{ label: 'Body', fieldApiId: 'body' }]);
  });

  it('treats an absent value and an explicit null as the same', () => {
    const changes = revisionChanges(
      { title: 'A', slug: 'a', status: 'draft', data: {} },
      { title: 'A', slug: 'a', status: 'draft', data: { body: null } },
      fields,
    );
    expect(changes).toEqual([]);
  });

  it('has nothing to report against a missing predecessor', () => {
    expect(
      revisionChanges(undefined, { title: 'A', slug: 'a', status: 'draft', data: {} }, fields),
    ).toEqual([]);
  });
});
