import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createContentType, createField } from './types.js';
import { createItem, listItems, updateItem } from './items.js';
import { planValueIndex, reindexValues } from './derivedIndex.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';

/**
 * The derived value index.
 *
 * Two things are being defended. **Type-correct comparison** — the whole reason there are three
 * value columns rather than one, because `'10' < '9'` is true as text and a numeric ordering that is
 * wrong in a plausible-looking way is worse than one that is obviously broken. And **no stale
 * rows** — the index is rebuilt from `data` on every write, so a value removed from an item, or a
 * field removed from its type, has to disappear from here too; a stale row is invisible until it
 * wrongly answers a listing.
 */

let handle: TaprootDb;
let type: ContentTypeRow;
let fields: FieldRow[];

async function rows(itemId: string) {
  return handle.db
    .selectFrom('content_item_values')
    .selectAll()
    .where('content_item_id', '=', itemId)
    .orderBy('field_api_id')
    .execute();
}

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const migrated = await migrateToLatest(handle.db);
  if (migrated.error) throw migrated.error;

  type = await createContentType(handle.db, {
    api_id: 'thing',
    name: 'Thing',
    name_plural: 'Things',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    title_field: 'title',
  });

  const defs = [
    { api_id: 'rank', label: 'Rank', type: 'number', config: { integer: true } },
    { api_id: 'featured', label: 'Featured', type: 'boolean', config: {} },
    { api_id: 'starts_at', label: 'Starts', type: 'date', config: { includeTime: true } },
    { api_id: 'blurb', label: 'Blurb', type: 'text', config: {} },
    {
      api_id: 'audience',
      label: 'Audience',
      type: 'select',
      config: { multiple: true, options: [{ label: 'Staff', value: 'staff' }, { label: 'Alumni', value: 'alumni' }] },
    },
    { api_id: 'body', label: 'Body', type: 'richtext', config: {} },
  ] as const;

  fields = [];
  for (const def of defs) {
    fields.push(
      await createField(handle.db, type.id, {
        api_id: def.api_id,
        label: def.label,
        type: def.type,
        required: false,
        localized: false,
        help_text: null,
        config: def.config as Record<string, unknown>,
      }),
    );
  }
});

async function make(slug: string, data: Record<string, unknown>) {
  return createItem(handle, type, fields, {
    contentTypeId: type.id,
    title: slug,
    slug,
    parentId: null,
    status: 'published',
    data,
    seo: {},
    userId: null,
  });
}

describe('what gets indexed', () => {
  it('writes one row per scalar value and skips the rest', async () => {
    const item = await make('a', {
      rank: 3,
      featured: true,
      starts_at: '2030-05-01T09:00:00.000Z',
      blurb: 'Hello',
      audience: ['staff', 'alumni'],
      // Prose is what the search index is for; nothing filters or orders by a body.
      body: '<p>Not indexed</p>',
    });

    const indexed = await rows(item.id);
    const byField = new Map(indexed.map((row) => [row.field_api_id, row]));

    expect(byField.get('rank')?.value_num).toBe(3);
    // Booleans as 0/1, so a numeric range and a checkbox share one column.
    expect(byField.get('featured')?.value_num).toBe(1);
    expect(byField.get('starts_at')?.value_date).toBe('2030-05-01T09:00:00.000Z');
    expect(byField.get('blurb')?.value_text).toBe('Hello');
    expect(indexed.some((row) => row.field_api_id === 'body')).toBe(false);

    // A multi-value select is several rows, so "audience is alumni" matches an item also aimed at
    // staff rather than only one whose sole value is alumni.
    expect(indexed.filter((row) => row.field_api_id === 'audience')).toHaveLength(2);
  });

  it('normalises a date so a day and a timestamp compare as one thing', async () => {
    /**
     * A `date` field with `includeTime` off stores `2030-05-01`. As raw text that sorts *before*
     * `2030-05-01T09:00:00Z`, which would drop an all-day event out of a window it belongs in.
     */
    const item = await make('b', { starts_at: '2030-05-01' });
    const indexed = await rows(item.id);

    expect(indexed[0]!.value_date).toBe(new Date('2030-05-01').toISOString());
  });

  it('skips a value it cannot make sense of rather than throwing', () => {
    /**
     * Tested against the planner directly, because `createItem` refuses this data — as it should.
     * The tolerance is for values that never went through today's validation: a field retyped from
     * text to number leaves old strings in `data`, and the planner runs over whatever is stored.
     * Dropping the value costs one unindexed field; throwing would make the item unsavable.
     */
    const statements = planValueIndex(handle.db, 'item-1', fields, {
      rank: 'not a number',
      blurb: '',
      starts_at: 'the fourteenth',
    });

    // The unconditional delete, and no insert — nothing survived to index.
    expect(statements).toHaveLength(1);
  });
});

