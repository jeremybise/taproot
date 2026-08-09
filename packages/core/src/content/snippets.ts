import type { Kysely } from 'kysely';

import type { Database, SnippetKind } from '../db/schema.js';
import { now } from '../db/values.js';
import { newId } from '../ids.js';
import { hasSnippetToken } from './snippetTokens.js';

/**
 * Reusable text snippets — a value defined once and used in prose everywhere.
 *
 * Modelled on `reusableBlocks.ts`, which solves the same problem one size up: a reusable block owns
 * a region of a page, a snippet owns a value inside a sentence. Everything here that looks like a
 * copy of that file is a deliberate one, because the two features have to behave the same way where
 * they overlap — most importantly around deletion and the cache stamp.
 */

export interface Snippet {
  id: string;
  api_id: string;
  name: string;
  description: string | null;
  kind: SnippetKind;
  value: string;
  display: string | null;
  created_at: string;
  updated_at: string;
}

/** What a page's payload carries for each snippet it uses. */
export interface ResolvedSnippet {
  kind: SnippetKind;
  /** Canonical: the string, the bare number, or an ISO date. What a chart plots. */
  value: string;
  /** What prose substitutes. Derived from `value` when the row sets no override. */
  display: string;
}

/**
 * How a snippet reads in a sentence.
 *
 * **The one place the CMS makes a formatting decision, and it is forced**: substituting into prose
 * has to produce *some* string, and `4500` in the middle of "Tuition is 4500 per year" is not what
 * anybody means. An editor who wants something else sets `display` and this defers to it entirely.
 *
 * `en-US` rather than a configurable locale, deliberately for now. A locale setting is a real
 * feature with a real surface — it would want to reach dates in the admin, the delivery payload and
 * the consumer — and inventing half of it here, readable by nothing else, is how a setting ends up
 * configured and unread. `display` is the escape hatch until that exists.
 */
export function renderSnippet(snippet: Pick<Snippet, 'kind' | 'value' | 'display'>): string {
  if (snippet.display !== null && snippet.display !== '') return snippet.display;

  if (snippet.kind === 'number') {
    const parsed = Number(snippet.value);
    // A number that will not parse falls back to its own text rather than rendering `NaN`, which is
    // the `parseJson` precedent: a bad stored value degrades to something readable rather than
    // taking the page down.
    return Number.isFinite(parsed) ? new Intl.NumberFormat('en-US').format(parsed) : snippet.value;
  }

  if (snippet.kind === 'date') {
    const parsed = new Date(snippet.value);
    return Number.isNaN(parsed.getTime())
      ? snippet.value
      : new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(parsed);
  }

  return snippet.value;
}

export function toResolved(snippet: Snippet): ResolvedSnippet {
  return { kind: snippet.kind, value: snippet.value, display: renderSnippet(snippet) };
}

export async function listSnippets(db: Kysely<Database>): Promise<Snippet[]> {
  return db.selectFrom('snippets').selectAll().orderBy('name').execute();
}

export async function getSnippet(db: Kysely<Database>, id: string): Promise<Snippet | undefined> {
  return db.selectFrom('snippets').selectAll().where('id', '=', id).executeTakeFirst();
}

/**
 * Load snippets by `api_id`, which is how content names them.
 *
 * One query for however many a page uses — the "cost is per page, not per item" rule
 * `resolveDelivery` follows for media and terms. An empty list short-circuits rather than sending
 * `in ()`, which is a syntax error; the same trap `listMedia` documents.
 */
export async function snippetsByApiId(
  db: Kysely<Database>,
  apiIds: string[],
): Promise<Record<string, ResolvedSnippet>> {
  if (apiIds.length === 0) return {};

  const rows = await db
    .selectFrom('snippets')
    .selectAll()
    .where('api_id', 'in', [...new Set(apiIds)])
    .execute();

  return Object.fromEntries(rows.map((row) => [row.api_id, toResolved(row)]));
}

export interface SnippetInput {
  api_id: string;
  name: string;
  description?: string | null;
  kind: SnippetKind;
  value: string;
  display?: string | null;
}

