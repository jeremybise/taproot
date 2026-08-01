import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createUser } from '../auth/users.js';
import { createContentType, createField } from './types.js';
import { createItem, deleteItem, getItem, itemDeleteImpact, updateItem } from './items.js';
import { listAuditEntries } from './auditLog.js';
import { listRevisions } from './revisions.js';
import { publishDueReleases, schedulerStatus } from './scheduler.js';
import {
  createRelease,
  deleteRelease,
  getRelease,
  getReleaseWithItems,
  getStagedItem,
  openReleasesForItem,
  publishRelease,
  releaseDeleteBlockers,
  releasePreflight,
  releasesAvailableFor,
  restageItem,
  setReleaseStatus,
  stageItem,
  unstageItem,
  updateStagedItem,
  ReleaseError,
} from './releases.js';
import type { ContentTypeRow, FieldRow, User } from '../db/schema.js';

/**
 * Content Releases.
 *
 * The thing to hold onto while reading these: a release is the first place in Taproot where a
 * content item can have a version that is not live. Everything else here follows from that — the
 * live page staying put while the staged copy is edited, pre-flight standing in for a transaction
 * that D1 cannot provide, and a per-item `published_at` making a half-finished publish resumable.
 */

let handle: TaprootDb;
let type: ContentTypeRow;
let fields: FieldRow[];
let editor: User;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;

  editor = await createUser(handle.db, {
    email: 'editor@example.edu',
    name: 'Erin Editor',
    role: 'editor',
  });

  type = await createContentType(handle.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    kind: 'page',
    description: null,
    icon: null,
    url_prefix: null,
    title_field: 'title',
  });

  fields = [
    await createField(handle.db, type.id, {
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
  await handle.destroy();
});

async function page(title: string, status: 'draft' | 'published' | 'archived' = 'published') {
  return createItem(handle, type, fields, {
    contentTypeId: type.id,
    title,
    status,
    data: { body: 'original' },
  });
}

async function release(name = 'Spring launch') {
  return createRelease(handle.db, { name, userId: editor.id });
}

describe('staging', () => {
  it('takes a copy of the item as it is now', async () => {
    const item = await page('Tuition');
    const rel = await release();

    const staged = await stageItem(handle.db, rel.id, item.id, { actor: editor });

    expect(staged.title).toBe('Tuition');
    expect(staged.data).toEqual({ body: 'original' });
    expect(staged.published_at).toBeNull();
  });

  /**
   * The whole point of the feature. Before releases, editing a published page changed what
   * visitors saw at the moment of the save — there was nowhere for a pending version to wait.
   */
  it('leaves the live page untouched while the staged copy is edited', async () => {
    const item = await page('Tuition');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });

    await updateStagedItem(handle.db, rel.id, item.id, { data: { body: 'next year' } });

    const live = await getItem(handle.db, item.id);
    expect(live!.data).toEqual({ body: 'original' });
    expect((await getStagedItem(handle.db, rel.id, item.id))!.data).toEqual({ body: 'next year' });
  });

  it('does not append a revision for an edit that has not gone live', async () => {
    const item = await page('Tuition');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });

    const before = await listRevisions(handle.db, item.id);
    await updateStagedItem(handle.db, rel.id, item.id, { data: { body: 'next year' } });
    const after = await listRevisions(handle.db, item.id);

    // A revision records what the live item *has been*. An edit to something that was never live
    // would be a line in the history of a page that never showed it.
    expect(after.total).toBe(before.total);
  });

  it('is idempotent — staging twice returns the existing version rather than resetting it', async () => {
    const item = await page('Tuition');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await updateStagedItem(handle.db, rel.id, item.id, { data: { body: 'edited' } });

    const again = await stageItem(handle.db, rel.id, item.id, { actor: editor });

    expect(again.data).toEqual({ body: 'edited' });
  });

  it('refuses to add to a release that is not open', async () => {
    const item = await page('Tuition');
    const rel = await release();
    await setReleaseStatus(handle.db, rel.id, 'scheduled', {
      publishAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(stageItem(handle.db, rel.id, item.id)).rejects.toThrow(ReleaseError);
  });

  it('sanitises richtext on the way in, not at publish time', async () => {
    const richType = await createContentType(handle.db, {
      api_id: 'article',
      name: 'Article',
      name_plural: 'Articles',
      kind: 'page',
      description: null,
      icon: null,
      url_prefix: null,
      title_field: 'title',
    });
    const richFields = [
      await createField(handle.db, richType.id, {
        api_id: 'body',
        label: 'Body',
        type: 'richtext',
        required: false,
        localized: false,
        position: 0,
        config: {},
        help_text: null,
      }),
    ];
    const item = await createItem(handle, richType, richFields, {
      contentTypeId: richType.id,
      title: 'Notice',
      status: 'published',
      data: { body: '<p>fine</p>' },
    });

    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await updateStagedItem(handle.db, rel.id, item.id, {
      data: { body: '<p>hello<script>alert(1)</script></p>' },
    });

    /**
     * Stored sanitised, because the admin renders a staged version in the editor long before
     * anything publishes it. Deferring the sanitising to publish time would put unsanitised markup
     * in front of every editor who opened the release.
     */
    const staged = await getStagedItem(handle.db, rel.id, item.id);
    expect(String(staged!.data.body)).not.toContain('<script>');
  });

  it('refreshes from the live page on request, discarding release-side edits', async () => {
    const item = await page('Tuition');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await updateStagedItem(handle.db, rel.id, item.id, { data: { body: 'release copy' } });

    await updateItem(handle, type, fields, item.id, { data: { body: 'live moved on' } });
    await restageItem(handle.db, rel.id, item.id);

    expect((await getStagedItem(handle.db, rel.id, item.id))!.data).toEqual({
      body: 'live moved on',
    });
  });

  it('removes an item from a release', async () => {
    const item = await page('Tuition');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });

    await unstageItem(handle.db, rel.id, item.id, { actor: editor });

    expect(await getStagedItem(handle.db, rel.id, item.id)).toBeUndefined();
  });
});

