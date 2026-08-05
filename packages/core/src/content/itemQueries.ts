import type { Kysely } from 'kysely';

import type { ContentTypeRow, Database, FieldRow } from '../db/schema.js';
import { parseJson } from '../db/values.js';
import { MAX_BLOCK_DEPTH } from '../validation/fields.js';
import { isItemSort, type ItemSort } from './itemSort.js';
import { listItems, type ContentItem, type ItemValueFilter } from './items.js';
import { queryKey } from './queryKeys.js';
import { termIdsForBranch } from './taxonomies.js';
import { getContentType } from './types.js';

/**
 * Running the `query` fields on a page.
 *
 * A query field stores a rule and never its answer, so the answer has to be produced on every read.
 * That is the whole reason the field exists: "the six soonest Arts events" has to change when
 * somebody publishes a seventh, without anyone editing the page the listing sits on.
 *
 * **Cost is O(query fields), not O(results).** One list query per field, plus one content-type load
 * per distinct target type, memoised for the request. Every result's own media, relations and terms
 * are unioned into the payload's existing `collected` sets and ride the loaders that were going to
 * run anyway, so a listing of twenty events costs no more round trips than a listing of two.
 */

/** One resolved query, addressed by where the field sits rather than by the field alone. */
export interface DeliveryQueryResult {
  /** Matching item ids, in the query's own order. Look each up in `references`. */
  ids: string[];
  /** How many matched in total, which is usually more than `ids.length`. */
  total: number;
}

/**
 * Fields a query result never carries.
 *
 * A result is *the item's fields, not its page composition*. A listing card renders a thumbnail, a
 * title and a date; it does not render another page's page-builder blocks, and shipping them would
 * multiply the payload by the size of every matched page's body.
 *
 * Excluding `query` is the part that is load-bearing rather than merely economical: without it, a
 * page listing events whose type also carries a listing would resolve that one too, and two types
 * pointing at each other would recurse until something gave out. Stripping the field is a sharper
 * bound than a depth counter, and it costs nothing anybody wanted.
 */
const OMITTED_FROM_RESULTS = new Set(['block', 'query']);

export { queryKey } from './queryKeys.js';

interface FoundQuery {
  containerId: string;
  field: FieldRow;
  value: Record<string, unknown>;
}

/**
 * Find every query field in an item's data, including inside blocks.
 *
 * Walks the *data* rather than the schema, because a query's answer is addressed by the block
 * instance holding it and a schema walk has no instance ids. Blocks nest, so this recurses under
 * `MAX_BLOCK_DEPTH` — the same bound `validateItemData` applies, for the same reason.
 *
 * Repeater rows are deliberately not walked: `query` is excluded from `REPEATER_SUB_FIELD_TYPES`,
 * so one cannot be there. `queryKey` still takes any container id rather than assuming an item or a
 * block, so allowing it later is a change to one allowlist and nothing here.
 */
function findQueries(
  fields: FieldRow[],
  data: Record<string, unknown>,
  containerId: string,
  blockTypes: ReadonlyMap<string, { fields: FieldRow[] }>,
  depth: number,
  found: FoundQuery[] = [],
): FoundQuery[] {
  for (const field of fields) {
    const value = data[field.api_id];

    if (field.type === 'query') {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        found.push({ containerId, field, value: value as Record<string, unknown> });
      }
      continue;
    }

    if (field.type === 'block' && Array.isArray(value) && depth > 0) {
      for (const raw of value) {
        if (typeof raw !== 'object' || raw === null) continue;
        const block = raw as { id?: unknown; type?: unknown; data?: unknown };
        if (typeof block.id !== 'string' || typeof block.type !== 'string') continue;

        const blockType = blockTypes.get(block.type);
        if (!blockType) continue;

        /**
         * A reusable block's data is already filled in by `resolveItemBlocks`, which runs before
         * this — so a query inside a shared block resolves like any other. The key is the *block
         * instance's* id rather than the library entry's, because the same entry placed on two
         * pages is two placements and each gets its own answer.
         */
        const blockData =
          typeof block.data === 'object' && block.data !== null
            ? (block.data as Record<string, unknown>)
            : {};

        findQueries(blockType.fields, blockData, block.id, blockTypes, depth - 1, found);
      }
    }
  }

  return found;
}

export interface ResolveQueriesOptions {
  /**
   * Block type schemas keyed by `api_id`, so the walk can descend into blocks.
   *
   * `ReadonlyMap` because the caller is entitled to pass a shared empty one: an item with no placed
   * blocks skips loading the registry altogether, and nothing here has any business writing to it.
   */
  blockTypes: ReadonlyMap<string, { fields: FieldRow[] }>;
  /** Whether unpublished items may appear — true only under a preview token. */
  includeUnpublished?: boolean;
}

