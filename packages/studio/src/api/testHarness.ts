import type { APIContext } from 'astro';
import {
  createDb,
  createUser,
  migrateToLatest,
  resolveAuthConfig,
  type ApiKey,
  type AuthConfig,
  type MailMessage,
  type Mailer,
  type PutOptions,
  type StoredObject,
  type StorageAdapter,
  type TaprootDb,
  type User,
} from '@taprootcms/core';

import type { TaprootContext } from '../runtime/context.js';

/**
 * A harness for driving real API route handlers against a real database.
 *
 * The 30 route files under `api/` had no tests at all. Everything they wrap was covered — the
 * services in core are the most-tested part of the codebase — but the wrapping itself never was:
 * the role gate, the status codes a domain error maps to, form-vs-JSON handling, the `_method`
 * delete convention, and the redirect targets the admin screens depend on. Those are exactly the
 * places a refactor breaks something without a single service test noticing.
 *
 * Deliberately not a mock. An Astro `APIContext` is a plain object as far as these handlers are
 * concerned — they read `request`, `params`, `locals`, `url`, and call `redirect` — so the honest
 * thing is to build one and hand it a real SQLite database. A mocked `db` would only prove the
 * handlers call the methods the mock expects.
 */

export interface Harness {
  db: TaprootDb;
  /** Sign subsequent requests as this user. `undefined` is an anonymous request. */
  as(user: User | undefined): void;
  /**
   * Present subsequent requests as this API key.
   *
   * Separate from `as` rather than overloading it, because the two produce different contexts and
   * the difference is the thing under test: a key sets `principal` and leaves `user` undefined,
   * which is what makes every session-only route refuse it.
   */
  asKey(key: ApiKey | undefined): void;
  user(role: User['role'], email?: string): Promise<User>;
  /** Storage writes land here rather than on disk, so a test can assert on them. */
  storage: FakeStorage;
  /** Mail lands here rather than anywhere, so a test can assert on what was sent — and on what was not. */
  mail: FakeMailer;
  /**
   * The resolved auth config, shared by every context this harness builds.
   *
   * Exposed because several routes branch on it — password sign-in being off is a real deployment
   * and a real code path. Mutating it is the point; reaching through a throwaway `context()` to do
   * the same thing works only by accident of the object being shared.
   */
  auth: AuthConfig;
  /**
   * Run something and report how many database queries it issued.
   *
   * For assertions about cost rather than about output — chiefly that a conditional delivery request
   * answers 304 without resolving the page behind it.
   */
  countQueries<T>(run: () => Promise<T>): Promise<{ value: T; queries: number }>;
  destroy(): Promise<void>;
  /** Build an `APIContext` for a handler. */
  context(init?: ContextInit): APIContext;
}

export interface ContextInit {
  method?: string;
  /** Path and query, e.g. `/api/taproot/items?status=draft`. */
  url?: string;
  params?: Record<string, string>;
  /** Sent as JSON with the matching content-type. */
  json?: unknown;
  /** Sent as a form body, which several routes branch on. */
  form?: Record<string, string>;
  /**
   * A prebuilt `FormData`, for the two things `form` cannot express: files, and a repeated key.
   *
   * The media upload reads `getAll('file')`, so a batch is a repeated key carrying `File`s — and
   * `Record<string, string>` can hold neither. Kept as a separate option rather than widening
   * `form`, because `form`'s URL-encoded body is what most routes are actually posted and a test
   * asserting form-vs-JSON behaviour should keep exercising that path.
   *
   * The content-type header is left to `Request`, which sets `multipart/form-data` with the
   * boundary. Setting it by hand produces a body no parser can read.
   */
  formData?: FormData;
  headers?: Record<string, string>;
}

const ORIGIN = 'http://localhost:4321';

