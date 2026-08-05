import type { Kysely } from 'kysely';

import type { ApiKeyRow, ApiKeyScope, Database } from '../db/schema.js';
import { now, parseJson, stringifyJson } from '../db/values.js';
import { hashSessionToken } from './session.js';

/**
 * API keys — the first principal that is not a person.
 *
 * They exist because a second deployment cannot read content without one, which is why SCOPE moved
 * them up from Phase 5 to arrive with the delivery API. The more interesting effect is on the role
 * model: until now "who is asking" always meant "which user row", and a key is what forces that
 * question to have a second answer.
 *
 * Modelled on `passwordReset.ts` deliberately, down to the hashing helper. `id` **is** the SHA-256
 * of the token, so verification is one indexed lookup rather than a scan over rows, and a database
 * dump contains nothing usable. The raw value exists exactly once — in the response that created
 * it — and there is no endpoint anywhere that can read it back.
 *
 * What a key is *not*: a user with a role. It cannot own content, cannot author a revision, and
 * must never satisfy a check written as "an editor did this". `hasRole` answers false for one, and
 * scopes are the only thing it can be asked about.
 */

/** Every scope that exists. One, and that is the whole delivery API's requirement. */
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ['content:read'];

/**
 * How the token is spelled.
 *
 * A fixed, recognisable prefix so a leaked key is identifiable as one — that is what lets a secret
 * scanner, a log filter, or a person reading a paste recognise what they are looking at. GitHub's
 * `ghp_` convention exists for the same reason and is worth copying.
 */
const TOKEN_PREFIX = 'tpr_';
/** Characters of the raw token kept in the clear, after the prefix, to identify a key in a list. */
const DISPLAY_CHARS = 8;

export class ApiKeyError extends Error {
  override name = 'ApiKeyError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid_scope' | 'revoked' = 'not_found',
  ) {
    super(message);
  }
}

export interface ApiKey extends Omit<ApiKeyRow, 'scopes'> {
  scopes: ApiKeyScope[];
}

function hydrate(row: ApiKeyRow): ApiKey {
  return { ...row, scopes: parseJson<ApiKeyScope[]>(row.scopes, []) };
}

export interface CreatedApiKey {
  key: ApiKey;
  /**
   * The raw token. Exists here and nowhere else — never stored, never logged, never readable again.
   *
   * The caller has exactly one chance to show it, which is why the admin screen reveals it through
   * a short-lived cookie rather than a query string: a URL lands in history, in `Referer`, and in
   * access logs, and this one carries a live credential.
   */
  token: string;
}

export async function createApiKey(
  db: Kysely<Database>,
  input: {
    label: string;
    scopes: ApiKeyScope[];
    expiresAt?: string | null;
    userId?: string | null;
  },
): Promise<CreatedApiKey> {
  const unknown = input.scopes.filter((scope) => !API_KEY_SCOPES.includes(scope));
  if (unknown.length > 0) {
    throw new ApiKeyError(`Unknown scope(s): ${unknown.join(', ')}.`, 'invalid_scope');
  }
  if (input.scopes.length === 0) {
    // A key with no scopes can do nothing, and would sit in the list looking like access.
    throw new ApiKeyError('A key needs at least one scope.', 'invalid_scope');
  }

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const token = `${TOKEN_PREFIX}${secret}`;

  const timestamp = now();
  const row: ApiKeyRow = {
    id: await hashSessionToken(token),
    label: input.label.trim(),
    token_prefix: `${TOKEN_PREFIX}${secret.slice(0, DISPLAY_CHARS)}`,
    scopes: stringifyJson(input.scopes),
    expires_at: input.expiresAt ?? null,
    revoked_at: null,
    last_used_at: null,
    created_by: input.userId ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('api_keys').values(row).execute();

  return { key: hydrate(row), token };
}

/**
 * The key a presented token names, if it is currently usable.
 *
 * Returns `undefined` for absent, malformed, unknown, revoked, and expired alike. The caller must
 * answer identically to all five: distinguishing "no such key" from "revoked key" tells whoever is
 * probing which of their guesses was once real.
 *
 * **This runs per request and is deliberately not memoised.** It looks like an obvious cache — one
 * indexed lookup by primary key, the same answer every time, on the hot path of every delivery
 * read — and a per-isolate cache with a short TTL was measured against and rejected. What it buys
 * is one row read out of roughly ten for a page, on requests that a working edge cache means the
 * Worker never sees at all. What it costs is that **revoking a key stops taking effect
 * immediately**: revocation is the one control a site has when a key leaks, and a window in which
 * a revoked credential still resolves is a strictly worse trade than a row read.
 *
 * `selectAll()` is likewise not a projection worth narrowing. D1 bills rows scanned, this is a
 * single row found by primary key, and every column is used by `hydrate`.
 */
export async function verifyApiKey(
  db: Kysely<Database>,
  token: string | null | undefined,
): Promise<ApiKey | undefined> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return undefined;

  const row = await db
    .selectFrom('api_keys')
    .selectAll()
    .where('id', '=', await hashSessionToken(token))
    .executeTakeFirst();

  if (!row) return undefined;
  if (row.revoked_at !== null) return undefined;
  if (row.expires_at !== null && Date.now() >= new Date(row.expires_at).getTime()) {
    return undefined;
  }

  return hydrate(row);
}

