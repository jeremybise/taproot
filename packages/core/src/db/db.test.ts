import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from './client.js';
import { migrateToLatest } from './migrations/index.js';
import { now, stringifyJson, toSqlValue, parseJson, toBool } from './values.js';

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

const t = () => now();

async function seedPageType() {
  const ts = t();
  await handle.db
    .insertInto('content_types')
    .values({
      id: 'ct1',
      api_id: 'page',
      name: 'Page',
      name_plural: 'Pages',
      kind: 'page',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: 'title',
      created_at: ts,
      updated_at: ts,
    })
    .execute();
}

function item(id: string, slug: string, parentId: string | null, path: string, depth: number) {
  const ts = t();
  return {
    id,
    content_type_id: 'ct1',
    slug,
    parent_id: parentId,
    path,
    depth,
    position: 0,
    status: 'published' as const,
    title: slug,
    data: '{}',
    seo: '{}',
    published_at: ts,
    created_by: null,
    updated_by: null,
    created_at: ts,
    updated_at: ts,
  };
}

describe('migrations', () => {
  it('applies the initial migration', async () => {
    const fresh = await createDb({ driver: 'sqlite', location: ':memory:' });
    const result = await migrateToLatest(fresh.db);
    expect(result.error).toBeUndefined();
    expect(result.applied).toContain('0001_init');
    await fresh.destroy();
  });

  it('is idempotent — re-running applies nothing', async () => {
    const second = await migrateToLatest(handle.db);
    expect(second.error).toBeUndefined();
    expect(second.applied).toEqual([]);
  });
});

describe('parameter coercion', () => {
  // node:sqlite rejects JS booleans outright, so the driver must coerce them.
  it('coerces booleans to integers', () => {
    expect(toSqlValue(true)).toBe(1);
    expect(toSqlValue(false)).toBe(0);
  });

  it('coerces undefined and null to null', () => {
    expect(toSqlValue(undefined)).toBeNull();
    expect(toSqlValue(null)).toBeNull();
  });

  it('coerces Date to an ISO string', () => {
    expect(toSqlValue(new Date('2026-07-28T12:00:00.000Z'))).toBe('2026-07-28T12:00:00.000Z');
  });

  it('rejects plain objects rather than silently stringifying them', () => {
    expect(() => toSqlValue({ a: 1 })).toThrow(/stringified by the repository/);
  });

  it('accepts a real boolean through the full driver path', async () => {
    await seedPageType();
    const ts = t();
    await handle.db
      .insertInto('fields')
      .values({
        id: 'f1',
        content_type_id: 'ct1',
        api_id: 'body',
        label: 'Body',
        type: 'richtext',
        help_text: null,
        position: 0,
        // Passed as a genuine boolean — this throws at the driver without coercion.
        required: true as unknown as number,
        localized: false as unknown as number,
        config: stringifyJson({}),
        created_at: ts,
        updated_at: ts,
      })
      .execute();

    const row = await handle.db.selectFrom('fields').selectAll().executeTakeFirstOrThrow();
    expect(row.required).toBe(1);
    expect(toBool(row.required)).toBe(true);
  });
});

describe('json helpers', () => {
  it('round-trips', () => {
    expect(parseJson(stringifyJson({ a: 1 }), {})).toEqual({ a: 1 });
  });

  it('falls back rather than throwing on malformed json', () => {
    // A corrupt data blob must not take down an entire admin list view.
    expect(parseJson('{not json', { fallback: true })).toEqual({ fallback: true });
  });
});