export async function createHarness(): Promise<Harness> {
  const base = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(base.db);
  if (result.error) throw result.error;

  /**
   * Every query counted, so a test can assert what a request *costs* and not only what it answers.
   *
   * The delivery route's conditional branch is the case this exists for: "answers 304" and "answers
   * 304 without resolving the page" are different claims, and only the second one is the point of a
   * validator. A status assertion passes either way, which is how the ETag sat there for a phase
   * saving payload bytes — the thing Cloudflare does not charge for — while every D1 row was read
   * exactly as it would have been for a 200.
   *
   * Counted with a Kysely plugin rather than the `log` option so the handle still comes from
   * `createDb`, the same entry point the runtime uses. Note `batch()` still closes over the original
   * handle, so atomic writes are not counted; this is a read-path instrument.
   */
  let queries = 0;
  const db: TaprootDb = {
    ...base,
    db: base.db.withPlugin({
      transformQuery: (args) => {
        queries += 1;
        return args.node;
      },
      transformResult: async (args) => args.result,
    }),
  };

  const storage = new FakeStorage();
  const mail = new FakeMailer();
  const auth = resolveAuthConfig({ NODE_ENV: 'development' });

  let current: User | undefined;
  let currentKey: ApiKey | undefined;

  return {
    db,
    storage,
    mail,
    auth,
    as(user) {
      current = user;
      // Never both. The middleware resolves a session first and only falls through to a key, so a
      // harness that let the two coexist would test a state the runtime cannot produce.
      currentKey = undefined;
    },
    asKey(key) {
      currentKey = key;
      current = undefined;
    },
    async user(role, email = `${role}@example.com`) {
      return createUser(db.db, { email, name: role, role });
    },
    async countQueries(run) {
      const before = queries;
      const value = await run();
      return { value, queries: queries - before };
    },
    async destroy() {
      await base.destroy();
    },
    context(init: ContextInit = {}) {
      const url = new URL(init.url ?? '/api/taproot/test', ORIGIN);

      const headers: Record<string, string> = { ...(init.headers ?? {}) };
      let body: string | FormData | undefined;

      if (init.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(init.json);
      } else if (init.formData) {
        // No content-type here on purpose — `Request` derives `multipart/form-data` and the
        // boundary from the body, and one written by hand cannot match it.
        body = init.formData;
      } else if (init.form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(init.form).toString();
      }

      const method = init.method ?? (body ? 'POST' : 'GET');
      const request = new Request(url, { method, headers, body });

      /**
       * Collected but never purged, because there is no Cloudflare cache behind a test.
       *
       * Exposed on the returned context all the same, so a test can assert *which* tags a write
       * declared — that is the half of invalidation a unit test can actually check. Whether the
       * purge call reaches Cloudflare is a question for `npm run preview` and a deployed request.
       */
      const invalidated = new Set<string>();

      const taproot: TaprootContext = {
        db,
        storage,
        auth,
        mail,
        /*
         * No keys, so every assistant a test resolves is unconfigured unless the test overrides this.
         * That is the right default in both directions: it exercises the gated path by default, and
         * a suite that accidentally reaches a real provider is a suite that bills somebody.
         */
        aiEnv: {},
        invalidated,
        invalidate(tags) {
          for (const tag of tags) invalidated.add(tag);
        },
        user: current,
        principal: current
          ? { kind: 'user', user: current }
          : currentKey
            ? { kind: 'api_key', key: currentKey }
            : undefined,
      };

      return {
        request,
        url,
        params: init.params ?? {},
        locals: { taproot },
        /**
         * Astro's own `redirect` builds a `Response` with a `Location` header, which is all these
         * handlers depend on. Several of them redirect back to an admin screen with the outcome in
         * the query string, and that target is a contract the screens read.
         */
        redirect(target: string, status = 302) {
          return new Response(null, { status, headers: { location: target } });
        },
      } as unknown as APIContext;
    },
  };
}

/** Read a JSON response body, failing loudly rather than returning `undefined`. */
export async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected a JSON body, got ${response.status}: ${text.slice(0, 200)}`);
  }
}

/**
 * The `Location` of a redirect, decoded for readable assertions.
 *
 * `+` is turned back into a space as well, because these targets are built with `URLSearchParams`,
 * which form-encodes — and `decodeURIComponent` alone leaves the pluses in, so an assertion reads
 * as a failure over punctuation rather than over behaviour.
 */
export function location(response: Response): string {
  const raw = response.headers.get('location') ?? '';
  return decodeURIComponent(raw.replace(/\+/g, ' '));
}

/**
 * An in-memory `StorageAdapter`.
 *
 * The local driver writes to disk and the R2 one needs a bucket; neither belongs in a test of an
 * upload *route*, which cares that bytes were handed to storage and that a delete removed them.
 * Both real adapters get their own tests.
 */
export class FakeStorage implements StorageAdapter {
  readonly name = 'local' as const;
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(
    key: string,
    data: Uint8Array | ArrayBuffer,
    options: PutOptions = {},
  ): Promise<StoredObject> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const contentType = options.contentType ?? 'application/octet-stream';
    this.objects.set(key, { bytes, contentType });
    return { key, size: bytes.byteLength, contentType };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key)?.bytes;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  publicUrl(key: string): string {
    return `/uploads/${key}`;
  }
}

/**
 * A `Mailer` that keeps what it was given.
 *
 * `delivers` is settable because it is a branch the routes take, not a detail: the forgot-password
 * endpoint refuses outright when nothing can be delivered, and that refusal is the behaviour that
 * keeps a deployment from promising a message it will never send.
 */
export class FakeMailer implements Mailer {
  readonly name = 'fake';
  delivers = true;
  readonly sent: MailMessage[] = [];
  /** Set to make the next send throw, standing in for a webhook that is down. */
  failure: Error | undefined;

  async send(message: MailMessage): Promise<void> {
    if (this.failure) throw this.failure;
    this.sent.push(message);
  }

  get last(): MailMessage | undefined {
    return this.sent.at(-1);
  }
}
