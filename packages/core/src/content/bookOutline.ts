import type { Kysely } from 'kysely';

import type { ContentStatus, Database } from '../db/schema.js';
import { visibleToPublic } from './items.js';
import { descendantPathRange, normalizePath } from './paths.js';

/**
 * A book's outline — its sections in the order somebody reads them.
 *
 * **Separate from `books.ts` because the dependency has to run one way.** `items.ts` imports the
 * write-path half of Books to derive `allowSharedContent` on every save, and the outline needs
 * `visibleToPublic`, which lives in `items.ts` for the reason recorded there. Putting both in one
 * module would close that loop. The repo has paid for a module cycle once already — Kysely's
 * dialect and core chunks import each other, Node tolerates it, and workerd refuses the upload with
 * `Class extends value undefined` after the build has reported success — so a cycle is not
 * something to leave standing on the reasoning that this one happens to be safe.
 */

/**
 * One entry in a book's outline.
 *
 * **Flat, with `parentId` and `depth`, in reading order** — the shape `deliverTaxonomyTerms` chose
 * and for the same reason: flat is what both renderings want. A sidebar nests it and a
 * previous/next control reads it straight through, where a nested answer would force the second one
 * to flatten somebody else's tree.
 *
 * `typeApiId` is what makes the navigable/not-navigable decision the consumer's. A catalog keeps its
 * 91 programs of study inside the book — they are content, they are indexed, they roll forward with
 * it — and nobody wants previous/next to page through them. Taproot ships no templates and does not
 * get to decide which branches deserve navigation, so it sends the type and the site filters. Same
 * split as `termHref`.
 */
export interface BookOutlineEntry {
  id: string;
  title: string;
  path: string;
  status: ContentStatus;
  parentId: string | null;
  /** Depth **within the book**, so the root's children are 0 whatever the book's own depth is. */
  depth: number;
  typeApiId: string;
}

/** A book and its sections, in reading order. */
export interface BookOutline {
  root: { id: string; title: string; path: string };
  entries: BookOutlineEntry[];
  /**
   * Whether the outline is complete.
   *
   * False when the book is larger than the cap, which is the failure this repo names everywhere
   * else: rows that exist, cannot be reached, and nothing on screen saying why. A truncated outline
   * silently breaks previous/next in the middle of a book, so a consumer has to be told rather than
   * left to infer it from a count.
   */
  complete: boolean;
}

/**
 * How many sections one book may carry.
 *
 * The catalog this was built for is 188. Ten times that is past what anybody paginates a table of
 * contents for, and the outline is one query and one cached response — so the cap is a bound on a
 * pathological tree rather than a budget anybody should meet.
 */
export const MAX_BOOK_SECTIONS = 2000;

/**
 * A book's sections, depth-first, in the order somebody reads them.
 *
 * **One indexed range query, then the ordering happens in memory**, because reading order is not
 * available to SQL here: `path` sorts lexicographically, which is a different sequence from the one
 * an editor arranged with `position`, and would look correct on a shallow book while being wrong on
 * a deep one. So the rows come back on the index and the tree is walked with the same
 * children-map recursion `deliverTaxonomyTerms` uses.
 *
 * Siblings are ordered by `(position, title)` — byte for byte the order `resolveDelivery` already
 * gives an item's children, so the outline and the "in this section" list on a page cannot disagree
 * about what comes next.
 *
 * `includeUnpublished` follows the rest of delivery: a published book must not leak the titles and
 * paths of sections nobody has published, and the admin's own outline screen needs to see them.
 */
export async function bookOutline(
  db: Kysely<Database>,
  rootPath: string,
  options: { includeUnpublished?: boolean } = {},
): Promise<BookOutline | undefined> {
  const normalized = normalizePath(rootPath);

  let rootQuery = db
    .selectFrom('content_items')
    .innerJoin('content_types', 'content_types.id', 'content_items.content_type_id')
    .select([
      'content_items.id as id',
      'content_items.title as title',
      'content_items.path as path',
    ])
    .where('content_items.path', '=', normalized)
    .where('content_types.kind', '=', 'page')
    .where('content_types.book_root', '=', 1);

  if (!options.includeUnpublished) rootQuery = rootQuery.where(visibleToPublic);

  const root = await rootQuery.executeTakeFirst();
  // Not a book, or not one this caller may see. Undefined rather than an empty outline, so a route
  // can answer 404 — "no such book" and "a book with no sections" are different facts.
  if (!root) return undefined;

  const { start, end } = descendantPathRange(normalized);

  let query = db
    .selectFrom('content_items')
    .innerJoin('content_types', 'content_types.id', 'content_items.content_type_id')
    .select([
      'content_items.id as id',
      'content_items.title as title',
      'content_items.path as path',
      'content_items.status as status',
      'content_items.parent_id as parentId',
      'content_items.position as position',
      'content_types.api_id as typeApiId',
    ])
    .where('content_items.path', '>', start)
    .where('content_items.path', '<', end)
    // One more than the cap, so "complete" is answered without a second counting query.
    .limit(MAX_BOOK_SECTIONS + 1);

  if (!options.includeUnpublished) query = query.where(visibleToPublic);

  const rows = await query.execute();
  const complete = rows.length <= MAX_BOOK_SECTIONS;

  const children = new Map<string, typeof rows>();
  for (const row of rows.slice(0, MAX_BOOK_SECTIONS)) {
    const key = row.parentId ?? '';
    children.set(key, [...(children.get(key) ?? []), row]);
  }

  for (const group of children.values()) {
    group.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  }

  const entries: BookOutlineEntry[] = [];
  const walk = (parentId: string, depth: number): void => {
    for (const row of children.get(parentId) ?? []) {
      entries.push({
        id: row.id,
        title: row.title,
        path: row.path,
        status: row.status,
        parentId: row.parentId,
        depth,
        typeApiId: row.typeApiId,
      });
      walk(row.id, depth + 1);
    }
  };

  walk(root.id, 0);

  /**
   * A section whose parent is not in the outline is appended rather than dropped.
   *
   * It should not happen — everything in the range descends from the root — but an unpublished
   * middle section under `includeUnpublished: false` orphans its published children, and that is an
   * ordinary state rather than a broken one. Dropping them would remove pages a visitor can still
   * reach by URL from the navigation that is supposed to describe the book. Same instinct as the
   * taxonomy walk keeping a term whose parent is missing: an odd-looking tree beats a lie.
   */
  const placed = new Set(entries.map((entry) => entry.id));
  for (const row of rows.slice(0, MAX_BOOK_SECTIONS)) {
    if (placed.has(row.id)) continue;
    entries.push({
      id: row.id,
      title: row.title,
      path: row.path,
      status: row.status,
      parentId: row.parentId,
      depth: 0,
      typeApiId: row.typeApiId,
    });
  }

  return { root, entries, complete };
}