export interface ResolvedQueries {
  /** Keyed by `queryKey(containerId, fieldApiId)`. */
  queries: Record<string, DeliveryQueryResult>;
  /** Every matched item, stripped to what a result carries, for the caller to fold into its maps. */
  items: { item: ContentItem; fields: FieldRow[]; data: Record<string, unknown> }[];
  /**
   * The `api_id` of every content type this page listed, for cache tagging.
   *
   * A page carrying a listing depends on the *type*, not only on the members it matched. The cached
   * copy of "the six soonest events" names the six it had, which is exactly the set that does not
   * contain the seventh — so invalidating by matched item can never bring a newly published one
   * into the list. Reported from here because this is the only place that knows which types were
   * consulted; the field stores a type id and the tag wants the readable `api_id`.
   */
  targetTypeApiIds: string[];
}

/**
 * Resolve every query field on an item.
 *
 * Returns the answers **and** the matched rows, rather than writing into the payload itself, so the
 * caller keeps one place where the lookup maps are assembled. That matters because a matched item
 * may also be a relation target on the same page, and merging is the caller's job.
 */
export async function resolveItemQueries(
  db: Kysely<Database>,
  fields: FieldRow[],
  data: Record<string, unknown>,
  itemId: string,
  options: ResolveQueriesOptions,
): Promise<ResolvedQueries> {
  const found = findQueries(fields, data, itemId, options.blockTypes, MAX_BLOCK_DEPTH);
  if (found.length === 0) return { queries: {}, items: [], targetTypeApiIds: [] };

  /**
   * One load per distinct target type, however many fields point at it — memoised on the
   * **promise**, not on the resolved value.
   *
   * That distinction is what survives the fields being resolved concurrently below. A cache holding
   * finished values only ever hits when something has awaited it first, so under `Promise.all` two
   * listings against the same type would both find it empty, both issue the query, and the memo
   * would quietly do nothing. Storing the in-flight promise makes the second caller wait on the
   * first one's request instead.
   *
   * A rejection is cached along with everything else, which is deliberate: the only thing that
   * rejects here is the database being unreachable, and every caller is inside the same
   * `Promise.all` that is about to reject anyway.
   */
  const typeCache = new Map<
    string,
    Promise<(ContentTypeRow & { fields: FieldRow[] }) | undefined>
  >();
  const loadType = (id: string) => {
    let pending = typeCache.get(id);
    if (!pending) {
      pending = getContentType(db, id);
      typeCache.set(id, pending);
    }
    return pending;
  };

  /**
   * The same memo for term branches, which two listings filtering by one term used to pay twice.
   *
   * `termIdsForBranch` is a recursive CTE — the most expensive single statement on this path — and
   * "events in Music" beside "news in Music" is an ordinary way to build a page.
   */
  const branchCache = new Map<string, Promise<string[]>>();
  const loadBranch = (id: string) => {
    let pending = branchCache.get(id);
    if (!pending) {
      pending = termIdsForBranch(db, id);
      branchCache.set(id, pending);
    }
    return pending;
  };

  /**
   * Every query field resolved concurrently, then folded together in `found` order.
   *
   * This was a `for` loop with three awaits in it, so a page carrying three listing blocks paid up
   * to fifteen serial round trips to D1 — each one a hop to another region — to answer three
   * questions that have nothing to do with each other. Nothing here reads another field's result.
   *
   * The fold stays sequential and stays in `found` order, because `items` is an array and `seen`
   * decides which duplicate is carried: resolving in completion order would make the payload depend
   * on which query the database happened to answer first, which is a difference no test would catch
   * and every diff would show.
   */
  const perField = await Promise.all(
    found.map(async ({ containerId, field, value }) => {
      const key = queryKey(containerId, field.api_id);
    const config = parseJson<Record<string, unknown>>(field.config, {});
    const targetTypeId =
      typeof config.targetContentTypeId === 'string' ? config.targetContentTypeId : null;

    // A field pointed at nothing yet answers empty rather than throwing. The builder lets a type be
    // designed before its target exists, exactly as `relation` and `taxonomy` do.
    if (!targetTypeId) return { key, empty: true as const };

    const targetType = await loadType(targetTypeId);
    if (!targetType) return { key, empty: true as const };

    const maxResults =
      typeof config.maxResults === 'number' && config.maxResults > 0 ? config.maxResults : 24;
    const requested = typeof value.limit === 'number' && value.limit > 0 ? value.limit : 6;
    const sort: ItemSort = isItemSort(value.sort) ? value.sort : 'path';

    /**
     * A term filter always means the whole branch, so filing an event under "Jazz" finds it when
     * the listing asks for "Music". Expanded here rather than in `ItemFilters`, which stays a
     * synchronous query builder the status facets can share.
     *
     * An **empty** selection means no term filter, not "match nothing" — the opposite of
     * `ItemFilters.termIds`' own convention, and deliberately so: there an empty array comes from a
     * caller that asked for a term with no members, while here it comes from an editor who has not
     * picked one yet, and a freshly placed block must not render as broken.
     */
    const chosen = Array.isArray(value.termIds)
      ? value.termIds.filter((id): id is string => typeof id === 'string')
      : [];
    const termIds = chosen.length
      ? [...new Set((await Promise.all(chosen.map(loadBranch))).flat())]
      : undefined;

    /**
     * The date dimension, resolved from the *schema* rather than trusted from the stored value.
     *
     * `dateFieldApiId` is an `api_id`, so it has to be looked up on the target type as it is now —
     * the field can be deleted or retyped long after a query was saved. When it does not resolve to
     * a date field, the bound is dropped and the sort falls back to `path`: a listing that shows
     * too much is recoverable, and one that errors on a live page is not.
     */
    const dateFieldApiId =
      typeof config.dateFieldApiId === 'string' ? config.dateFieldApiId : null;
    const dateField = dateFieldApiId
      ? targetType.fields.find(
          (candidate) => candidate.api_id === dateFieldApiId && candidate.type === 'date',
        )
      : undefined;

    /**
     * "Upcoming" means *now*, worked out here rather than read from stored data — which is what
     * keeps a page listing upcoming events still doing so a month after anybody edited it.
     */
    const valueFilters: ItemValueFilter[] = [];
    if (dateField && (value.dateFilter === 'upcoming' || value.dateFilter === 'past')) {
      valueFilters.push({
        field: dateField.api_id,
        operator: value.dateFilter === 'upcoming' ? 'after' : 'before',
        value: new Date().toISOString(),
      });
    }

    const { items: matched, total } = await listItems(db, {
      contentTypeId: targetTypeId,
      termIds,
      sort,
      sortField: dateField ? { apiId: dateField.api_id, kind: 'date' } : undefined,
      valueFilters,
      limit: Math.min(requested, maxResults),
      /**
       * A listing never shows drafts, **even under a preview token**.
       *
       * The rest of a preview deliberately does show unpublished content, because an editor
       * assembling a page needs to see it. A query is different in kind: it is a claim about what
       * the site will look like once this page is live, and quietly including drafts would make the
       * preview a picture of a page that can never exist — the editor tunes a listing to six
       * results and four of them vanish at publish.
       */
      visibleOnly: true,
      contentTypeKinds: ['page', 'collection'],
    });

      return { key, empty: false as const, matched, total, targetType };
    }),
  );

  const queries: Record<string, DeliveryQueryResult> = {};
  const items: ResolvedQueries['items'] = [];
  const seen = new Set<string>();
  const targetTypeApiIds = new Set<string>();

  for (const answer of perField) {
    if (answer.empty) {
      queries[answer.key] = { ids: [], total: 0 };
      continue;
    }

    const { key, matched, total, targetType } = answer;
    queries[key] = { ids: matched.map((row) => row.id), total };

    /**
     * Recorded even when the query matched nothing.
     *
     * An empty listing is the case that most needs the dependency: the page is cached showing
     * "no upcoming events", and the thing that has to invalidate it is the first event being
     * published. Tagging only what matched would leave that page empty until the TTL lapsed.
     */
    targetTypeApiIds.add(targetType.api_id);

    // Only the fields that survived, so the caller's reference walk cannot reach into a block whose
    // contents are not being sent. Computed once per query rather than once per matched row.
    const carried = targetType.fields.filter(
      (resultField) => !OMITTED_FROM_RESULTS.has(resultField.type),
    );

    for (const row of matched) {
      // The same item can match two queries on one page; it is carried once and referenced twice.
      if (seen.has(row.id)) continue;
      seen.add(row.id);

      const kept = Object.fromEntries(
        carried
          .map((resultField) => [resultField.api_id, row.data[resultField.api_id]])
          .filter(([, fieldValue]) => fieldValue !== undefined),
      );

      items.push({ item: row, fields: carried, data: kept });
    }
  }

  return { queries, items, targetTypeApiIds: [...targetTypeApiIds] };
}