describe('an item in more than one release', () => {
  it('is allowed, and both releases say so', async () => {
    const item = await page('Tuition');
    const first = await release('Spring launch');
    const second = await release('Tuition update');

    await stageItem(handle.db, first.id, item.id, { actor: editor });
    await stageItem(handle.db, second.id, item.id, { actor: editor });

    const detail = await getReleaseWithItems(handle.db, first.id);
    expect(detail!.items[0]!.otherReleases.map((entry) => entry.name)).toEqual([
      'Tuition update',
    ]);
  });

  /** A published release cannot publish again, so naming it would report a conflict that cannot happen. */
  it('stops reporting a conflict once the other release has published', async () => {
    const item = await page('Tuition');
    const first = await release('Spring launch');
    const second = await release('Tuition update');
    await stageItem(handle.db, first.id, item.id, { actor: editor });
    await stageItem(handle.db, second.id, item.id, { actor: editor });

    await publishRelease(handle, second.id, { actor: editor });

    const detail = await getReleaseWithItems(handle.db, first.id);
    expect(detail!.items[0]!.otherReleases).toEqual([]);
  });

  it('is not offered again by the "add to release" list', async () => {
    const item = await page('Tuition');
    const first = await release('Spring launch');
    await release('Tuition update');
    await stageItem(handle.db, first.id, item.id, { actor: editor });

    const available = await releasesAvailableFor(handle.db, item.id);
    expect(available.map((entry) => entry.name)).toEqual(['Tuition update']);
  });
});

