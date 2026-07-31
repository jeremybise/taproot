import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import type { ContentItem } from './items.js';
import { now } from '../db/values.js';
import { hydrateItem } from './items.js';
import { recordAuditEntry } from './auditLog.js';

/**
 * Scheduled publishing.
 *
 * `scheduled` has been a real status with a colour and a filter option since Phase 1, and nothing
 * ever flipped one live — the seed included one specifically so the gap would be visible rather
 * than theoretical.
 *
 * Two halves, and both are needed for different reasons:
 *
 *  - **Visibility is computed on read.** A scheduled item whose time has passed is served to
 *    visitors whether or not a sweep has run. That is what makes "goes live at 9am" true on a
 *    deployment where nobody wired up a cron — which is every deployment on its first day, and
 *    most small ones forever.
 *  - **Status is swept on a timer.** The read rule alone would leave the admin saying "scheduled"
 *    about a page the public can already see, and leave `published_at` empty for something that is
 *    demonstrably published. The sweep makes the record agree with reality.
 *
 * Doing only the sweep would mean a missed cron silently holds a launch. Doing only the read rule
 * would mean the CMS lies about its own content. Neither alone is the feature.
 */

/** Items whose scheduled time has arrived but whose status has not caught up. */
export async function dueForPublishing(
  db: Kysely<Database>,
  limit = 100,
): Promise<ContentItem[]> {
  const rows = await db
    .selectFrom('content_items')
    .selectAll()
    .where('status', '=', 'scheduled')
    .where('publish_at', 'is not', null)
    .where('publish_at', '<=', now())
    .orderBy('publish_at')
    .limit(limit)
    .execute();

  return rows.map(hydrateItem);
}

export interface SchedulerStatus {
  /** Items waiting for their moment, whether or not it has arrived. */
  waiting: number;
  /** Of those, the ones whose moment has passed and whose status has not caught up. */
  due: number;
  /**
   * When the sweep last published something, or `null` if it never has.
   *
   * Read from the audit log rather than a stored heartbeat: `item.published` with no actor can only
   * have come from `publishDueItems`, because every other path to that action has a person on it.
   */
  lastSweptAt: string | null;
}

/**
 * What an operator needs to answer "is scheduled publishing actually running here".
 *
 * `due` is the load-bearing number and the only reliable one. A sweep that finds nothing writes
 * nothing, so on a site that schedules content rarely `lastSweptAt` can be months old with a
 * perfectly healthy cron — it says when the sweep last *did* something, never when it last ran.
 * A non-zero `due` that persists is the signal that nothing is sweeping, which is why the admin
 * leads with it.
 */
export async function schedulerStatus(db: Kysely<Database>): Promise<SchedulerStatus> {
  const counts = await db
    .selectFrom('content_items')
    .select((eb) => [
      eb.fn.countAll<number>().as('waiting'),
      eb.fn
        .sum<number>(
          eb
            .case()
            .when(eb.and([eb('publish_at', 'is not', null), eb('publish_at', '<=', now())]))
            .then(1)
            .else(0)
            .end(),
        )
        .as('due'),
    ])
    .where('status', '=', 'scheduled')
    .executeTakeFirst();

  const swept = await db
    .selectFrom('audit_log')
    .select('created_at')
    .where('action', '=', 'item.published')
    .where('actor_id', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  return {
    waiting: Number(counts?.waiting ?? 0),
    due: Number(counts?.due ?? 0),
    lastSweptAt: swept?.created_at ?? null,
  };
}

export interface SweepResult {
  published: { id: string; title: string; path: string }[];
}

/**
 * Publish everything whose time has come.
 *
 * Deliberately **not** routed through `updateItem`. That path recomputes paths, cascades a subtree,
 * writes redirects, and appends a revision — all correct for an edit, and all wrong here: nothing
 * about the content changed, only the status, and appending a revision per scheduled item would
 * fill the history with entries nobody wrote. The status and `published_at` are the whole change.
 *
 * Each item is its own update rather than one bulk statement, so `published_at` is the moment the
 * sweep reached it and one failure cannot take the batch with it.
 */
export async function publishDueItems(
  db: Kysely<Database>,
  limit = 100,
): Promise<SweepResult> {
  const due = await dueForPublishing(db, limit);
  const published: SweepResult['published'] = [];

  for (const item of due) {
    const timestamp = now();

    /**
     * Conditional on the status still being `scheduled`, and the row count is checked.
     *
     * Two sweeps overlapping — a cron firing while an admin screen triggers one — would otherwise
     * both publish the same item and both write an audit entry for it. Only one can move the
     * status off `scheduled`.
     */
    const result = await db
      .updateTable('content_items')
      .set({
        status: 'published',
        published_at: timestamp,
        /**
         * Cleared here as well as in `updateItem`, because this path does not go through it.
         *
         * Leaving the time behind is the booby trap `updateItem` already guards against: schedule
         * the page again months later without picking a new time and it inherits one in the past,
         * which is to say it goes live immediately.
         */
        publish_at: null,
        updated_at: timestamp,
      })
      .where('id', '=', item.id)
      .where('status', '=', 'scheduled')
      .executeTakeFirst();

    if (Number(result.numUpdatedRows ?? 0) === 0) continue;

    await recordAuditEntry(db, {
      action: 'item.published',
      subjectType: 'item',
      subjectId: item.id,
      subjectLabel: item.title,
      // No actor. The scheduler is not a person, and naming the admin who happened to trigger the
      // sweep would credit them with a decision somebody else made days ago.
      actor: null,
      detail: { from: 'scheduled', to: 'published', path: item.path, scheduled: true },
    });

    published.push({ id: item.id, title: item.title, path: item.path });
  }

  return { published };
}
