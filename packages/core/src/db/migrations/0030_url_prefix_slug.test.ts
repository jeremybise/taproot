import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../client.js';
import { migrateToLatest } from './index.js';
import { now } from '../values.js';
import { up as repairUrlPrefixes } from './0030_url_prefix_slug.js';

/**
 * The repair is exercised by calling the migration's `up` directly against rows written after it
 * has already run. Inserting first and migrating afterwards is not available — `migrateToLatest`
 * runs the whole set, so there is no point in time where the table exists and this migration has
 * not been applied. Writing the bad rows straight to the table is also the *only* way to produce
 * them now that the fallback is fixed, which is the honest reproduction: they were always written
 * by code rather than typed.
 */
let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

async function insertType(id: string, apiId: string, urlPrefix: string | null) {
  const ts = now();
  await handle.db
    .insertInto('content_types')
    .values({
      id,
      api_id: apiId,
      name: apiId,
      name_plural: `${apiId}s`,
      kind: 'collection',
      description: null,
      icon: null,
      url_prefix: urlPrefix,
      summary_template: null,
      created_at: ts,
      updated_at: ts,
    })
    .execute();
}

async function prefixOf(id: string): Promise<string | null> {
  const row = await handle.db
    .selectFrom('content_types')
    .select('url_prefix')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.url_prefix;
}

/** `isValidSlug`'s rule, which is also what `contentTypeInputSchema` applies to a typed prefix. */
const VALID_PREFIX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('0030_url_prefix_slug', () => {
  it('repairs an api_id-shaped prefix into one the validator accepts', async () => {
    await insertType('t1', 'alum_profile', 'alum_profile');

    await repairUrlPrefixes(handle.db);

    expect(await prefixOf('t1')).toBe('alum-profile');
    expect(VALID_PREFIX.test((await prefixOf('t1'))!)).toBe(true);
  });

  /*
   * `alum__profile` and `alum_` are both legal `api_id`s, and a naive `replace(_, -)` leaves
   * `alum--profile` and `alum-` — still invalid, so the screen would stay unusable after a
   * migration that reported success. This is the case the SQL-only version could not have covered.
   */
  it('collapses runs and trims edges rather than replacing character for character', async () => {
    await insertType('t2', 'alum__profile', 'alum__profile');
    await insertType('t3', 'alum_', 'alum_');

    await repairUrlPrefixes(handle.db);

    expect(await prefixOf('t2')).toBe('alum-profile');
    expect(await prefixOf('t3')).toBe('alum');
    for (const id of ['t2', 't3']) expect(VALID_PREFIX.test((await prefixOf(id))!)).toBe(true);
  });

  it('leaves an already-valid prefix untouched', async () => {
    await insertType('t4', 'news_item', 'news');
    await insertType('t5', 'event', 'events');

    await repairUrlPrefixes(handle.db);

    expect(await prefixOf('t4')).toBe('news');
    expect(await prefixOf('t5')).toBe('events');
  });

  it('nulls a prefix with nothing usable in it, rather than storing an empty string', async () => {
    // `''` would pass neither the validator nor the null check `buildCollectionPath` makes.
    await insertType('t6', 'odd', '___');

    await repairUrlPrefixes(handle.db);

    expect(await prefixOf('t6')).toBeNull();
  });

  it('leaves a page type alone, whose prefix is null and stays null', async () => {
    await insertType('t7', 'about_page', null);

    await repairUrlPrefixes(handle.db);

    expect(await prefixOf('t7')).toBeNull();
  });
});