export async function createSnippet(db: Kysely<Database>, input: SnippetInput): Promise<Snippet> {
  const timestamp = now();
  const row: Snippet = {
    id: newId(),
    api_id: input.api_id,
    name: input.name,
    description: input.description ?? null,
    kind: input.kind,
    value: input.value,
    display: input.display ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('snippets').values(row).execute();
  return row;
}

/**
 * Update everything except `api_id`.
 *
 * **The omission is the point.** `api_id` is what every stored `{{ token }}` names, so changing it
 * silently breaks content that no screen would show as broken. It is excluded from the input type
 * rather than ignored at runtime, so a caller trying to change it fails to compile — the same shape
 * as `status` being excluded from `countItemsByStatus`'s filters.
 */
export async function updateSnippet(
  db: Kysely<Database>,
  id: string,
  input: Partial<Omit<SnippetInput, 'api_id'>>,
): Promise<Snippet | undefined> {
  const existing = await getSnippet(db, id);
  if (!existing) return undefined;

  const next: Snippet = {
    ...existing,
    name: input.name ?? existing.name,
    description: input.description === undefined ? existing.description : (input.description ?? null),
    kind: input.kind ?? existing.kind,
    value: input.value ?? existing.value,
    display: input.display === undefined ? existing.display : (input.display ?? null),
    updated_at: now(),
  };

  await db.updateTable('snippets').set(next).where('id', '=', id).execute();
  return next;
}

/**
 * How many content items refer to this snippet.
 *
 * A `LIKE` over the `data` blob, which is what `countBlockUsage` already does for block types and is
 * acceptable for the same reason: it runs when somebody is about to delete something, not on any
 * read path.
 *
 * The pattern is `{{`-and-the-name rather than the exact rendered token, because whitespace inside
 * the braces is optional — `{{tuition}}` and `{{ tuition }}` are the same reference. That makes this
 * an over-count in one direction only: a page whose prose happens to contain `{{ tuition` without a
 * closing brace would be counted. Refusing a delete that would in fact have been safe is the
 * survivable error here; permitting one that breaks a live page is not.
 */
export async function countSnippetUsage(db: Kysely<Database>, apiId: string): Promise<number> {
  const row = await db
    .selectFrom('content_items')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('data', 'like', `%{{%${apiId}%}}%`)
    .executeTakeFirst();

  const inItems = Number(row?.n ?? 0);

  // Reusable block entries hold content too, and a snippet used only inside one would otherwise look
  // unused — which is precisely the delete that leaves a gap on every page sharing that block.
  const blockRow = await db
    .selectFrom('reusable_blocks')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('data', 'like', `%{{%${apiId}%}}%`)
    .executeTakeFirst();

  return inItems + Number(blockRow?.n ?? 0);
}

/**
 * Delete, refused while anything still refers to it.
 *
 * The same rule reusable blocks enforce, for the same reason: a reference with no target renders as
 * a gap on exactly the pages nobody is watching. Here it is slightly worse — an unresolved token
 * leaves visible `{{ tuition }}` braces in a sentence — which is discoverable, but discovering it on
 * a live page is not the plan.
 */
export async function deleteSnippet(
  db: Kysely<Database>,
  id: string,
): Promise<{ deleted: boolean; blocker?: string }> {
  const existing = await getSnippet(db, id);
  if (!existing) return { deleted: false, blocker: 'That snippet no longer exists.' };

  const uses = await countSnippetUsage(db, existing.api_id);
  if (uses > 0) {
    return {
      deleted: false,
      blocker:
        `${uses} ${uses === 1 ? 'item still uses' : 'items still use'} “${existing.api_id}”. ` +
        `Remove every {{ ${existing.api_id} }} before deleting it.`,
    };
  }

  await db.deleteFrom('snippets').where('id', '=', id).execute();
  return { deleted: true };
}

/**
 * A stamp that changes whenever any snippet does, for the delivery ETag.
 *
 * Identical in shape and purpose to `reusableBlockLibraryVersion`, and for the identical reason:
 * a page's own `updated_at` does not move when a snippet it uses is edited, so a validator built
 * from the page alone answers 304 forever — and per RFC 9111 §4.3.4 a 304 *refreshes* the stored
 * copy's freshness, so the staleness is unbounded rather than capped by the TTL. That bug has been
 * shipped here once already.
 *
 * Over-broad in the same way `SITE_TAG` is: editing one snippet invalidates every page's validator.
 * That is rare by construction and costs a revalidation rather than a re-render.
 *
 * Returns `0` for an empty table so the stamp is a stable number rather than sometimes absent — a
 * validator that changes shape when the first row is created would invalidate every page once, for
 * nothing.
 */
export async function snippetLibraryVersion(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('snippets')
    .select((eb) => eb.fn.max<string | null>('updated_at').as('latest'))
    .executeTakeFirst();

  return row?.latest ? Date.parse(row.latest) || 0 : 0;
}

/** Whether any of an item's stored values carries a token at all — the cheap pre-check. */
export function dataHasSnippetTokens(value: unknown): boolean {
  if (typeof value === 'string') return hasSnippetToken(value);
  if (Array.isArray(value)) return value.some(dataHasSnippetTokens);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(dataHasSnippetTokens);
  }
  return false;
}