/**
 * Note that a key was used, at minute resolution.
 *
 * Coarse on purpose. The question this column answers is "is anything still using this key", asked
 * before revoking one — and a write per request would put a database round trip on the hot path of
 * every delivery read to sharpen an answer nobody needs to the second.
 *
 * Never throws, for the same reason `recordAuditEntry` never does: the request it describes has
 * already been authorised, and failing it here would turn a bookkeeping problem into a 500.
 */
export async function touchApiKey(db: Kysely<Database>, key: ApiKey): Promise<void> {
  const stamp = now();
  if (key.last_used_at && stamp.slice(0, 16) === key.last_used_at.slice(0, 16)) return;

  try {
    await db
      .updateTable('api_keys')
      .set({ last_used_at: stamp })
      .where('id', '=', key.id)
      .execute();
  } catch (error) {
    console.error('[taproot] failed to record API key use', error);
  }
}

export async function listApiKeys(db: Kysely<Database>): Promise<ApiKey[]> {
  const rows = await db
    .selectFrom('api_keys')
    // Live keys first, then revoked ones — the list is a worklist before it is a record.
    .selectAll()
    .orderBy((eb) => eb.case().when('revoked_at', 'is', null).then(0).else(1).end(), 'asc')
    .orderBy('created_at', 'desc')
    .execute();

  return rows.map(hydrate);
}

export async function getApiKey(db: Kysely<Database>, id: string): Promise<ApiKey | undefined> {
  const row = await db.selectFrom('api_keys').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? hydrate(row) : undefined;
}

/**
 * Revoke a key. Not a delete.
 *
 * The audit log records that a key was created and by whom, and entries name it by id; deleting the
 * row would leave those pointing at something nothing can resolve. Same reasoning as deactivating a
 * user rather than removing them.
 *
 * Conditional on it not already being revoked, and the row count is checked, so revoking twice does
 * not move the timestamp — the moment access ended is a fact, and a second click should not rewrite
 * it.
 */
export async function revokeApiKey(db: Kysely<Database>, id: string): Promise<ApiKey> {
  const existing = await getApiKey(db, id);
  if (!existing) throw new ApiKeyError(`API key ${id} not found.`);

  const timestamp = now();
  await db
    .updateTable('api_keys')
    .set({ revoked_at: timestamp, updated_at: timestamp })
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .execute();

  return (await getApiKey(db, id))!;
}

/** Whether this key carries a scope. The only question a key can be asked. */
export function apiKeyHasScope(key: ApiKey | undefined, scope: ApiKeyScope): boolean {
  return key?.scopes.includes(scope) ?? false;
}

/**
 * Read a bearer token out of an `authorization` header.
 *
 * Only `Bearer`, and only an exact prefix match. Accepting a bare token or a case-insensitive
 * scheme would widen what counts as a credential for no benefit.
 */
export function bearerToken(header: string | null | undefined): string | undefined {
  if (!header || !header.startsWith('Bearer ')) return undefined;
  const value = header.slice('Bearer '.length).trim();
  return value || undefined;
}
