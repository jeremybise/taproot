import {
  createDb,
  dbConfigFromEnv,
  resolveAuthConfig,
  resolveMailer,
  storageFromEnv,
  type AuthConfig,
  type D1DatabaseLike,
  type Mailer,
  type R2BucketLike,
  type StorageAdapter,
  type TaprootDb,
  type User,
} from '@taproot/core';

/**
 * Per-request Taproot context, attached to `Astro.locals.taproot`.
 *
 * Everything a route needs — database, storage, auth config, and the signed-in user — arrives
 * through here, so no route reaches for environment variables directly.
 */
export interface TaprootContext {
  db: TaprootDb;
  storage: StorageAdapter;
  auth: AuthConfig;
  /** How mail leaves, or that it does not. See `resolveMailer`. */
  mail: Mailer;
  /** The signed-in user, if any. Populated by the middleware. */
  user?: User;
  /** Raw session token, needed to invalidate on sign-out. */
  sessionToken?: string;
}

export interface RuntimeBindings {
  DB?: D1DatabaseLike;
  MEDIA?: R2BucketLike;
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
  return {
    db: await resolveDb(env, bindings),
    storage: storageFromEnv(env, bindings),
    auth: resolveAuthConfig(env),
    mail: resolveMailer(env),
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
