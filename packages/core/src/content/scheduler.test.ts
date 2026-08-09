import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createUser } from '../auth/users.js';
import { createContentType, createField } from './types.js';
import { createItem, getItemByPath, restoreRevision, updateItem } from './items.js';
import { dueForPublishing, publishDueItems, schedulerStatus } from './scheduler.js';
import { listAuditEntries, recordAuditEntry } from './auditLog.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';

/**
 * Scheduled publishing.
 *
 * `scheduled` was a real status with a colour and a filter option that nothing ever acted on. The
 * two halves here are the feature: visibility is computed on read so a launch happens on time even
 * with no cron wired up, and the sweep makes the stored record agree afterwards.
 */

let handle: TaprootDb;
let type: ContentTypeRow;
let fields: FieldRow[];

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;

  type = await createContentType(handle.db, {
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

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function scheduled(title: string, publishAt: string) {
  return createItem(handle, type, fields, {
    contentTypeId: type.id,
    title,
    status: 'scheduled',
    publishAt,
  });
}

describe('what a visitor sees', () => {
  it('hides a scheduled item before its time', async () => {
    const item = await scheduled('Open day', iso(60_000));
    expect(await getItemByPath(handle.db, item.path)).toBeUndefined();
  });

  it('shows it once the time has passed, before any sweep has run', async () => {
    /**
     * The half that makes the feature work with no infrastructure. A deployment where nobody wired
     * up a cron still publishes on time — which is every deployment on its first day, and most
     * small ones forever. Without this a missed cron silently holds a launch.
     */
    const item = await scheduled('Open day', iso(-60_000));

    expect(await getItemByPath(handle.db, item.path)).toBeDefined();
    // Still `scheduled` in the database: nothing has swept yet.
    expect((await getItemByPath(handle.db, item.path, { publishedOnly: false }))?.status).toBe(
      'scheduled',
    );
  });

  it('does not show a scheduled item with no time set', async () => {
    // Reachable through the API, which accepts `scheduled` without a `publishAt`. Treating a null
    // as "now" would publish it immediately, which is the opposite of what scheduling means.
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'No date',
      status: 'scheduled',
    });

    expect(await getItemByPath(handle.db, item.path)).toBeUndefined();
  });

  it('still hides a draft', async () => {
    const item = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Draft',
      status: 'draft',
    });

    expect(await getItemByPath(handle.db, item.path)).toBeUndefined();
  });
});

