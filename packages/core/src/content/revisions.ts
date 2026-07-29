import type { Kysely } from 'kysely';

import type { BatchStatement } from '../db/batch.js';
import type {
  ContentStatus,
  Database,
  FieldRow,
  RevisionReason,
  RevisionRow,
} from '../db/schema.js';
import { parseJson, stringifyJson } from '../db/values.js';
import { newId } from '../ids.js';
import type { SeoData } from './items.js';

/**
 * Append-only revision history.
 *
 * This module deliberately holds no item-mutating code. `restoreRevision` lives in `items.ts`
 * instead, because restoring is an item write that has to go through `updateItem` to recompute
 * paths and redirects — putting it here would make `items.ts` and this file import each other.
 * Everything below is either a read or a statement builder, so the dependency runs one way:
 * `items.ts` imports from here, never the reverse.
 */

export class RevisionError extends Error {
  override name = 'RevisionError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'wrong_item' = 'not_found',
  ) {
    super(message);
  }
}

export interface Revision extends Omit<RevisionRow, 'data' | 'seo'> {
  data: Record<string, unknown>;
  seo: SeoData;
}

/** A revision with the display name of whoever saved it, for the history panel. */
export interface RevisionWithAuthor extends Revision {
  author_name: string | null;
  author_email: string | null;
}

export function hydrateRevision(row: RevisionRow): Revision {
  return {
    ...row,
    data: parseJson<Record<string, unknown>>(row.data, {}),
    seo: parseJson<SeoData>(row.seo, {}),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listRevisions(
  db: Kysely<Database>,
  contentItemId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ revisions: RevisionWithAuthor[]; total: number }> {
  const totalRow = await db
    .selectFrom('revisions')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('content_item_id', '=', contentItemId)
    .executeTakeFirst();

  const rows = await db
    .selectFrom('revisions')
    .leftJoin('users', 'users.id', 'revisions.created_by')
    .selectAll('revisions')
    .select(['users.name as author_name', 'users.email as author_email'])
    // Newest first: history is read from the present backwards. Ordering by number rather than
    // created_at because two saves within the same clock tick would otherwise sort arbitrarily.
    .orderBy('revisions.revision_number', 'desc')
    .where('content_item_id', '=', contentItemId)
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0)
    .execute();

  return {
    revisions: rows.map((row) => ({
      ...hydrateRevision(row),
      author_name: row.author_name,
      author_email: row.author_email,
    })),
    total: Number(totalRow?.count ?? 0),
  };
}

export async function getRevision(
  db: Kysely<Database>,
  id: string,
): Promise<Revision | undefined> {
  const row = await db
    .selectFrom('revisions')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? hydrateRevision(row) : undefined;
}

/**
 * The highest revision number an item has, and how many it has at all.
 *
 * Both come from one query because callers need both: the number to allocate the next revision,
 * the count to notice an item that predates its history and backfill a snapshot for it.
 */
export async function revisionSequence(
  db: Kysely<Database>,
  contentItemId: string,
): Promise<{ count: number; latest: number }> {
  const row = await db
    .selectFrom('revisions')
    .select((eb) => [
      eb.fn.countAll<number>().as('count'),
      eb.fn.max<number | null>('revision_number').as('latest'),
    ])
    .where('content_item_id', '=', contentItemId)
    .executeTakeFirst();

  return { count: Number(row?.count ?? 0), latest: Number(row?.latest ?? 0) };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface RevisionSnapshot {
  contentItemId: string;
  revisionNumber: number;
  title: string;
  slug: string;
  path: string;
  status: ContentStatus;
  data: Record<string, unknown>;
  seo: SeoData;
  reason: RevisionReason;
  restoredFrom?: number | null;
  userId?: string | null;
  timestamp: string;
}

/**
 * Build the insert for one revision, to be appended to the caller's batch.
 *
 * Returned as a statement rather than executed, so the snapshot lands in the same atomic write as
 * the item change it describes. A revision that could be written independently of its item would
 * eventually disagree with it.
 */
export function buildRevisionStatement(
  db: Kysely<Database>,
  snapshot: RevisionSnapshot,
): BatchStatement {
  return db.insertInto('revisions').values({
    id: newId(),
    content_item_id: snapshot.contentItemId,
    revision_number: snapshot.revisionNumber,
    title: snapshot.title,
    slug: snapshot.slug,
    path: snapshot.path,
    status: snapshot.status,
    data: stringifyJson(snapshot.data),
    seo: stringifyJson(snapshot.seo),
    reason: snapshot.reason,
    restored_from: snapshot.restoredFrom ?? null,
    created_by: snapshot.userId ?? null,
    created_at: snapshot.timestamp,
  });
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

export interface RevisionChange {
  /** Human-readable name of what changed — a field's label, or Title/Slug/Status. */
  label: string;
  /** `api_id` for content fields; null for the item's own columns. */
  fieldApiId: string | null;
}

/**
 * What changed between two snapshots, as a list of labels for the history panel.
 *
 * Values are compared by their JSON form rather than by identity, which is what the database
 * stores and therefore what actually round-trips. A field whose value is structurally identical
 * but differently ordered would read as changed — acceptable, since the alternative is a deep
 * comparison whose notion of equality would drift from the one the database uses.
 */
export function revisionChanges(
  previous: Pick<Revision, 'title' | 'slug' | 'status' | 'data'> | undefined,
  current: Pick<Revision, 'title' | 'slug' | 'status' | 'data'>,
  fields: FieldRow[],
): RevisionChange[] {
  if (!previous) return [];

  const changes: RevisionChange[] = [];

  if (previous.title !== current.title) changes.push({ label: 'Title', fieldApiId: null });
  if (previous.slug !== current.slug) changes.push({ label: 'Slug', fieldApiId: null });
  if (previous.status !== current.status) changes.push({ label: 'Status', fieldApiId: null });

  for (const field of fields) {
    const before = stringifyJson(previous.data[field.api_id] ?? null);
    const after = stringifyJson(current.data[field.api_id] ?? null);
    if (before !== after) changes.push({ label: field.label, fieldApiId: field.api_id });
  }

  return changes;
}

/**
 * True when a save would produce a snapshot identical to the item's current state.
 *
 * Saving an unchanged form is common — an editor opens an item, thinks better of it, and hits save
 * anyway — and a history full of identical entries is worse than no history, because it buries the
 * saves that meant something.
 */
export function snapshotIsUnchanged(
  before: Pick<Revision, 'title' | 'slug' | 'status' | 'data' | 'seo'>,
  after: Pick<Revision, 'title' | 'slug' | 'status' | 'data' | 'seo'>,
): boolean {
  return (
    before.title === after.title &&
    before.slug === after.slug &&
    before.status === after.status &&
    stringifyJson(before.data) === stringifyJson(after.data) &&
    stringifyJson(before.seo) === stringifyJson(after.seo)
  );
}
