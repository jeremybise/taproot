import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createContentType, createField } from './types.js';
import { createItem } from './items.js';
import { resolveDelivery } from './delivery.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';

/**
 * A relation that carries its target's field values.
 *
 * The case it exists for: a marketing program page rendering the curriculum stored on its catalog
 * entry. Without it the page has a title and a URL and has to fetch every entry of that type to use
 * one — which is the round trip the delivery API exists to remove.
 *
 * Three properties are load-bearing and each has a plausible wrong answer: it is **off by default**,
 * it strips `block` and `query` exactly as a query result does, and it applies the **same visibility
 * predicate** as a bare reference — a relation carrying data must not become the one path that leaks
 * an unpublished page's fields.
 */

let handle: TaprootDb;
let programType: ContentTypeRow;
let entryType: ContentTypeRow;
let entryFields: FieldRow[];

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

const fieldInput = { required: false, localized: false, help_text: null };

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;

  entryType = await createContentType(handle.db, {
    ...typeInput,
    api_id: 'catalog_entry',
    name: 'Catalog entry',
    name_plural: 'Catalog entries',
    kind: 'page',
  });

  entryFields = [
    await createField(handle.db, entryType.id, {
      ...fieldInput,
      api_id: 'award',
      label: 'Award',
      type: 'text',
      position: 0,
      config: {},
    }),
  ];

  programType = await createContentType(handle.db, {
    ...typeInput,
    api_id: 'program',
    name: 'Program',
    name_plural: 'Programs',
    kind: 'page',
  });
});

async function relationField(includeData: boolean) {
  return createField(handle.db, programType.id, {
    ...fieldInput,
    api_id: 'catalog_entry',
    label: 'Catalog entry',
    type: 'relation',
    position: 0,
    config: { targetContentTypeId: entryType.id, includeData },
  });
}

async function entry(title: string, status: 'published' | 'draft' = 'published') {
  return createItem(handle, entryType, entryFields, {
    contentTypeId: entryType.id,
    title,
    status,
    data: { award: 'AAS' },
  });
}

async function resolveProgram(fields: FieldRow[], targetId: string) {
  const program = await createItem(handle, programType, fields, {
    contentTypeId: programType.id,
    title: 'Nursing',
    status: 'published',
    data: { catalog_entry: targetId },
  });

  const result = await resolveDelivery(handle.db, program.path, {
    origin: 'https://example.edu',
    storage: undefined as never,
  });

  if (result.kind !== 'item') throw new Error('expected an item');
  return result;
}

describe('a relation carrying its target data', () => {
  it('sends only a name and a path by default', async () => {
    const fields = [await relationField(false)];
    const target = await entry('Nursing AAS');

    const result = await resolveProgram(fields, target.id);
    const ref = result.references[target.id];

    expect(ref?.title).toBe('Nursing AAS');
    expect(ref?.path).toBeTruthy();
    // The default is the point: a "see also" list must not start paying for page bodies.
    expect(ref?.data).toBeUndefined();
  });

  it('sends the target’s fields when the config asks', async () => {
    const fields = [await relationField(true)];
    const target = await entry('Nursing AAS');

    const result = await resolveProgram(fields, target.id);
    const ref = result.references[target.id];

    expect(ref?.title).toBe('Nursing AAS');
    expect(ref?.data).toEqual({ award: 'AAS' });
  });

  /**
   * The rule every other delivered result already follows. A relation target's page composition is
   * not a card, and stripping `query` is what bounds the recursion.
   */
  it('strips block and query fields, exactly as a query result does', async () => {
    await createField(handle.db, entryType.id, {
      ...fieldInput,
      api_id: 'sections',
      label: 'Sections',
      type: 'block',
      position: 1,
      config: {},
    });
    await createField(handle.db, entryType.id, {
      ...fieldInput,
      api_id: 'listing',
      label: 'Listing',
      type: 'query',
      position: 2,
      config: { targetContentTypeId: entryType.id },
    });

    const fields = [await relationField(true)];
    const target = await entry('Nursing AAS');

    const result = await resolveProgram(fields, target.id);
    const data = result.references[target.id]?.data ?? {};

    expect(data).toHaveProperty('award');
    expect(data).not.toHaveProperty('sections');
    expect(data).not.toHaveProperty('listing');
  });

  /**
   * The one that would be a security bug rather than a missing feature.
   *
   * **Two independent gates hold this, and the mutation test says so.** Hydration filters on
   * `visibleToPublic`, *and* the merge only attaches `data` to an id `loadItemReferences` already
   * returned. Removing either one alone leaves this green — verified by doing it — so this asserts
   * the property a visitor cares about rather than one mechanism: a draft's field values appear
   * nowhere in the payload. See `hydrateRelationTargets` for why the redundancy is deliberate.
   */
  it('will not hydrate an unpublished target', async () => {
    const fields = [await relationField(true)];
    const target = await entry('Next year', 'draft');

    const result = await resolveProgram(fields, target.id);

    // Not in the map at all, because a draft is not a visible reference either.
    expect(result.references[target.id]).toBeUndefined();

    /**
     * And none of its *values* appear anywhere in the payload — which is the claim that matters.
     *
     * The id itself is still there, in the host item's own `data`, and that is correct: `data` keeps
     * the stored shape so the payload stays usable for a write. What a draft must never leak is its
     * title and its fields.
     */
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Next year');
    expect(serialised).not.toContain('AAS');
  });

  it('resolves the target’s own media through the payload’s maps, one level deep', async () => {
    await createField(handle.db, entryType.id, {
      ...fieldInput,
      api_id: 'related',
      label: 'Related',
      type: 'relation',
      position: 1,
      config: { targetContentTypeId: entryType.id },
    });

    const fields = [await relationField(true)];
    const second = await entry('Second');
    const target = await createItem(handle, entryType, await entryFieldsNow(), {
      contentTypeId: entryType.id,
      title: 'Nursing AAS',
      status: 'published',
      data: { award: 'AAS', related: second.id },
    });

    const result = await resolveProgram(fields, target.id);

    // The hydrated target's own relation id resolves through the same `references` map — one level,
    // so `second` is a bare ref rather than hydrated in turn.
    expect(result.references[target.id]?.data).toMatchObject({ related: second.id });
    expect(result.references[second.id]?.title).toBe('Second');
    expect(result.references[second.id]?.data).toBeUndefined();
  });
});

/** The entry type's fields as they stand now, including any added mid-test. */
async function entryFieldsNow(): Promise<FieldRow[]> {
  const rows = await handle.db
    .selectFrom('fields')
    .selectAll()
    .where('content_type_id', '=', entryType.id)
    .orderBy('position')
    .execute();
  return rows as FieldRow[];
}