describe('sorting through the index', () => {
  it('orders numbers numerically, where text would put 10 before 9', async () => {
    // The bug the three columns exist to prevent, and the one that looks plausible on screen.
    await make('nine', { rank: 9 });
    await make('ten', { rank: 10 });
    await make('one', { rank: 1 });

    const { items } = await listItems(handle.db, {
      contentTypeId: type.id,
      sort: 'field_asc',
      sortField: { apiId: 'rank', kind: 'number' },
    });

    expect(items.map((item) => item.title)).toEqual(['one', 'nine', 'ten']);
  });

  it('keeps items with no value for the field rather than dropping them', async () => {
    /**
     * A correlated subquery rather than a join, deliberately. A join would silently remove every
     * item whose date nobody filled in — which reads as content going missing, not as a listing
     * being ordered.
     */
    await make('dated', { starts_at: '2030-01-01T00:00:00.000Z' });
    await make('undated', {});

    const { items, total } = await listItems(handle.db, {
      contentTypeId: type.id,
      sort: 'field_asc',
      sortField: { apiId: 'starts_at', kind: 'date' },
    });

    expect(total).toBe(2);
    expect(items.map((item) => item.title).sort()).toEqual(['dated', 'undated']);
  });
});

describe('staying in step with the item', () => {
  it('drops a value the item no longer has', async () => {
    const item = await make('d', { rank: 5, blurb: 'Here' });
    expect(await rows(item.id)).toHaveLength(2);

    await updateItem(handle, type, fields, item.id, { data: { blurb: 'Here' }, userId: null });

    const after = await rows(item.id);
    expect(after.map((row) => row.field_api_id)).toEqual(['blurb']);
  });

  it('removes every row when the item is deleted', async () => {
    // `ON DELETE CASCADE`: the index is derived, so it has no meaning once its subject is gone —
    // unlike the audit log, there is no evidence here worth outliving the item.
    const item = await make('e', { rank: 5 });
    await handle.db.deleteFrom('content_items').where('id', '=', item.id).execute();

    expect(await rows(item.id)).toHaveLength(0);
  });

  it('rebuilds unconditionally, so a removed field strands nothing', () => {
    // The delete is not conditional on there being replacements — otherwise dropping a field from
    // a content type would leave its rows answering listings forever.
    const statements = planValueIndex(handle.db, 'item-1', [], {});
    expect(statements).toHaveLength(1);
    expect(statements[0]!.compile().sql).toMatch(/delete from "content_item_values"/i);
  });
});

describe('reindexing', () => {
  it('backfills content written before the index existed', async () => {
    /**
     * Required after the migration rather than optional: the table is created empty, so until this
     * runs every query field answers nothing. A migration cannot do it — it needs each content
     * type's field definitions and a walk over stored JSON.
     */
    const item = await make('f', { rank: 7 });
    await handle.db.deleteFrom('content_item_values').execute();
    expect(await rows(item.id)).toHaveLength(0);

    const result = await reindexValues(handle);

    expect(result.items).toBe(1);
    expect((await rows(item.id))[0]!.value_num).toBe(7);
  });

  it('is idempotent, so running it twice is safe', async () => {
    const item = await make('g', { rank: 7, blurb: 'Hi' });
    await reindexValues(handle);
    await reindexValues(handle);

    expect(await rows(item.id)).toHaveLength(2);
  });
});
