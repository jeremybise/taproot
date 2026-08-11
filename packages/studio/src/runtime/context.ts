import {
  createDb,
  dbConfigFromEnv,
  resolveAuthConfig,
  resolveMailer,
  type AiEnv,
  storageFromEnv,
  type AuthConfig,
  type D1DatabaseLike,
  type ImagesBindingLike,
  type Mailer,
  type R2BucketLike,
  type StorageAdapter,
  type TaprootDb,
  type User,
  type WebhookEventInput,
} from '@taprootcms/core';

import type { Principal } from './guards.js';

/**
 * Per-request Taproot context, attached to `Astro.locals.taproot`.
 *
 * Everything a route needs — database, storage, auth config, and the signed-in user — arrives
 * through here, so no route reaches for environment variables directly.
 */
export interface TaprootContext {
  db: TaprootDb;
  storage: StorageAdapter;
  /**
   * The image resizer, when the deployment has one.
   *
   * Carried here rather than read from the environment in the route, following the rule this
   * interface's own comment states: nothing below reaches for bindings directly. Undefined is a
   * supported state, not a misconfiguration — see `resizeImage`.
   */
  images?: ImagesBindingLike;
  auth: AuthConfig;
  /** How mail leaves, or that it does not. See `resolveMailer`. */
  mail: Mailer;
  /**
   * The AI provider keys, and only the keys.
   *
   * Carried here for the reason `images` is — nothing below this interface reaches for the
   * environment itself. Deliberately *not* a resolved `Assistant`: that needs the settings row, and
   * building one per request would put a query on every page view to answer a question only a
   * handful of screens ask. `assistantFor` in `ai.ts` is the pairing, called where it is needed.
   */
  aiEnv: AiEnv;
  /** The signed-in user, if any. Populated by the middleware. */
  user?: User;
  /**
   * Who is asking, which since the delivery API is no longer always a person.
   *
   * `user` is kept alongside rather than derived at every call site, because it is what every admin
   * screen and role guard actually wants, and it is `undefined` for an API key — so a screen that
   * reads it gets the safe answer without knowing principals exist. The two cannot disagree: the
   * middleware sets both from the same resolution.
   */
  principal?: Principal;
  /** Raw session token, needed to invalidate on sign-out. */
  sessionToken?: string;
  /**
   * Declare that a write has invalidated some cached responses.
   *
   * Routes call this; the **middleware** performs the purge once, after the response is produced.
   * Two reasons it is split that way. The Workers cache API hangs off the request's
   * `ExecutionContext`, which no service in core can see and which does not exist under Node at all
   * — keeping the one call in the middleware means exactly one place knows that. And a purge must
   * not run before the write it describes has committed, which at a route boundary is a thing you
   * have to remember and after `next()` is a thing you cannot get wrong.
   *
   * Accumulating rather than purging per call, so a request that touches several items sends one
   * purge instead of one per item.
   */
  invalidate(tags: Iterable<string>): void;
  /** What `invalidate` has collected. Read by the middleware; not for routes. */
  readonly invalidated: Set<string>;
  /**
   * Declare that a write produced something an integration asked to hear about.
   *
   * Deliberately the same shape as `invalidate`, and for the same two reasons. The dispatch has to
   * happen **after** the write has committed — a receiver told "published" while the old row is
   * still the committed one will fetch the previous version, which is the exact race purging inside
   * a write path already loses. And a request that changes several things sends one batch, which is
   * one endpoint lookup rather than one per event.
   *
   * A route calling this does not mean anything is sent: whether an event has a subscriber is a
   * question for the dispatcher, and nearly always the answer is no.
   */
  emit(event: WebhookEventInput): void;
  /** What `emit` has collected. Read by the middleware; not for routes. */
  readonly emitted: WebhookEventInput[];
}

export interface RuntimeBindings {
  DB?: D1DatabaseLike;
  MEDIA?: R2BucketLike;
  /**
   * Cloudflare Images. Optional in the strongest sense — the media route resizes when it is bound
   * and serves the stored original when it is not, so a Node deployment and an operator who never
   * added the binding both get correct pages rather than broken ones.
   */
  IMAGES?: ImagesBindingLike;
}

