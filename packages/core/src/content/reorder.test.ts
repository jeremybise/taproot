import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createContentType } from './types.js';
import { createItem, getChildren, getItem, reorderSiblings } from './items.js';
import type { ContentTypeRow } from '../db/schema.js';

/**
 * Arranging a sibling group.
 *
 * `position` had no write path at all before `reorderSiblings` — `createItem` set it once and
 * nothing ever changed it — so these are the first tests that can distinguish "the order somebody
 * arranged" from "the order somebody typed". Every fixture below is therefore created in an order
 * that disagrees with both alphabetical and path order, so a wrong implementation that quietly
 * falls back to either cannot pass.
 */

let handle: TaprootDb;
let pageType: ContentTypeRow;

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
});

const section = (title: string, parentId: string | null) =>
  createItem(handle, pageType, [], {
    contentTypeId: pageType.id,
    title,
    parentId,
    status: 'published',
  });

/** The page whose children are being arranged. Plain, because nothing here is type-specific. */
const branchRoot = () =>
  createItem(handle, pageType, [], {
    contentTypeId: pageType.id,
    title: 'Handbook',
    status: 'published',
  });

const titlesUnder = async (parentId: string | null) =>
  (await getChildren(handle.db, parentId)).map((child) => child.title);

const positionsUnder = async (parentId: string | null) =>
  (await getChildren(handle.db, parentId)).map((child) => child.position);