describe('the sweep', () => {
  it('publishes only what is due', async () => {
    const due = await scheduled('Due', iso(-60_000));
    const later = await scheduled('Later', iso(60_000));

    const result = await publishDueItems(handle.db);

    expect(result.published.map((entry) => entry.id)).toEqual([due.id]);
    expect((await getItemByPath(handle.db, later.path, { publishedOnly: false }))?.status).toBe(
      'scheduled',
    );
  });

  it('stamps published_at with the moment it actually went live', async () => {
    // Not the scheduled time: `published_at` records what happened, and a sweep that ran late
    // should say so rather than claiming it was punctual.
    const item = await scheduled('Due', iso(-86_400_000));
    await publishDueItems(handle.db);

    const after = await getItemByPath(handle.db, item.path, { publishedOnly: false });
    expect(new Date(after!.published_at!).getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('is idempotent, so a retrying scheduler cannot double-publish', async () => {
    await scheduled('Due', iso(-60_000));

    expect((await publishDueItems(handle.db)).published).toHaveLength(1);
    expect((await publishDueItems(handle.db)).published).toHaveLength(0);

    // And exactly one audit entry, not two.
    const { entries } = await listAuditEntries(handle.db, { action: 'item.published' });
    expect(entries).toHaveLength(1);
  });

  it('records the publish as nobody’s action', async () => {
    /**
     * The scheduler is not a person. Naming whoever happened to trigger the sweep would credit
     * them with a decision somebody else made days earlier.
     */
    await scheduled('Due', iso(-60_000));
    await publishDueItems(handle.db);

    const { entries } = await listAuditEntries(handle.db);
    expect(entries[0]!.actor_id).toBeNull();
    expect(entries[0]!.detail).toMatchObject({ from: 'scheduled', scheduled: true });
  });

  it('does not append a revision', async () => {
    /**
     * Nothing about the content changed, only the status. Routing this through `updateItem` would
     * append a revision per scheduled item and fill the history with entries nobody wrote.
     */
    const item = await scheduled('Due', iso(-60_000));
    const before = await handle.db
      .selectFrom('revisions')
      .select('id')
      .where('content_item_id', '=', item.id)
      .execute();

    await publishDueItems(handle.db);

    const after = await handle.db
      .selectFrom('revisions')
      .select('id')
      .where('content_item_id', '=', item.id)
      .execute();
    expect(after).toHaveLength(before.length);
  });

  it('clears publish_at, so rescheduling later cannot inherit a past time', async () => {
    /**
     * The sweep does not go through `updateItem`, so it has to clear this itself. Left behind, the
     * value is a booby trap: schedule the page again without picking a new time and it inherits
     * one in the past — which means immediately.
     */
    const item = await scheduled('Due', iso(-60_000));
    await publishDueItems(handle.db);

    const after = await getItemByPath(handle.db, item.path, { publishedOnly: false });
    expect(after?.publish_at).toBeNull();
  });

  it('lists what is due without publishing it', async () => {
    const item = await scheduled('Due', iso(-60_000));

    expect((await dueForPublishing(handle.db)).map((entry) => entry.id)).toEqual([item.id]);
    expect((await getItemByPath(handle.db, item.path, { publishedOnly: false }))?.status).toBe(
      'scheduled',
    );
  });
});

describe('publish_at’s lifetime', () => {
  it('is cleared when the status leaves scheduled', async () => {
    /**
     * A stale time left on a published page is a booby trap: schedule it again months later and
     * the sweep sees a `publish_at` in the past and takes it live immediately.
     */
    const item = await scheduled('Due', iso(60_000));
    await updateItem(handle, type, fields, item.id, { status: 'draft' });

    const after = await getItemByPath(handle.db, item.path, { publishedOnly: false });
    expect(after?.publish_at).toBeNull();
  });

  it('can be cleared while the item stays scheduled', async () => {
    const item = await scheduled('Due', iso(60_000));
    await updateItem(handle, type, fields, item.id, { status: 'scheduled', publishAt: null });

    const after = await getItemByPath(handle.db, item.path, { publishedOnly: false });
    expect(after?.publish_at).toBeNull();
  });

  it('leaves a restored scheduled revision dateless rather than instantly live', async () => {
    /**
     * Revisions snapshot authored content, not `publish_at` — a scheduled moment is an intention
     * about the future, and resurrecting last month's would mean restoring an old draft published
     * it on the spot.
     *
     * So a restore back into `scheduled` lands with no date: invisible to visitors, never swept,
     * and shown in the editor as an empty required field. It fails closed and says so, which is
     * the right end of the trade — the alternative silently publishes.
     */
    const item = await scheduled('Due', iso(-60_000));
    await publishDueItems(handle.db);
    await updateItem(handle, type, fields, item.id, { status: 'draft' });

    const first = await handle.db
      .selectFrom('revisions')
      .select('id')
      .where('content_item_id', '=', item.id)
      .where('revision_number', '=', 1)
      .executeTakeFirstOrThrow();

    await restoreRevision(handle, type, fields, item.id, first.id, null);

    const after = await getItemByPath(handle.db, item.path, { publishedOnly: false });
    expect(after?.publish_at).toBeNull();
    // And therefore not served to anyone.
    expect(await getItemByPath(handle.db, item.path)).toBeUndefined();
  });

  it('survives an edit that keeps the item scheduled', async () => {
    const at = iso(60_000);
    const item = await scheduled('Due', at);
    await updateItem(handle, type, fields, item.id, { title: 'Renamed' });

    const after = await getItemByPath(handle.db, item.path, { publishedOnly: false });
    expect(after?.publish_at).toBe(at);
  });
});

describe('what the admin reports about the sweep', () => {
  it('counts what is waiting and what is overdue separately', async () => {
    await scheduled('Overdue', iso(-60_000));
    await scheduled('Also overdue', iso(-30_000));
    await scheduled('Later', iso(60_000));

    const status = await schedulerStatus(handle.db);

    expect(status.waiting).toBe(3);
    expect(status.due).toBe(2);
  });

  it('does not count a scheduled item with no date as overdue', async () => {
    // It is waiting forever, not late. Counting it would make the admin's "nothing is running the
    // sweep" warning permanent on a deployment whose sweep is perfectly healthy.
    await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'No date',
      status: 'scheduled',
    });

    const status = await schedulerStatus(handle.db);
    expect(status.waiting).toBe(1);
    expect(status.due).toBe(0);
  });

  it('reports never swept before anything has run', async () => {
    await scheduled('Later', iso(60_000));
    expect((await schedulerStatus(handle.db)).lastSweptAt).toBeNull();
  });

  it('reads the last sweep from the audit entry the sweep itself wrote', async () => {
    await scheduled('Due', iso(-60_000));
    await publishDueItems(handle.db);

    const status = await schedulerStatus(handle.db);

    expect(status.lastSweptAt).not.toBeNull();
    // And the queue is empty afterwards, which is the pair of numbers the screen shows together.
    expect(status.waiting).toBe(0);
    expect(status.due).toBe(0);
  });

  it('ignores a publish somebody did by hand', async () => {
    /**
     * The distinguishing mark is an absent actor. `PATCH /items/[id]` writes `item.published` too,
     * always with the signed-in user attached, so counting every entry with that action would
     * report a healthy scheduler on a deployment that has none.
     *
     * Written through `recordAuditEntry` rather than by publishing an item, because `updateItem`
     * logs nothing — the audit entry for a hand publish belongs to the route, which knows who is
     * asking. That makes this a direct test of the discriminator, which is the part that matters.
     */
    // A real row, because `actor_id` is a foreign key and `recordAuditEntry` swallows its own
    // failures — a made-up id would leave the log empty and the assertion passing for the wrong
    // reason.
    const editor = await createUser(handle.db, {
      email: 'editor@campus.edu',
      name: 'Editor',
      role: 'editor',
    });

    await recordAuditEntry(handle.db, {
      action: 'item.published',
      subjectType: 'item',
      subjectId: 'item-1',
      subjectLabel: 'By hand',
      actor: editor,
      detail: { from: 'draft', to: 'published' },
    });

    expect((await listAuditEntries(handle.db, { action: 'item.published' })).total).toBe(1);
    expect((await schedulerStatus(handle.db)).lastSweptAt).toBeNull();
  });
});
