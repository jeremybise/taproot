/**
 * Cache purging for the tags a request invalidated.
 *
 * Its own module rather than a helper inside `middleware.ts` so it can be tested: the middleware
 * imports `astro:middleware`, which does not resolve outside an Astro build, and this is the half
 * that has already been wrong in production once.
 */

import { enqueuePurge, type Database } from '@taprootcms/core';
import type { Kysely } from 'kysely';

/** The slice of `ExecutionContext` this needs, named structurally so no adapter type is imported. */
interface CachePurger {
  purge?: (options: { tags: string[] }) => Promise<unknown>;
}

/**
 * Whether the purge landed, for the one caller that has to know.
 *
 * The retry sweep cannot use `try`/`catch` to find out, because "never throws" is a promise this
 * module makes to every *other* caller — so a `catch` around it is dead code that looks
 * load-bearing, and a drained row would be deleted whether or not its purge actually happened.
 * Reporting the outcome is what keeps both properties: silent for a request, answerable for a
 * retry.
 */
export interface PurgeOutcome {
  ok: boolean;
  error?: unknown;
}

export interface PurgeOptions {
  /**
   * Where to record a purge that failed, so the sweep can replay it.
   *
   * Optional because "never throws, never fails the request" has to keep holding when there is no
   * handle to record onto — a queue is an improvement on silence, not a new precondition.
   */
  db?: Kysely<Database>;
}

/**
 * Clear cached responses carrying any of these tags.
 *
 * **Never throws, and never fails the request** — the same rule `recordAuditEntry` follows, and for
 * the same reason: the write this describes has already happened and already been reported as
 * successful. Turning a cache-maintenance problem into a 500 would tell an editor their save failed
 * when it did not, and they would do it again. A purge that does not land costs staleness bounded by
 * `s-maxage`, which is exactly the behaviour every deployment had before tags existed.
 *
 * **The accessor is `locals.cfContext`, and reading the old one *throws*.** This shipped as
 * `locals.runtime?.ctx?.cache`, which Astro v6 removed — and the adapter did not delete the
 * property, it replaced it with a getter that throws a message telling you the new name
 * (`@astrojs/cloudflare/dist/utils/cf-helpers.js`). Optional chaining is no defence: `runtime`
 * exists, so `?.ctx` invokes the getter. The effect was invisible on every read and total on every
 * write, because this runs only when something was invalidated: every editor save 500'd *after*
 * `next()` had already committed the row, so the admin reported a failure that had in fact
 * succeeded — the precise outcome the paragraph above exists to prevent.
 *
 * **Hence the whole read sits inside the `try`.** Before, only `purge()` did, so the promise made
 * above covered the call and not the lookup that reaches it. "Never throws" is a claim about the
 * request, not about one line — an accessor is as able to throw as a method, and this one did.
 *
 * `cache` is optional on `ExecutionContext` and absent under `npm run dev`, where there is no
 * Cloudflare cache to purge. That is correct rather than degraded: nothing cached the response
 * either.
 */
export async function purgeInvalidated(
  locals: unknown,
  tags: Set<string>,
  options: PurgeOptions = {},
): Promise<PurgeOutcome> {
  return purgeFromExecutionContext(
    (locals as { cfContext?: unknown }).cfContext,
    tags,
    options,
  );
}

/**
 * The same purge, from an object that carries `cache` itself rather than under `cfContext`.
 *
 * A Cloudflare **cron trigger** never passes through the middleware — it arrives at `worker.ts`'s
 * `scheduled` export, whose third argument *is* the `ExecutionContext`. That argument was ignored,
 * so a scheduled publish went live in the database on time and the edge kept serving the old page
 * until the TTL lapsed. Harmless at a sixty-second TTL and a full day's staleness at a long one,
 * which is why it had to be fixed before the TTL could be raised.
 *
 * Everything `purgeInvalidated` promises holds here: never throws, and a missing `cache` is a
 * no-op rather than a degradation, because a runtime with no cache stored nothing to begin with.
 */
export async function purgeFromExecutionContext(
  ctx: unknown,
  tags: Iterable<string>,
  options: PurgeOptions = {},
): Promise<PurgeOutcome> {
  const list = [...tags];
  if (list.length === 0) return { ok: true };

  try {
    const cache = (ctx as { cache?: CachePurger } | undefined)?.cache;

    /**
     * No cache means nothing to retry, not a failure to record.
     *
     * This is the `npm run dev` shape and the shape of any Worker deployed without
     * `"cache": { "enabled": true }`. Queueing here would fill the table with rows describing work
     * that never needed doing, and Settings → System would report a problem on a deployment that
     * does not have one.
     */
    if (!cache?.purge) return { ok: true };

    await cache.purge({ tags: list });
    return { ok: true };
  } catch (error) {
    console.error('[taproot] failed to purge cache tags', error);

    // The row is the whole point: a purge that throws here is otherwise invisible, and at a long
    // TTL invisible means a page stays wrong until somebody notices by eye.
    if (options.db) await enqueuePurge(options.db, 'self', list, error);

    return { ok: false, error };
  }
}
