import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * The reading half of search: the excerpt a result is shown with.
 *
 * The *matching* half is not here, deliberately — it is `ItemFilters.search` in `items.ts`, shared
 * with the admin's list and its status facets so there is one predicate rather than one per caller.
 * What lives here is the part only a results page needs, and only after the rows are known.
 */

/**
 * How much text an excerpt carries.
 *
 * Long enough for the phrase to sit in a sentence, short enough that ten of them are a page a
 * visitor can scan. Measured in characters rather than words because the window is cut around a
 * match position, and a word count would have to be resolved back to one anyway.
 */
export const EXCERPT_LENGTH = 200;

/** Characters of context before the match, so it does not sit flush against the leading ellipsis. */
const LEAD_IN = 60;

/**
 * A window of an item's text around the first occurrence of the search term.
 *
 * Pure and exported for its own tests: string arithmetic that only ever runs inside a route is
 * reachable by no suite in this repo, which is the lesson `scaleSizes` cost a release to learn.
 *
 * Three things it deliberately does *not* do:
 *
 * - **No highlighting.** The excerpt is plain text, and a consumer renders it with `set:text` or
 *   as a text node. Returning `<mark>` would make this the one delivery field that must be trusted
 *   as HTML, on a value assembled from stored content — the sanitiser exists so that no such value
 *   exists. A consumer wanting a highlight can find the term itself; it knows what it searched for.
 * - **No sentence detection.** A window cut at a word boundary reads fine and works in every
 *   language; hunting for a full stop finds abbreviations, decimals and none of the punctuation a
 *   language without full stops uses.
 * - **No match count or position score.** See `applyItemSort`'s bands: a `LIKE` answers whether a
 *   term appears, and arithmetic on top of that is a ranking that looks principled and is not.
 */
export function buildExcerpt(text: string, term: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const needle = term.trim().toLowerCase();
  const at = needle ? trimmed.toLowerCase().indexOf(needle) : -1;

  /**
   * No match in the body is the normal case for a title hit, not a failure — the item matched on
   * its title and this is still the best summary available, so it opens from the beginning.
   */
  const start = at === -1 ? 0 : Math.max(0, at - LEAD_IN);
  const end = Math.min(trimmed.length, start + EXCERPT_LENGTH);

  // Nudged to word boundaries so a window never opens or closes mid-word — but only when there is a
  // boundary within reach, or a language that does not space its words would lose the excerpt.
  const head = start === 0 ? 0 : boundaryAfter(trimmed, start);
  const tail = end === trimmed.length ? trimmed.length : boundaryBefore(trimmed, end, head);

  const slice = trimmed.slice(head, tail).trim();
  return `${head > 0 ? '…' : ''}${slice}${tail < trimmed.length ? '…' : ''}`;
}

function boundaryAfter(text: string, from: number): number {
  const next = text.indexOf(' ', from);
  return next === -1 || next - from > 20 ? from : next + 1;
}

function boundaryBefore(text: string, to: number, floor: number): number {
  const previous = text.lastIndexOf(' ', to);
  return previous <= floor || to - previous > 20 ? to : previous;
}

/**
 * Excerpts for a page of results, in one query.
 *
 * One `in` rather than one lookup per result, following `ancestorPaths` — a search page is exactly
 * the shape that turns into an N+1 without anyone noticing, because it is correct at every size
 * somebody tests it at.
 *
 * Items with no row come back absent rather than empty: a missing row means the item has never been
 * indexed, and a caller that cannot tell that from "indexed, holds no prose" cannot diagnose a
 * database that has not been reindexed since the migration.
 */
export async function loadSearchExcerpts(
  db: Kysely<Database>,
  itemIds: string[],
  term: string,
): Promise<Map<string, string>> {
  // `in ()` is a syntax error, and an empty page of results is an ordinary thing to have.
  if (itemIds.length === 0) return new Map();

  const rows = await db
    .selectFrom('content_item_text')
    .select(['content_item_id', 'text'])
    .where('content_item_id', 'in', itemIds)
    .execute();

  return new Map(rows.map((row) => [row.content_item_id, buildExcerpt(row.text, term)]));
}

export interface SearchIndexStatus {
  /** Every content item, whatever its status. */
  items: number;
  /** Those with no row in the index — invisible to search until a reindex. */
  unindexed: number;
}

/**
 * How much of the site search can actually see.
 *
 * The one question that distinguishes "this site has nothing about badgers" from "nobody has run
 * `npm run db:reindex` since the migration". Those look identical from a results page — both are an
 * empty list — and the second is a state a deployment can sit in indefinitely without a single
 * error anywhere. Settings → System reports it for that reason: an operator should be able to tell
 * them apart without reading the code.
 *
 * One query rather than two, with the conditional written as `sum(case …)` because it is the
 * counting idiom every dialect here shares — `count(… filter where …)` is not.
 */
export async function searchIndexStatus(db: Kysely<Database>): Promise<SearchIndexStatus> {
  const row = await db
    .selectFrom('content_items')
    .select((eb) => [
      eb.fn.countAll<number>().as('items'),
      sql<number>`coalesce(sum(case when not exists (
          select 1 from content_item_text
          where content_item_text.content_item_id = content_items.id
        ) then 1 else 0 end), 0)`.as('unindexed'),
    ])
    .executeTakeFirst();

  return { items: Number(row?.items ?? 0), unindexed: Number(row?.unindexed ?? 0) };
}