describe('hierarchical paths', () => {
  beforeEach(seedPageType);

  it('lets the same slug live under different parents', async () => {
    await handle.db
      .insertInto('content_items')
      .values([
        item('a', 'admissions', null, '/admissions', 0),
        item('b', 'financial-aid', null, '/financial-aid', 0),
        item('c', 'apply', 'a', '/admissions/apply', 1),
        item('d', 'apply', 'b', '/financial-aid/apply', 1),
      ])
      .execute();

    const paths = await handle.db
      .selectFrom('content_items')
      .select('path')
      .orderBy('path')
      .execute();

    expect(paths.map((p) => p.path)).toContain('/admissions/apply');
    expect(paths.map((p) => p.path)).toContain('/financial-aid/apply');
  });

  it('rejects duplicate slugs under the same parent', async () => {
    await handle.db
      .insertInto('content_items')
      .values([item('a', 'admissions', null, '/admissions', 0), item('c', 'apply', 'a', '/admissions/apply', 1)])
      .execute();

    await expect(
      handle.db.insertInto('content_items').values(item('e', 'apply', 'a', '/admissions/apply-2', 1)).execute(),
    ).rejects.toThrow();
  });

  it('rejects duplicate slugs among root items', async () => {
    // The NULL-parent case: a plain unique index on (parent_id, slug) would let this through,
    // because NULL never equals NULL in SQL.
    await handle.db.insertInto('content_items').values(item('a', 'admissions', null, '/admissions', 0)).execute();

    await expect(
      handle.db.insertInto('content_items').values(item('f', 'admissions', null, '/admissions-2', 0)).execute(),
    ).rejects.toThrow();
  });

  it('rejects duplicate paths outright', async () => {
    await handle.db.insertInto('content_items').values(item('a', 'x', null, '/shared', 0)).execute();
    await expect(
      handle.db.insertInto('content_items').values(item('b', 'y', null, '/shared', 0)).execute(),
    ).rejects.toThrow();
  });

  it('resolves a path in one lookup, as the public route does', async () => {
    await handle.db
      .insertInto('content_items')
      .values([item('a', 'admissions', null, '/admissions', 0), item('c', 'apply', 'a', '/admissions/apply', 1)])
      .execute();

    const hit = await handle.db
      .selectFrom('content_items')
      .selectAll()
      .where('path', '=', '/admissions/apply')
      .executeTakeFirst();

    expect(hit?.id).toBe('c');
  });

  it('reads a whole subtree with a recursive CTE', async () => {
    // This is the read half of a cascading move: WITH RECURSIVE works on both drivers,
    // which is what makes re-parenting implementable rather than special-cased away.
    await handle.db
      .insertInto('content_items')
      .values([
        item('a', 'admissions', null, '/admissions', 0),
        item('c', 'apply', 'a', '/admissions/apply', 1),
        item('g', 'deadlines', 'c', '/admissions/apply/deadlines', 2),
        item('z', 'unrelated', null, '/unrelated', 0),
      ])
      .execute();

    const result = await sql<{ id: string; path: string; depth: number }>`
      WITH RECURSIVE subtree(id, path, depth) AS (
        SELECT id, path, depth FROM content_items WHERE id = 'a'
        UNION ALL
        SELECT c.id, c.path, c.depth FROM content_items c JOIN subtree s ON c.parent_id = s.id
      )
      SELECT * FROM subtree ORDER BY depth
    `.execute(handle.db);

    expect(result.rows.map((r) => r.path)).toEqual([
      '/admissions',
      '/admissions/apply',
      '/admissions/apply/deadlines',
    ]);
  });
});

describe('batchWrite', () => {
  it('rolls back completely when any statement fails', async () => {
    const ts = t();
    const redirect = (id: string, from: string, to: string) =>
      handle.db.insertInto('redirects').values({
        id,
        from_path: from,
        to_path: to,
        status_code: 301,
        source: 'auto' as const,
        content_item_id: null,
        created_at: ts,
      });

    // Both rows claim the same from_path, which is unique — the second must abort the batch.
    await expect(
      handle.batch([redirect('r1', '/old', '/new'), redirect('r2', '/old', '/other')]),
    ).rejects.toThrow();

    const count = await handle.db
      .selectFrom('redirects')
      .select(handle.db.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();

    expect(Number(count.n)).toBe(0);
  });

  it('commits every statement when all succeed', async () => {
    const ts = t();
    await handle.batch([
      handle.db.insertInto('redirects').values({
        id: 'r1',
        from_path: '/old',
        to_path: '/new',
        status_code: 301,
        source: 'auto' as const,
        content_item_id: null,
        created_at: ts,
      }),
      handle.db.insertInto('redirects').values({
        id: 'r2',
        from_path: '/older',
        to_path: '/new',
        status_code: 301,
        source: 'auto' as const,
        content_item_id: null,
        created_at: ts,
      }),
    ]);

    const count = await handle.db
      .selectFrom('redirects')
      .select(handle.db.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();

    expect(Number(count.n)).toBe(2);
  });

  it('treats an empty statement list as a no-op', async () => {
    await expect(handle.batch([])).resolves.toBeUndefined();
  });
});
