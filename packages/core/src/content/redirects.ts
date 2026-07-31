import type { Kysely } from 'kysely';

import type { Database, RedirectRow } from '../db/schema.js';
import { now } from '../db/values.js';
import { newId } from '../ids.js';
import { normalizePath } from './paths.js';

/**
 * Author-created redirects.
 *
 * The automatic half — a redirect written for every path change — has existed since Phase 1 and
 * lives in `items.ts`, where it rides the same atomic batch as the move. This is the other half
 * SCOPE asks for: a redirect somebody types in, for a URL that was never a Taproot page at all.
 * Migrating a site is the case that needs it, and it is most of why anyone wants the feature.
 *
 * `source` has carried a `manual` variant since the table was created, documented as "author-created
 * and never GC'd", and nothing has ever written one.
 */

export class RedirectError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'conflict' | 'not_found',
  ) {
    super(message);
    this.name = 'RedirectError';
  }
}

export interface RedirectInput {
  fromPath: string;
  toPath: string;
  statusCode?: number;
}

/**
 * Schemes a redirect target may use.
 *
 * The same defence `resolveTarget` applies to menu URLs, and for the same reason: `to_path` is
 * handed to a `Location` header, and `javascript:` in a redirect is a stored XSS that fires on a
 * URL nobody is looking at.
 */
const SAFE_ABSOLUTE = /^https?:\/\//i;

function normalizeTarget(raw: string): string {
  const value = raw.trim();
  if (value === '') throw new RedirectError('A redirect needs somewhere to go.', 'invalid');
  if (SAFE_ABSOLUTE.test(value)) return value;
  if (value.includes(':')) {
    throw new RedirectError(
      'A redirect target must be a path or an http(s) URL.',
      'invalid',
    );
  }
  return normalizePath(value);
}

function normalizeSource(raw: string): string {
  const value = raw.trim();
  if (value === '') throw new RedirectError('A redirect needs a path to match.', 'invalid');
  if (value.includes(':')) {
    throw new RedirectError('The "from" side must be a path on this site.', 'invalid');
  }

  const path = normalizePath(value);
  if (path === '/') {
    // Redirecting the home page away from itself makes the site unreachable at its own root, and
    // the resolver would never look past it.
    throw new RedirectError('The home page cannot redirect.', 'invalid');
  }
  return path;
}

export async function listRedirects(
  db: Kysely<Database>,
  options: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ redirects: RedirectRow[]; total: number }> {
  let query = db.selectFrom('redirects');

  const search = options.search?.trim().toLowerCase();
  if (search) {
    // Lowercased on both sides, matching `listMedia` — SQLite's `like` is case-insensitive for
    // ASCII and Postgres's is not, so the dialects would otherwise disagree.
    query = query.where((eb) =>
      eb.or([
        eb(eb.fn('lower', ['from_path']), 'like', `%${search}%`),
        eb(eb.fn('lower', ['to_path']), 'like', `%${search}%`),
      ]),
    );
  }

  const totalRow = await query
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirst();

  const redirects = await query
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(options.limit ?? 100)
    .offset(options.offset ?? 0)
    .execute();

  return { redirects, total: Number(totalRow?.count ?? 0) };
}

export async function getRedirectById(
  db: Kysely<Database>,
  id: string,
): Promise<RedirectRow | undefined> {
  return db.selectFrom('redirects').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function createRedirect(
  db: Kysely<Database>,
  input: RedirectInput,
): Promise<RedirectRow> {
  const fromPath = normalizeSource(input.fromPath);
  const toPath = normalizeTarget(input.toPath);
  const statusCode = input.statusCode === 302 ? 302 : 301;

  await assertUsable(db, fromPath, toPath);

  const existing = await db
    .selectFrom('redirects')
    .select('id')
    .where('from_path', '=', fromPath)
    .executeTakeFirst();

  if (existing) {
    throw new RedirectError(`A redirect from ${fromPath} already exists.`, 'conflict');
  }

  const row = {
    id: newId(),
    from_path: fromPath,
    to_path: toPath,
    status_code: statusCode,
    source: 'manual' as const,
    content_item_id: null,
    created_at: now(),
  };

  await db.insertInto('redirects').values(row).execute();
  return row;
}

export async function updateRedirect(
  db: Kysely<Database>,
  id: string,
  input: Partial<RedirectInput>,
): Promise<RedirectRow> {
  const existing = await getRedirectById(db, id);
  if (!existing) throw new RedirectError('Redirect not found.', 'not_found');

  const fromPath =
    input.fromPath === undefined ? existing.from_path : normalizeSource(input.fromPath);
  const toPath = input.toPath === undefined ? existing.to_path : normalizeTarget(input.toPath);
  const statusCode =
    input.statusCode === undefined ? existing.status_code : input.statusCode === 302 ? 302 : 301;

  await assertUsable(db, fromPath, toPath);

  if (fromPath !== existing.from_path) {
    const clash = await db
      .selectFrom('redirects')
      .select('id')
      .where('from_path', '=', fromPath)
      .executeTakeFirst();
    if (clash) throw new RedirectError(`A redirect from ${fromPath} already exists.`, 'conflict');
  }

  await db
    .updateTable('redirects')
    .set({ from_path: fromPath, to_path: toPath, status_code: statusCode })
    .where('id', '=', id)
    .execute();

  return (await getRedirectById(db, id))!;
}

export async function deleteRedirect(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom('redirects').where('id', '=', id).execute();
}

/**
 * Checks that apply to both create and update.
 *
 * The loop check walks the existing table rather than looking one hop ahead. `/a → /b` where
 * `/b → /a` already exists is a browser redirect loop, and it is exactly the mistake someone makes
 * when tidying up a migration by hand — the two rows look fine individually.
 */
async function assertUsable(
  db: Kysely<Database>,
  fromPath: string,
  toPath: string,
): Promise<void> {
  if (fromPath === toPath) {
    throw new RedirectError('A redirect cannot point at itself.', 'invalid');
  }

  // An absolute URL leaves the site, so no chain here can come back.
  if (SAFE_ABSOLUTE.test(toPath)) return;

  const seen = new Set<string>([fromPath]);
  let cursor = toPath;

  for (let hop = 0; hop < 25; hop += 1) {
    if (seen.has(cursor)) {
      throw new RedirectError(
        `That would create a redirect loop: ${[...seen, cursor].join(' → ')}.`,
        'invalid',
      );
    }
    seen.add(cursor);

    const next: { to_path: string } | undefined = await db
      .selectFrom('redirects')
      .select('to_path')
      .where('from_path', '=', cursor)
      .executeTakeFirst();

    if (!next) return;
    if (SAFE_ABSOLUTE.test(next.to_path)) return;
    cursor = next.to_path;
  }
}

/**
 * Whether a live item already occupies this path.
 *
 * Not an error — the catch-all resolves an item before it looks at the redirect table, so the row
 * is simply inert until the item moves away. Surfaced so the admin can say so rather than leaving
 * someone to wonder why a redirect they just added does nothing.
 */
export async function redirectIsShadowed(
  db: Kysely<Database>,
  fromPath: string,
): Promise<boolean> {
  const item = await db
    .selectFrom('content_items')
    .select('id')
    .where('path', '=', fromPath)
    .executeTakeFirst();

  return Boolean(item);
}
