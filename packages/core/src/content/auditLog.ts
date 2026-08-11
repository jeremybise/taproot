import type { Kysely } from 'kysely';

import type { AuditLogRow, Database, User } from '../db/schema.js';
import { now, parseJson, stringifyJson } from '../db/values.js';
import { newId } from '../ids.js';

/**
 * Who did what.
 *
 * Append-only: nothing here updates or deletes, and nothing else should either. A log that can be
 * tidied by whoever it embarrasses is not a log. The one exception is retention, which is a
 * deliberate, dated sweep rather than a targeted delete — see `purgeAuditLogBefore`.
 *
 * Writes are **best-effort and never block the action they describe**. Failing a publish because
 * the log write failed would trade a real capability for a record of it, and an editor cannot act
 * on "audit log unavailable". A failure is reported to the server console, where it belongs.
 */

export type AuditSubjectType =
  | 'item'
  | 'content_type'
  | 'user'
  | 'media'
  | 'taxonomy'
  | 'reusable_block'
  | 'redirect'
  | 'release'
  | 'api_key'
  | 'webhook';

export interface AuditEntryInput {
  /** Dotted verb: `item.published`, `user.two_factor_cleared`. Past tense — it already happened. */
  action: string;
  subjectType: AuditSubjectType;
  subjectId?: string | null;
  /** What it was called at the time, so the entry still reads after the subject is gone. */
  subjectLabel?: string | null;
  /** The user responsible, or null for something the system did — the scheduler, say. */
  actor?: Pick<User, 'id' | 'email'> | null;
  detail?: Record<string, unknown> | null;
}

export async function recordAuditEntry(
  db: Kysely<Database>,
  input: AuditEntryInput,
): Promise<void> {
  try {
    await db
      .insertInto('audit_log')
      .values({
        id: newId(),
        actor_id: input.actor?.id ?? null,
        /**
         * Copied rather than joined. The point of a log is what was true *then*: an entry reading
         * "someone@campus.edu deleted Admissions" stays meaningful after both the person and the
         * page are gone, where a join would render it as two nulls.
         */
        actor_email: input.actor?.email ?? null,
        action: input.action,
        subject_type: input.subjectType,
        subject_id: input.subjectId ?? null,
        subject_label: input.subjectLabel ?? null,
        detail: input.detail ? stringifyJson(input.detail) : null,
        created_at: now(),
      })
      .execute();
  } catch (error) {
    // Never rethrow. The action it describes has already happened, and failing it now would undo
    // nothing while losing the thing that did succeed.
    console.error('[taproot] failed to write audit entry', input.action, error);
  }
}

export interface AuditEntry extends Omit<AuditLogRow, 'detail'> {
  detail: Record<string, unknown> | null;
}

export interface ListAuditOptions {
  action?: string;
  actorId?: string;
  subjectType?: AuditSubjectType;
  subjectId?: string;
  limit?: number;
  offset?: number;
}

export async function listAuditEntries(
  db: Kysely<Database>,
  options: ListAuditOptions = {},
): Promise<{ entries: AuditEntry[]; total: number }> {
  let query = db.selectFrom('audit_log');

  if (options.action) query = query.where('action', '=', options.action);
  if (options.actorId) query = query.where('actor_id', '=', options.actorId);
  if (options.subjectType) query = query.where('subject_type', '=', options.subjectType);
  if (options.subjectId) query = query.where('subject_id', '=', options.subjectId);

  const totalRow = await query
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirst();

  const rows = await query
    .selectAll()
    // Ordered by id as well as time: two entries written in the same millisecond — a cascading
    // move writes several — would otherwise come back in an order that changes between reads.
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(options.limit ?? 100)
    .offset(options.offset ?? 0)
    .execute();

  return {
    entries: rows.map((row) => ({
      ...row,
      detail: row.detail ? parseJson<Record<string, unknown>>(row.detail, {}) : null,
    })),
    total: Number(totalRow?.count ?? 0),
  };
}

/** The distinct actions present, so a filter can offer what exists rather than a fixed list. */
export async function listAuditActions(db: Kysely<Database>): Promise<string[]> {
  const rows = await db
    .selectFrom('audit_log')
    .select('action')
    .distinct()
    .orderBy('action')
    .execute();

  return rows.map((row) => row.action);
}

/**
 * Retention: drop everything older than a date.
 *
 * The only deletion this module offers, and deliberately blunt — a sweep by age rather than
 * anything that can be aimed. "Delete entries about me" and "delete entries from last Tuesday" are
 * the two capabilities an audit log must not have.
 */
export async function purgeAuditLogBefore(
  db: Kysely<Database>,
  before: Date,
  /**
   * Most rows to remove in one call, or omitted for all of them.
   *
   * A bound rather than a throttle: the first sweep after retention is switched on may face a table
   * that has grown since the deployment was built, and one unbounded delete over hundreds of
   * thousands of rows is a statement long enough to hit a runtime limit on the one path that runs
   * unattended. `purgeExpiredLogs` passes it; a caller doing this by hand need not.
   */
  limit?: number,
): Promise<number> {
  const cutoff = before.toISOString();

  /**
   * Two shapes, because `delete … limit` is not portable.
   *
   * SQLite only supports it when compiled with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, which is not
   * something a deployment on D1 gets to check. Selecting the ids first and deleting by primary key
   * works everywhere, and the subquery is served by `audit_log_created_idx`.
   */
  const result =
    limit === undefined
      ? await db.deleteFrom('audit_log').where('created_at', '<', cutoff).executeTakeFirst()
      : await db
          .deleteFrom('audit_log')
          .where('id', 'in', (eb) =>
            eb
              .selectFrom('audit_log')
              .select('id')
              .where('created_at', '<', cutoff)
              .limit(limit),
          )
          .executeTakeFirst();

  return Number(result.numDeletedRows ?? 0);
}
