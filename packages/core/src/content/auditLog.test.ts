import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createUser } from '../auth/users.js';
import {
  listAuditActions,
  listAuditEntries,
  purgeAuditLogBefore,
  recordAuditEntry,
} from './auditLog.js';
import type { User } from '../db/schema.js';

/**
 * The audit log.
 *
 * Two properties carry the whole feature: an entry stays readable after everything it names is
 * gone, and writing one can never fail the action it describes.
 */

let handle: TaprootDb;
let actor: User;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
  actor = await createUser(handle.db, { email: 'admin@campus.edu', name: 'Admin', role: 'admin' });
});

afterEach(async () => {
  await handle.destroy();
  vi.restoreAllMocks();
});

describe('recording', () => {
  it('stores who, what, and to what', async () => {
    await recordAuditEntry(handle.db, {
      action: 'item.published',
      subjectType: 'item',
      subjectId: 'item-1',
      subjectLabel: 'Admissions',
      actor,
      detail: { from: 'draft', to: 'published' },
    });

    const { entries } = await listAuditEntries(handle.db);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'item.published',
      actor_id: actor.id,
      actor_email: 'admin@campus.edu',
      subject_label: 'Admissions',
    });
    expect(entries[0]!.detail).toEqual({ from: 'draft', to: 'published' });
  });

  it('accepts an entry with no actor, for something the system did', async () => {
    // The scheduler publishing at 9am is nobody's action, and an entry claiming otherwise would be
    // worse than one admitting it.
    await recordAuditEntry(handle.db, {
      action: 'item.published',
      subjectType: 'item',
      subjectId: 'item-1',
      subjectLabel: 'Open day',
      actor: null,
    });

    const { entries } = await listAuditEntries(handle.db);
    expect(entries[0]!.actor_id).toBeNull();
    expect(entries[0]!.actor_email).toBeNull();
  });

  it('stays readable after the subject is deleted', async () => {
    /**
     * Why `subject_id` has no foreign key. A cascade would delete the evidence along with the
     * thing, and `set null` would erase which thing it was — either way the entry that mattered
     * most, the one about a deletion, is the one that disappears.
     */
    await recordAuditEntry(handle.db, {
      action: 'item.deleted',
      subjectType: 'item',
      subjectId: 'gone-forever',
      subjectLabel: 'Tuition 2025',
      actor,
    });

    const { entries } = await listAuditEntries(handle.db);
    expect(entries[0]!.subject_label).toBe('Tuition 2025');
    expect(entries[0]!.subject_id).toBe('gone-forever');
  });

  it('keeps the actor’s email after the account is deleted', async () => {
    // `actor_id` is nulled by the FK; the copied email is what keeps the entry meaningful.
    await recordAuditEntry(handle.db, {
      action: 'user.deactivated',
      subjectType: 'user',
      subjectId: 'someone',
      subjectLabel: 'someone@campus.edu',
      actor,
    });

    await handle.db.deleteFrom('users').where('id', '=', actor.id).execute();

    const { entries } = await listAuditEntries(handle.db);
    expect(entries[0]!.actor_id).toBeNull();
    expect(entries[0]!.actor_email).toBe('admin@campus.edu');
  });

  it('never throws, so a failed write cannot fail the action it describes', async () => {
    /**
     * The action has already happened by the time this runs. Rethrowing would report a failure
     * that did not occur and undo nothing — and an editor cannot act on "audit log unavailable".
     */
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      insertInto: () => {
        throw new Error('database is on fire');
      },
    } as unknown as typeof handle.db;

    await expect(
      recordAuditEntry(broken, { action: 'item.published', subjectType: 'item' }),
    ).resolves.toBeUndefined();

    // Silently swallowing would be its own problem: the operator has to be able to see it.
    expect(error).toHaveBeenCalled();
  });
});

describe('reading', () => {
  beforeEach(async () => {
    const other = await createUser(handle.db, { email: 'ed@campus.edu', name: 'Ed', role: 'editor' });
    await recordAuditEntry(handle.db, {
      action: 'item.published',
      subjectType: 'item',
      subjectId: 'a',
      actor,
    });
    await recordAuditEntry(handle.db, {
      action: 'item.deleted',
      subjectType: 'item',
      subjectId: 'b',
      actor: other,
    });
    await recordAuditEntry(handle.db, {
      action: 'user.role_changed',
      subjectType: 'user',
      subjectId: 'c',
      actor,
    });
  });

  it('returns newest first', async () => {
    /**
     * Stamped apart rather than relying on write order.
     *
     * All three above land in the same millisecond, and the `id` tiebreak is a UUIDv7 whose
     * sub-millisecond bits are random — so it makes the order *stable* between reads, which is
     * what it is for, and does not make it chronological at that resolution. Asserting write order
     * on ties would be asserting something the implementation does not claim.
     */
    // All three, or the unstamped one keeps `now()` and sorts above the lot.
    const stamps: [string, string][] = [
      ['item.published', '2026-01-01T00:00:00.000Z'],
      ['item.deleted', '2026-01-02T00:00:00.000Z'],
      ['user.role_changed', '2026-01-03T00:00:00.000Z'],
    ];
    for (const [action, created] of stamps) {
      await handle.db
        .updateTable('audit_log')
        .set({ created_at: created })
        .where('action', '=', action)
        .execute();
    }

    const { entries } = await listAuditEntries(handle.db);
    expect(entries.map((entry) => entry.action)).toEqual([
      'user.role_changed',
      'item.deleted',
      'item.published',
    ]);
  });

  it('filters by action, actor, and subject', async () => {
    expect((await listAuditEntries(handle.db, { action: 'item.deleted' })).total).toBe(1);
    expect((await listAuditEntries(handle.db, { actorId: actor.id })).total).toBe(2);
    expect((await listAuditEntries(handle.db, { subjectType: 'user' })).total).toBe(1);
    expect((await listAuditEntries(handle.db, { subjectId: 'a' })).total).toBe(1);
  });

  it('offers the actions actually present, not a fixed list', async () => {
    // A filter naming an action this deployment has never performed is a filter that finds nothing
    // and tells you nothing about why.
    expect(await listAuditActions(handle.db)).toEqual([
      'item.deleted',
      'item.published',
      'user.role_changed',
    ]);
  });

  it('orders stably when entries share a timestamp', async () => {
    // A cascading move writes several in the same millisecond; without the tiebreak they come back
    // in an order that changes between reads.
    const first = await listAuditEntries(handle.db);
    const second = await listAuditEntries(handle.db);
    expect(first.entries.map((e) => e.id)).toEqual(second.entries.map((e) => e.id));
  });
});

describe('retention', () => {
  it('drops entries older than a date and keeps the rest', async () => {
    await recordAuditEntry(handle.db, { action: 'item.published', subjectType: 'item' });
    await handle.db
      .updateTable('audit_log')
      .set({ created_at: '2020-01-01T00:00:00.000Z' })
      .execute();
    await recordAuditEntry(handle.db, { action: 'item.deleted', subjectType: 'item' });

    expect(await purgeAuditLogBefore(handle.db, new Date('2021-01-01'))).toBe(1);
    expect((await listAuditEntries(handle.db)).total).toBe(1);
  });
});
