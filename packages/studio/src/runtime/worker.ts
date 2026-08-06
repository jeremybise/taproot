import {
  SITE_TAG,
  deferPurge,
  duePurges,
  publishDueItems,
  publishDueReleases,
  purgeExpiredAttempts,
  purgeExpiredPreviewTokens,
  purgeExpiredPurgeQueue,
  purgeExpiredSessions,
  purgeStaleResetTokens,
  resolvePurge,
} from '@taprootcms/core';
import type { Kysely } from 'kysely';
import type { Database } from '@taprootcms/core';

import { createContext, readRuntimeEnv } from './context.js';
import { purgeFromExecutionContext } from './purge.js';
import { purgeSite, sitePurgeConfig } from './sitePurge.js';

/**
 * Replay the purges that failed, which is the only thing that bounds a dropped one.
 *
 * Lives in the `scheduled` handler rather than in `runScheduledTasks` because it needs the
 * `ExecutionContext` to purge with, and `runScheduledTasks` deliberately takes no arguments so it
 * stays callable by hand and from the HTTP route. The split is the same one `purgeInvalidated` and
 * `purgeFromExecutionContext` already make.
 *
 * Sequential rather than parallel, and bounded by `duePurges`' own limit: this runs every five
 * minutes against a production deployment, and finishing a tick later is a better trade than
 * saturating the outbound request budget.
 */
async function drainPurgeQueue(db: Kysely<Database>, ctx: unknown): Promise<void> {
  for (const row of await duePurges(db)) {
    const tags = row.tags ? row.tags.split(',') : [];

    /**
     * Replayed against the cache it was queued for.
     *
     * `target` exists precisely so this branch can be written: the two live in different places and
     * fail for different reasons — a missing binding in this runtime versus an unreachable origin —
     * and replaying a `site` row against the CMS's own cache would purge the wrong thing and then
     * delete the row as delivered.
     *
     * Both are replayed with **no `db`**. Passing one would let a failed retry enqueue a *second*
     * row for the same work, and the queue would grow one row per failure per sweep forever. The
     * existing row is the record; `deferPurge` is how this failure is written onto it.
     *
     * The outcome is read rather than caught, because neither purge throws — a `try`/`catch` here
     * would be dead code and every row would be deleted whether or not its purge landed, which is a
     * retry queue that silently drops the work it exists to retry.
     */
    const outcome =
      row.target === 'site'
        ? await purgeSite(sitePurgeConfig(process.env), tags)
        : await purgeFromExecutionContext(ctx, tags);

    if (outcome.ok) await resolvePurge(db, row.id);
    else await deferPurge(db, row, outcome.error);
  }

  await purgeExpiredPurgeQueue(db);
}

/**
 * The periodic half of Taproot, packaged as a Cloudflare `scheduled()` handler.
 *
 * Scheduled publishing had exactly one supported wiring before this: `POST /api/taproot/scheduler/run`
 * with `TAPROOT_CRON_SECRET` in an `authorization` header, called by something outside the
 * deployment. On Cloudflare — the target this project actually deploys to — that meant a *second*
 * Worker whose entire job was to make one authenticated request into the first, and a shared secret
 * to make that request legitimate. Both exist only because the Worker could not schedule itself.
 *
 * It can. `@astrojs/cloudflare` fills in `main` only when the wrangler config does not
 * (`cloudflareConfigCustomizer`: `main: config.main ?? '@astrojs/cloudflare/entrypoints/server'`),
 * and that default entry is nothing but `{ fetch: handle }`. A host that names its own `main` and
 * re-exports the adapter's `handle` alongside this `scheduled` gets both handlers out of one Worker
 * — see `apps/web/src/worker.ts`, which is the whole of it.
 *
 * The HTTP endpoint stays, and is still the answer off Cloudflare. What changes is that it is no
 * longer the only one, so a Cloudflare deployment needs no secret, no second Worker, and no
 * public URL that publishes content.
 */

/**
 * Duck-typed rather than imported.
 *
 * `@taprootcms/studio` is adapter-agnostic — `npm run dev` runs it on Node — so it must not depend on
 * `@cloudflare/workers-types` to describe an argument it never reads. The adapter's own `hono.d.ts`
 * does the same thing for the same reason.
 */
interface ScheduledControllerLike {
  readonly cron?: string;
  readonly scheduledTime?: number;
}