describe('reorderSiblings', () => {
  it('puts a level in the order it is given', async () => {
    const root = await branchRoot();
    const admissions = await section('Admissions', root.id);
    const welcome = await section('Welcome', root.id);
    const policies = await section('Policies', root.id);

    expect(await titlesUnder(root.id)).toEqual(['Admissions', 'Welcome', 'Policies']);

    await reorderSiblings(handle, root.id, [welcome.id, admissions.id, policies.id]);

    expect(await titlesUnder(root.id)).toEqual(['Welcome', 'Admissions', 'Policies']);
  });

  /**
   * The property the whole feature exists for: the new order has to be *stored*, in the column the
   * read paths sort by.
   *
   * `getChildren` and `resolveDelivery`'s children query both order by `position` — so asserting the
   * titles alone would also pass against an implementation that wrote the order into something only
   * this suite reads. The positions are asserted as `0..n-1` beside them, which is the shape the
   * exactness rule below depends on.
   */
  it('stores the new order in position, which is what a consumer is served by', async () => {
    const root = await branchRoot();
    const a = await section('Admissions', root.id);
    const b = await section('Welcome', root.id);
    const child = await section('How to apply', a.id);

    expect(await positionsUnder(root.id)).toEqual([0, 1]);

    await reorderSiblings(handle, root.id, [b.id, a.id]);

    expect(await titlesUnder(root.id)).toEqual(['Welcome', 'Admissions']);
    expect(await positionsUnder(root.id)).toEqual([0, 1]);

    // The subtree travels with its parent: `How to apply` is still inside Admissions, because
    // nothing about the child's own level changed.
    expect(await titlesUnder(a.id)).toEqual(['How to apply']);
    expect(child.parent_id).toBe(a.id);
  });

  it('reorders a nested level without touching the one above it', async () => {
    const root = await branchRoot();
    const parent = await section('Academics', root.id);
    const other = await section('Athletics', root.id);
    const first = await section('Majors', parent.id);
    const second = await section('Minors', parent.id);

    await reorderSiblings(handle, parent.id, [second.id, first.id]);

    expect(await titlesUnder(parent.id)).toEqual(['Minors', 'Majors']);
    expect(await titlesUnder(root.id)).toEqual(['Academics', 'Athletics']);
    expect(other.id).toBeTruthy();
  });

  /**
   * A subset would not merely be refused — it would be *silently wrong* if allowed.
   *
   * Positions are assigned `0..n-1`, so reordering two of three children hands those two the
   * positions the first two already hold and leaves a level with duplicate positions, ordered by
   * the `title` tiebreak. That reads as the drag working on some rows and not others.
   */
  it('refuses a partial level', async () => {
    const root = await branchRoot();
    const a = await section('Admissions', root.id);
    const b = await section('Welcome', root.id);
    await section('Policies', root.id);

    await expect(reorderSiblings(handle, root.id, [b.id, a.id])).rejects.toThrow(/does not match/i);

    expect(await titlesUnder(root.id)).toEqual(['Admissions', 'Welcome', 'Policies']);
  });

  /**
   * The concurrency case, which is a real one: two editors on one section of a site, one adds a page
   * while the other is arranging. The dragger's list predates the insert, so it is refused and their
   * screen reloads — rather than the new page being shuffled to the end of a level it was never part
   * of.
   */
  it('refuses an order that predates a new sibling', async () => {
    const root = await branchRoot();
    const a = await section('Admissions', root.id);
    const b = await section('Welcome', root.id);

    const staleOrder = [b.id, a.id];
    await section('Policies', root.id);

    await expect(reorderSiblings(handle, root.id, staleOrder)).rejects.toMatchObject({
      code: 'stale_order',
    });
  });

  it("refuses ids belonging to another parent", async () => {
    const root = await branchRoot();
    const branch = await section('Academics', root.id);
    const mine = await section('Majors', branch.id);
    const theirs = await section('Athletics', root.id);

    // Without the check the statements match on id alone, so another level's rows would simply be
    // renumbered — a level nobody was looking at, silently rearranged.
    await expect(reorderSiblings(handle, branch.id, [mine.id, theirs.id])).rejects.toMatchObject({
      code: 'stale_order',
    });

    expect(await titlesUnder(root.id)).toEqual(['Academics', 'Athletics']);
  });

  it('refuses a list repeating one id', async () => {
    const root = await branchRoot();
    const a = await section('Admissions', root.id);
    const b = await section('Welcome', root.id);

    // Same length as the level and every id known, so a length check alone would let this through
    // and drop `b` out of the ordering entirely.
    await expect(reorderSiblings(handle, root.id, [a.id, a.id])).rejects.toMatchObject({
      code: 'stale_order',
    });

    expect(await titlesUnder(root.id)).toEqual(['Admissions', 'Welcome']);
    expect(b.id).toBeTruthy();
  });

  /**
   * The parent's `updated_at` is what answers a conditional request for the page carrying these
   * children, and `getItemVersionByPath` reads nothing else. Left still, a cached copy revalidates,
   * is told 304, and has its freshness renewed against an order that has changed — which RFC 9111
   * §4.3.4 makes unbounded rather than capped at the TTL.
   */
  it("moves the parent's timestamp, not only the children's", async () => {
    const root = await branchRoot();
    const a = await section('Admissions', root.id);
    const b = await section('Welcome', root.id);

    const before = (await getItem(handle.db, root.id))!.updated_at;
    await new Promise((resolve) => setTimeout(resolve, 5));

    await reorderSiblings(handle, root.id, [b.id, a.id]);

    expect((await getItem(handle.db, root.id))!.updated_at).not.toBe(before);
  });

  /**
   * A drag that lands where it started is a no-op, and writing anyway would move the parent's ETag
   * and invalidate every cached copy of a page whose order did not change.
   */
  it('writes nothing when the order is unchanged', async () => {
    const root = await branchRoot();
    const a = await section('Admissions', root.id);
    const b = await section('Welcome', root.id);

    const before = (await getItem(handle.db, root.id))!.updated_at;
    await new Promise((resolve) => setTimeout(resolve, 5));

    await reorderSiblings(handle, root.id, [a.id, b.id]);

    expect((await getItem(handle.db, root.id))!.updated_at).toBe(before);
  });

  it('reorders the top level, which has no parent to stamp', async () => {
    const a = await section('Admissions', null);
    const b = await section('Welcome', null);

    await reorderSiblings(handle, null, [b.id, a.id]);

    expect(await titlesUnder(null)).toEqual(['Welcome', 'Admissions']);
  });

  /**
   * A reorder is not a content change: no slug moves, no path is rewritten, and no redirect is
   * written. That is the whole reason it is a separate function rather than a key on
   * `UpdateItemInput` — and it is what lets a screen offer dragging as the cheap act while
   * re-parenting stays an explicit one.
   */
  it('rewrites no paths and writes no redirects', async () => {
    const root = await branchRoot();
    const a = await section('Admissions', root.id);
    const b = await section('Welcome', root.id);
    const child = await section('How to apply', a.id);

    await reorderSiblings(handle, root.id, [b.id, a.id]);

    expect((await getItem(handle.db, a.id))!.path).toBe(a.path);
    expect((await getItem(handle.db, child.id))!.path).toBe(child.path);

    const redirects = await handle.db.selectFrom('redirects').selectAll().execute();
    expect(redirects).toEqual([]);
  });

  /**
   * Revisions snapshot `title`, `slug`, `status`, `data` and `seo` — position is in none of them,
   * so a revision written here would record nothing and restore nothing.
   */
  it('appends no revision', async () => {
    const root = await branchRoot();
    const a = await section('Admissions', root.id);
    const b = await section('Welcome', root.id);

    const before = await handle.db.selectFrom('revisions').selectAll().execute();
    await reorderSiblings(handle, root.id, [b.id, a.id]);
    const after = await handle.db.selectFrom('revisions').selectAll().execute();

    expect(after.length).toBe(before.length);
  });
});