describe('pre-flight', () => {
  it('refuses an empty release', async () => {
    const rel = await release();
    const result = await releasePreflight(handle.db, rel.id);

    expect(result.ok).toBe(false);
    expect(result.problems[0]!.reason).toContain('no content in it');
  });

  it('passes a release of publishable items', async () => {
    const item = await page('Tuition', 'draft');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });

    expect((await releasePreflight(handle.db, rel.id)).ok).toBe(true);
  });

  /**
   * `archived → published` is not an arrow in the workflow graph — for an admin either. A release
   * must not be a way around a rule the item editor enforces one page at a time.
   */
  it('refuses an archived item, because there is no route from archived to published', async () => {
    const item = await page('Old notice', 'archived');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });

    const result = await releasePreflight(handle.db, rel.id);
    expect(result.ok).toBe(false);
    expect(result.problems[0]!.reason).toContain('no direct route');
  });

  /**
   * A release can sit open for weeks. A required field added in the meantime is exactly the kind
   * of change that turns a staged version into something the item editor would refuse.
   */
  it('validates against the content type as it is now, not as it was when staged', async () => {
    const item = await page('Tuition');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });

    await createField(handle.db, type.id, {
      api_id: 'summary',
      label: 'Summary',
      type: 'text',
      required: true,
      localized: false,
      position: 1,
      config: {},
      help_text: null,
    });

    const result = await releasePreflight(handle.db, rel.id);
    expect(result.ok).toBe(false);
    expect(result.problems[0]!.reason).toContain('Summary');
  });

  it('is recomputed rather than stored, so fixing the content clears it', async () => {
    const item = await page('Tuition');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });

    const field = await createField(handle.db, type.id, {
      api_id: 'summary',
      label: 'Summary',
      type: 'text',
      required: true,
      localized: false,
      position: 1,
      config: {},
      help_text: null,
    });
    expect((await releasePreflight(handle.db, rel.id)).ok).toBe(false);

    await updateStagedItem(handle.db, rel.id, item.id, {
      data: { body: 'original', [field.api_id]: 'A summary' },
    });

    expect((await releasePreflight(handle.db, rel.id)).ok).toBe(true);
  });
});

