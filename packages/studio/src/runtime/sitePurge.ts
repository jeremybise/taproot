/**
 * Telling a consumer's cache to drop what a write just changed.
 *
 * **Cloudflare scopes purging to the Worker that owns the cache**, so `ctx.cache.purge()` in this
 * deployment reaches this deployment's cached JSON and nothing else. The site renders HTML from that
 * JSON into a cache of its own, and nothing in the CMS can touch it — which is why SCOPE.md deferred
 * this as "the site-side purge loop" and why, until now, a consumer's HTML was bounded only by its
 * own `s-maxage`. That was survivable at sixty seconds and is not at a day.
 *
 * Its own module rather than a helper inside `middleware.ts`, for the reason `purge.ts` is one: the
 * middleware imports `astro:middleware`, which does not resolve outside an Astro build, and this is
 * a half that has to be testable.
 *
 * **The tags travel in the body even though the consumer flushes everything.** A site cannot derive
 * its own dependencies — `/delivery/items` and `/delivery/menu` expose no `cacheTags`, so a listing
 * page has no way to know what it depended on — which is why the handler on the other side purges
 * wholesale. Sending the tags anyway costs nothing, is already computed, and means precision can be
 * added later without a second version of this request.
 */

import { PURGE_PATH, PURGE_SECRET_HEADER, enqueuePurge, type Database } from '@taprootcms/core';
import type { Kysely } from 'kysely';

import type { PurgeOutcome } from './purge.js';

export interface SitePurgeConfig {
  url: string;
  secret: string;
}

/**
 * Where to send a purge, or `undefined` when this deployment has no consumer to tell.
 *
 * **Both halves or nothing.** A URL with no secret would mean POSTing to an endpoint that must then
 * either reject it or, worse, accept an unauthenticated flush from anyone who guessed the path — so
 * a half-configured deployment behaves exactly like an unconfigured one rather than like a broken
 * one. That is the same shape as the mailer: absent configuration is a supported state, not an
 * error, because `npm run dev` and every single-deployment install have to keep working untouched.
 *
 * Deliberately **not** derived from `TAPROOT_SITE_URL`. That names where an editor's preview link
 * points; this names an endpoint that accepts an authenticated write. Deriving one from the other
 * would mean turning on a write surface as a side effect of configuring a link.
 */
export function sitePurgeConfig(env: {
  TAPROOT_SITE_PURGE_URL?: string;
  TAPROOT_SITE_PURGE_SECRET?: string;
}): SitePurgeConfig | undefined {
  const url = env.TAPROOT_SITE_PURGE_URL?.trim();
  const secret = env.TAPROOT_SITE_PURGE_SECRET?.trim();

  return url && secret ? { url, secret } : undefined;
}

/** The default endpoint for a site served from `origin`, used by the docs and the scaffolder. */
export function defaultSitePurgeUrl(origin: string): string {
  return new URL(PURGE_PATH, origin).toString();
}

export interface SitePurgeOptions {
  /** Where to record a failure, so the sweep can replay it. */
  db?: Kysely<Database>;
  /** Injected in tests; `globalThis.fetch` otherwise. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Ask the consumer to drop its cached HTML.
 *
 * **Never throws**, exactly as `purgeInvalidated` never throws and for the same reason: the write
 * this describes has already committed and already been reported successful to the editor. An
 * unreachable site must not turn a save that worked into a 500.
 *
 * A failure is queued rather than swallowed, because silence is what makes a dropped purge cost a
 * whole TTL instead of one sweep interval — and a consumer over HTTP is far likelier to be briefly
 * unreachable than a cache binding in the same runtime.
 */
export async function purgeSite(
  config: SitePurgeConfig | undefined,
  tags: Iterable<string>,
  options: SitePurgeOptions = {},
): Promise<PurgeOutcome> {
  if (!config) return { ok: true };

  const list = [...tags];
  const doFetch = options.fetch ?? globalThis.fetch;

  try {
    const response = await doFetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [PURGE_SECRET_HEADER]: config.secret,
      },
      body: JSON.stringify({ tags: list }),
    });

    /**
     * A non-2xx is a failure worth retrying, and worth *recording* even when it is not.
     *
     * A 401 means the secrets disagree and no number of retries will fix it — which is precisely
     * what the attempt ceiling and Settings → System exist to surface. Treating only network errors
     * as failures would let a permanently misconfigured secret look like a working purge forever.
     */
    if (!response.ok) {
      const error = new Error(`site purge failed with ${response.status}`);
      console.error('[taproot] site cache purge rejected', error);
      if (options.db) await enqueuePurge(options.db, 'site', list, error);
      return { ok: false, error };
    }

    return { ok: true };
  } catch (error) {
    console.error('[taproot] could not reach the site to purge its cache', error);
    if (options.db) await enqueuePurge(options.db, 'site', list, error);
    return { ok: false, error };
  }
}