export interface ScheduledRunResult {
  /**
   * The handle this run used, so the caller can do cache work without opening a second connection.
   *
   * Slightly odd on a result type, and the alternative is worse: `scheduled` needs a database to
   * drain the purge queue with, and `readRuntimeEnv`/`createContext` again would mean two
   * connections per tick to the same D1 binding purely to keep a type tidy.
   */
  db: Kysely<Database>;
  published: { id: string; title: string; path: string }[];
  /** Releases that went live on this run, and the ones the sweep reached and refused. */
  publishedReleases: { id: string; name: string; itemCount: number }[];
  blockedReleases: { id: string; name: string }[];
  /** Expired or spent rows removed. Housekeeping, reported so a run is never silently a no-op. */
  purgedSessions: number;
  purgedResetTokens: number;
  purgedLoginAttempts: number;
}

/**
 * Everything the timer is responsible for, in one call.
 *
 * Exported separately from the handler so it can be tested, and called by hand, without
 * constructing a Cloudflare controller.
 */
export async function runScheduledTasks(): Promise<ScheduledRunResult> {
  const { env, bindings } = await readRuntimeEnv();
  const context = await createContext(env, bindings);
  const db = context.db.db;

  const { published } = await publishDueItems(db);

  /**
   * Releases sweep after individual items, and the order is not arbitrary.
   *
   * A release publishes through `updateItem`, which clears `publish_at` — so a page that was both
   * scheduled on its own and staged in a release would have its own scheduled moment silently
   * discarded if the release went first. Items first means each scheduled page keeps the launch it
   * was given, and the release then applies its staged version on top, which is the order the two
   * decisions were made in.
   */
  const releases = await publishDueReleases(context.db);

  /**
   * Expired sessions, spent reset tokens, and aged-out login attempts ride along here.
   *
   * All three were written to be safe to call on a schedule and none had a caller, so the rows
   * accumulated forever — harmless for correctness, since every read filters by time anyway, and
   * steadily less harmless for tables that only grow. `login_attempts` grows fastest of the three,
   * because it gains a row per failed sign-in and per reset request from anyone on the internet.
   * A timer that already exists is the right place for all of it.
   */
  const purgedSessions = await purgeExpiredSessions(db);
  const purgedResetTokens = await purgeStaleResetTokens(db);
  const purgedLoginAttempts = await purgeExpiredAttempts(db);
  // Preview tokens expire in thirty minutes and are never read again after that; without a
  // sweep the table grows by one row per click on a preview link, forever.
  await purgeExpiredPreviewTokens(db);

  return {
    db,
    published,
    publishedReleases: releases.published,
    blockedReleases: releases.blocked.map(({ id, name }) => ({ id, name })),
    purgedSessions,
    purgedResetTokens,
    purgedLoginAttempts,
  };
}

/**
 * The Cloudflare cron entry point.
 *
 * Awaited rather than handed to `ctx.waitUntil`. `waitUntil` would let the handler return before
 * the sweep finished, which makes every run report success — including the ones that threw. A cron
 * trigger's only feedback channel is whether its handler rejected, so throwing is the feature.
 *
 * `ctx` is read rather than ignored, and that is the whole reason a scheduled publish reaches
 * visitors. This handler never passes through the middleware, so there are no `locals` to record
 * invalidations onto — the sweep has to purge for itself, and its third argument is the
 * `ExecutionContext` that can.
 */
export const scheduled = async (
  _controller: ScheduledControllerLike,
  _env: unknown,
  ctx: unknown,
): Promise<void> => {
  const result = await runScheduledTasks();

  /**
   * Only when something actually went live.
   *
   * The sweep runs every five minutes forever and matches nothing on almost all of them; purging on
   * every tick would keep the cache permanently cold, which is worse than not purging at all.
   *
   * Coarse for the reason the release route is coarse: neither result carries the content type of
   * what it published, and an item going live changes every listing that might now include it.
   *
   * Deliberately **after** the sweep and outside its error path — a run that threw published
   * nothing to invalidate, and `runScheduledTasks` rejecting is how a cron trigger reports failure.
   */
  if (result.published.length > 0 || result.publishedReleases.length > 0) {
    await purgeFromExecutionContext(ctx, [SITE_TAG], { db: result.db });
  }

  /**
   * Replay whatever failed earlier, **after** this run's own purge.
   *
   * Order matters only in the failure case, and it is the cheap direction: if the purge above has
   * just failed for whatever reason the queued ones will too, and doing them second means this
   * tick's row is written before the sweep spends its budget retrying older ones.
   */
  await drainPurgeQueue(result.db, ctx);
};
