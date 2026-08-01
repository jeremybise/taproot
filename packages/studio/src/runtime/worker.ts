import {
  publishDueItems,
  publishDueReleases,
  purgeExpiredAttempts,
  purgeExpiredSessions,
  purgeStaleResetTokens,
} from '@taproot/core';

import { createContext, readRuntimeEnv } from './context.js';

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
 * `@taproot/studio` is adapter-agnostic — `npm run dev` runs it on Node — so it must not depend on
 * `@cloudflare/workers-types` to describe an argument it never reads. The adapter's own `hono.d.ts`
 * does the same thing for the same reason.
 */
interface ScheduledControllerLike {
  readonly cron?: string;
  readonly scheduledTime?: number;
}

export interface ScheduledRunResult {
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

  return {
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
 */
export const scheduled = async (
  _controller: ScheduledControllerLike,
  _env: unknown,
  _ctx: unknown,
): Promise<void> => {
  await runScheduledTasks();
};