/**
 * A Node process handles many requests from one module instance, and opening a SQLite file per
 * request would be wasteful and would fight over the WAL lock. The handle is therefore cached.
 *
 * D1 deliberately does **not** use this cache: its binding comes from the request's `env` and is
 * cheap to wrap, and caching it across requests in a Worker isolate would pin a binding from one
 * request onto another.
 */
let cachedDb: Promise<TaprootDb> | undefined;

export async function resolveDb(
  env: Record<string, string | undefined>,
  bindings: RuntimeBindings,
): Promise<TaprootDb> {
  const config = dbConfigFromEnv(env, bindings);

  if (config.driver === 'd1') {
    return createDb(config);
  }

  cachedDb ??= createDb(config);
  return cachedDb;
}

/** Reset the cached handle. Used by tests and by the dev server on config reload. */
export async function resetDbCache(): Promise<void> {
  const existing = cachedDb;
  cachedDb = undefined;
  if (existing) await (await existing).destroy();
}

export async function createContext(
  env: Record<string, string | undefined>,
  bindings: RuntimeBindings,
): Promise<TaprootContext> {
  const invalidated = new Set<string>();
  const emitted: WebhookEventInput[] = [];

  return {
    db: await resolveDb(env, bindings),
    storage: storageFromEnv(env, bindings),
    images: bindings.IMAGES,
    auth: resolveAuthConfig(env),
    mail: resolveMailer(env),
    // Only the three keys, picked out explicitly rather than passing `env` through — so the shape of
    // what AI can see is readable here instead of implied by whatever the adapters happen to read.
    aiEnv: {
      TAPROOT_ANTHROPIC_API_KEY: env.TAPROOT_ANTHROPIC_API_KEY,
      TAPROOT_OPENAI_API_KEY: env.TAPROOT_OPENAI_API_KEY,
      TAPROOT_GEMINI_API_KEY: env.TAPROOT_GEMINI_API_KEY,
    },
    invalidated,
    invalidate(tags) {
      for (const tag of tags) invalidated.add(tag);
    },
    emitted,
    emit(event) {
      emitted.push(event);
    },
  };
}

/**
 * Collect environment variables and Cloudflare bindings for the current request.
 *
 * Astro 7 removed `Astro.locals.runtime.env`; on Workers, configuration and bindings now come from
 * the `cloudflare:workers` module. That module does not exist in Node, so it is loaded through a
 * variable specifier — which both defeats static bundler resolution and lets the failure be caught
 * and fall back to `process.env`.
 *
 * The result is cached because the answer cannot change within a running process.
 */
let cachedRuntime: { env: Record<string, string | undefined>; bindings: RuntimeBindings } | undefined;

export async function readRuntimeEnv(): Promise<{
  env: Record<string, string | undefined>;
  bindings: RuntimeBindings;
}> {
  if (cachedRuntime) return cachedRuntime;

  const env: Record<string, string | undefined> = {};
  const bindings: RuntimeBindings = {};

  try {
    const specifier = 'cloudflare:workers';
    const workers = (await import(/* @vite-ignore */ specifier)) as {
      env?: Record<string, unknown>;
    };

    for (const [key, value] of Object.entries(workers.env ?? {})) {
      if (typeof value === 'string') {
        env[key] = value;
      } else if (key === 'DB') {
        bindings.DB = value as D1DatabaseLike;
      } else if (key === 'MEDIA') {
        bindings.MEDIA = value as R2BucketLike;
      } else if (key === 'IMAGES') {
        bindings.IMAGES = value as ImagesBindingLike;
      }
    }
  } catch {
    // Not running on Workers — Node development, or the CLI scripts.
  }

  // Fold in process variables as a fallback so `.env` settings are visible in both environments.
  if (typeof process !== 'undefined' && process.env) {
    for (const [key, value] of Object.entries(process.env)) {
      env[key] ??= value;
    }
  }

  cachedRuntime = { env, bindings };
  return cachedRuntime;
}