describe('publishing a release', () => {
  it('applies every staged version at once', async () => {
    const first = await page('Tuition', 'draft');
    const second = await page('Aid', 'draft');
    const rel = await release();

    await stageItem(handle.db, rel.id, first.id, { actor: editor });
    await stageItem(handle.db, rel.id, second.id, { actor: editor });
    await updateStagedItem(handle.db, rel.id, first.id, { data: { body: 'new tuition' } });
    await updateStagedItem(handle.db, rel.id, second.id, { data: { body: 'new aid' } });

    const result = await publishRelease(handle, rel.id, { actor: editor });

    expect(result.ok).toBe(true);
    expect(result.published).toHaveLength(2);
    expect((await getItem(handle.db, first.id))!.data).toEqual({ body: 'new tuition' });
    expect((await getItem(handle.db, first.id))!.status).toBe('published');
    expect((await getItem(handle.db, second.id))!.status).toBe('published');
    expect((await getRelease(handle.db, rel.id))!.status).toBe('published');
  });

  /**
   * Routed through `updateItem` rather than writing the row directly, so a staged slug change
   * cascades and leaves a redirect exactly as an editor's rename would. Writing the snapshot back
   * verbatim would restore the content and quietly corrupt the tree.
   */
  it('cascades a staged slug change and writes its redirect', async () => {
    const item = await page('Tuition');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await updateStagedItem(handle.db, rel.id, item.id, { slug: 'tuition-and-fees' });

    await publishRelease(handle, rel.id, { actor: editor });

    const moved = await getItem(handle.db, item.id);
    expect(moved!.path).toBe('/tuition-and-fees');

    const redirect = await handle.db
      .selectFrom('redirects')
      .selectAll()
      .where('from_path', '=', '/tuition')
      .executeTakeFirst();
    expect(redirect?.to_path).toBe('/tuition-and-fees');
  });

  it('appends a revision per item, so the change is in each page’s history', async () => {
    const item = await page('Tuition', 'draft');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await updateStagedItem(handle.db, rel.id, item.id, { data: { body: 'new' } });

    const before = await listRevisions(handle.db, item.id);
    await publishRelease(handle, rel.id, { actor: editor });
    const after = await listRevisions(handle.db, item.id);

    expect(after.total).toBe(before.total + 1);
  });

  it('writes nothing at all when pre-flight fails', async () => {
    const good = await page('Tuition', 'draft');
    const bad = await page('Old notice', 'archived');
    const rel = await release();
    await stageItem(handle.db, rel.id, good.id, { actor: editor });
    await stageItem(handle.db, rel.id, bad.id, { actor: editor });
    await updateStagedItem(handle.db, rel.id, good.id, { data: { body: 'new' } });

    const result = await publishRelease(handle, rel.id, { actor: editor });

    expect(result.ok).toBe(false);
    expect(result.published).toEqual([]);
    /**
     * This is what pre-flight buys. Without it the loop would publish the good item, hit the bad
     * one, and leave half a launch live — which is the "item 4 of 12 fails" case the scope doc
     * asks about, and which no transaction can prevent here because D1 has none spanning N updates.
     */
    expect((await getItem(handle.db, good.id))!.data).toEqual({ body: 'original' });
    expect((await getItem(handle.db, good.id))!.status).toBe('draft');
  });

  it('records who published what, naming the release', async () => {
    const item = await page('Tuition', 'draft');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await publishRelease(handle, rel.id, { actor: editor });

    const { entries } = await listAuditEntries(handle.db, { action: 'release.published' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.subject_label).toBe('Spring launch');
    expect(entries[0]!.actor_email).toBe('editor@example.edu');
  });

  it('refuses to publish twice', async () => {
    const item = await page('Tuition', 'draft');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await publishRelease(handle, rel.id, { actor: editor });

    const again = await publishRelease(handle, rel.id, { actor: editor });
    expect(again.ok).toBe(false);
    expect(again.problems[0]!.reason).toContain('already been published');
  });

  it('clears publish_at when a scheduled release goes live', async () => {
    const item = await page('Tuition', 'draft');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await setReleaseStatus(handle.db, rel.id, 'scheduled', {
      publishAt: new Date(Date.now() - 1000).toISOString(),
    });

    await publishRelease(handle, rel.id, { actor: editor });

    // A time left behind on a finished release is one a reschedule would inherit, in the past.
    expect((await getRelease(handle.db, rel.id))!.publish_at).toBeNull();
  });
});

describe('the scheduled sweep', () => {
  it('publishes a release whose moment has come', async () => {
    const item = await page('Tuition', 'draft');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await setReleaseStatus(handle.db, rel.id, 'scheduled', {
      publishAt: new Date(Date.now() - 1000).toISOString(),
    });

    const result = await publishDueReleases(handle);

    expect(result.published).toHaveLength(1);
    expect((await getItem(handle.db, item.id))!.status).toBe('published');
  });

  it('leaves a release whose moment has not arrived', async () => {
    const item = await page('Tuition', 'draft');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await setReleaseStatus(handle.db, rel.id, 'scheduled', {
      publishAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect((await publishDueReleases(handle)).published).toEqual([]);
    expect((await getItem(handle.db, item.id))!.status).toBe('draft');
  });

  /**
   * The unattended case, and the only reason `blocked` exists. Leaving it `scheduled` would mean
   * sweeping the same broken content every minute until somebody noticed, writing an audit entry
   * each time.
   */
  it('blocks a release it refuses rather than retrying it forever', async () => {
    const bad = await page('Old notice', 'archived');
    const rel = await release();
    await stageItem(handle.db, rel.id, bad.id, { actor: editor });
    await setReleaseStatus(handle.db, rel.id, 'scheduled', {
      publishAt: new Date(Date.now() - 1000).toISOString(),
    });

    const result = await publishDueReleases(handle);

    expect(result.blocked).toHaveLength(1);
    const after = await getRelease(handle.db, rel.id);
    expect(after!.status).toBe('blocked');
    expect(after!.publish_at).toBeNull();

    // And a second sweep finds nothing, which is the property that matters.
    expect((await publishDueReleases(handle)).blocked).toEqual([]);
  });

  it('records why it refused, since nobody was watching', async () => {
    const bad = await page('Old notice', 'archived');
    const rel = await release();
    await stageItem(handle.db, rel.id, bad.id, { actor: editor });
    await setReleaseStatus(handle.db, rel.id, 'scheduled', {
      publishAt: new Date(Date.now() - 1000).toISOString(),
    });

    await publishDueReleases(handle);

    const { entries } = await listAuditEntries(handle.db, { action: 'release.blocked' });
    expect(entries).toHaveLength(1);
    // No actor: the scheduler is not a person, and naming whoever scheduled it would credit them
    // with a decision made at a moment they were not present for.
    expect(entries[0]!.actor_id).toBeNull();
  });

  /**
   * Two sweeps overlapping — a cron firing while an admin hits "Run now" — must not walk the same
   * release twice. Clearing `publish_at` is the claim, and it is a rule that already had to hold.
   */
  it('cannot publish the same release twice from two overlapping sweeps', async () => {
    const item = await page('Tuition', 'draft');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await setReleaseStatus(handle.db, rel.id, 'scheduled', {
      publishAt: new Date(Date.now() - 1000).toISOString(),
    });

    const [first, second] = await Promise.all([
      publishDueReleases(handle),
      publishDueReleases(handle),
    ]);

    expect(first.published.length + second.published.length).toBe(1);

    const { entries } = await listAuditEntries(handle.db, { action: 'release.published' });
    expect(entries).toHaveLength(1);
  });

  it('reports release counts to the system screen', async () => {
    const item = await page('Tuition', 'draft');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await setReleaseStatus(handle.db, rel.id, 'scheduled', {
      publishAt: new Date(Date.now() - 1000).toISOString(),
    });

    const status = await schedulerStatus(handle.db);
    expect(status.releasesWaiting).toBe(1);
    expect(status.releasesDue).toBe(1);
    expect(status.releasesBlocked).toBe(0);
  });
});

describe('deleting', () => {
  it('discards staged versions and leaves the live pages alone', async () => {
    const item = await page('Tuition');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await updateStagedItem(handle.db, rel.id, item.id, { data: { body: 'never shipped' } });

    await deleteRelease(handle.db, rel.id);

    expect(await getRelease(handle.db, rel.id)).toBeUndefined();
    expect((await getItem(handle.db, item.id))!.data).toEqual({ body: 'original' });
  });

  it('refuses to delete a published release, which is the record of what went live', async () => {
    const item = await page('Tuition', 'draft');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await publishRelease(handle, rel.id, { actor: editor });

    expect(await releaseDeleteBlockers(handle.db, rel.id)).toHaveLength(1);
    await expect(deleteRelease(handle.db, rel.id)).rejects.toThrow(ReleaseError);
  });

  /**
   * `release_items.content_item_id` cascades, so deleting the item would take its staged version
   * with it and the release would publish without that page — no broken row, no message, and
   * nobody notices until the launch is missing something. That is why this blocks rather than
   * warns: a menu entry degrades *visibly*, and this would not.
   */
  it('blocks deleting a content item that is staged in an unpublished release', async () => {
    const item = await page('Tuition');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });

    const impact = await itemDeleteImpact(handle.db, item.id);
    expect(impact.blockers.some((reason) => reason.includes('Spring launch'))).toBe(true);
    await expect(deleteItem(handle, item.id)).rejects.toThrow();
  });

  it('stops blocking once the release has published', async () => {
    const item = await page('Tuition', 'draft');
    const rel = await release();
    await stageItem(handle.db, rel.id, item.id, { actor: editor });
    await publishRelease(handle, rel.id, { actor: editor });

    expect(await openReleasesForItem(handle.db, item.id)).toEqual([]);
    expect((await itemDeleteImpact(handle.db, item.id)).blockers).toEqual([]);
  });
});
