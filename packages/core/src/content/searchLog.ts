import { sql, type Kysely } from 'kysely';

import type { Database, SearchSource } from '../db/schema.js';
import { now } from '../db/values.js';
import { newId } from '../ids.js';
import { foldSearchText } from './searchTerms.js';

/**
 * What visitors searched for, and whether the site had an answer.
 *
 * **This cannot be built by counting requests, and that is the whole reason it is a separate write
 * path.** `/delivery/search` answers with `s-maxage=86400`, and a consumer's own search page is
 * cached too — so the second person to search "nursing" is served from an edge cache and never
 * reaches an origin at all. A log fed by the read path would therefore undercount in proportion to
 * how popular a term is, and "top searches" would rank the terms nobody repeats. It has to be an
 * uncached report from the consumer, which is what `search:write` exists for.
 *
 * Nothing identifying is stored — see `0026_search_log`. Prefix collapsing happens in the browser,
 * before anything is sent, so the session id that makes it possible never leaves the visitor.
 */

/**
 * Longest query kept.
 *
 * Not validation — a search box will happily accept a pasted paragraph, and refusing to log it
 * would blind the report to exactly the searches most likely to fail. Truncated so one paste cannot
 * put a megabyte in a table whose rows are otherwise a few dozen bytes.
 */
export const MAX_LOGGED_QUERY = 200;

const SOURCES: readonly SearchSource[] = ['page', 'suggest', 'abandoned'];

export const isSearchSource = (value: string): value is SearchSource =>
  (SOURCES as readonly string[]).includes(value);

/**
 * The grouping key: two searches are the same search when this matches.
 *
 * Folded with `foldSearchText`, the tokenizer's own rule, so "Peña" and "pena" group together
 * exactly as they match together — a report that split them would be describing a distinction the
 * search engine does not make. Whitespace is collapsed as well, because "financial  aid" and
 * "financial aid" are one search to everybody except a `group by`.
 *
 * Deliberately **not** SQL's `lower()`. That folds ASCII and stops, so the grouping would agree
 * with the matcher for English and quietly disagree for every name with an accent in it.
 */
export function normalizeSearchQuery(query: string): string {
  return foldSearchText(query.trim().replace(/\s+/g, ' '));
}

export interface SearchLogInput {
  query: string;
  resultCount: number;
  source: SearchSource;
}

/**
 * Append one search.
 *
 * Never throws, for `recordAuditEntry`'s reason one step further along: the search it describes has
 * already been answered and the visitor already has their results, so a failure here has nothing to
 * report to anybody who can act on it. A blank query is dropped rather than stored — an empty
 * search box submitted by accident is not a search, and it would be the top row of every report.
 */
export async function recordSearch(db: Kysely<Database>, input: SearchLogInput): Promise<void> {
  const query = input.query.trim().slice(0, MAX_LOGGED_QUERY);
  if (!query) return;

  const normalized = normalizeSearchQuery(query);
  if (!normalized) return;

  try {
    await db
      .insertInto('search_queries')
      .values({
        id: newId(),
        query,
        normalized,
        // Floored at zero and integral: this arrives over HTTP from a consumer, and a negative or
        // fractional count would quietly poison every average built on the column.
        result_count: Math.max(0, Math.floor(input.resultCount) || 0),
        source: input.source,
        created_at: now(),
      })
      .execute();
  } catch (error) {
    console.error('[taproot] search log write failed', error);
  }
}

export interface SearchLogFilters {
  /** Only searches at or after this moment. The screen's date window. */
  since: Date;
  /** Sources to include. Omitted means all three. */
  sources?: readonly SearchSource[];
  limit?: number;
}

export interface SearchTermSummary {
  /** The folded grouping key. */
  normalized: string;
  /** The spelling most people used, for display. */
  query: string;
  /** How many times it was searched in the window. */
  searches: number;
  /** Results the *most recent* of those searches found — see below for why not an average. */
  resultCount: number;
  lastSearchedAt: string;
}

/**
 * The most-searched terms in a window.
 *
 * Three things about the shape:
 *
 * **`query` is the most common spelling, not the first or the last.** A report headed `NURSING`
 * because one person shouted is a report people stop reading; the modal spelling is what the term
 * looks like to most visitors.
 *
 * **`resultCount` is the latest, not the mean.** A term that returned nothing for three weeks and
 * then started working averages to "some results" and disappears from the report that matters —
 * while an editor who has just fixed it wants to see that it is fixed. The latest value answers
 * "does this work now", which is the question being asked.
 *
 * **Sources are filtered, never summed blindly.** An `abandoned` row may be a fragment, so mixing
 * it into a top-terms list is how a report recommends writing a page about "nursi".
 */
export async function topSearchTerms(
  db: Kysely<Database>,
  filters: SearchLogFilters,
): Promise<SearchTermSummary[]> {
  return summarize(db, filters, false);
}

/**
 * Terms that found nothing.
 *
 * The report the table exists for: content that is missing, or titled something no visitor would
 * guess. Judged on the **most recent** search for a term rather than on any of them, so a term
 * stops appearing here the moment somebody publishes the page — a `min(result_count) = 0` would
 * keep accusing them of it for as long as the window is open.
 */
export async function zeroResultSearchTerms(
  db: Kysely<Database>,
  filters: SearchLogFilters,
): Promise<SearchTermSummary[]> {
  return summarize(db, filters, true);
}

async function summarize(
  db: Kysely<Database>,
  filters: SearchLogFilters,
  zeroOnly: boolean,
): Promise<SearchTermSummary[]> {
  const sources = filters.sources ?? SOURCES;
  // `in ()` is a syntax error, and "no sources" honestly means no rows.
  if (sources.length === 0) return [];

  const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));

  /**
   * One query, with the per-term facts resolved by correlated `max` rather than by a second pass.
   *
   * `result_count` and `query` both have to come from a *particular* row rather than from an
   * aggregate over the group — the latest, and the most common — which is what the two subqueries
   * do. The alternative is loading every row and grouping in JS, which is the shape that works on
   * the seeded database and falls over on a year of real traffic.
   */
  const rows = await sql<{
    normalized: string;
    query: string;
    searches: number;
    result_count: number;
    last_searched_at: string;
  }>`
    select
      g.normalized,
      g.searches,
      g.last_searched_at,
      (
        select s.result_count from search_queries s
        where s.normalized = g.normalized and s.created_at >= ${filters.since.toISOString()}
          and s.source in (${sql.join(sources.map((s) => sql`${s}`))})
        order by s.created_at desc limit 1
      ) as result_count,
      (
        select s.query from search_queries s
        where s.normalized = g.normalized and s.created_at >= ${filters.since.toISOString()}
          and s.source in (${sql.join(sources.map((s) => sql`${s}`))})
        group by s.query order by count(*) desc, s.query asc limit 1
      ) as query
    from (
      select normalized, count(*) as searches, max(created_at) as last_searched_at
      from search_queries
      where created_at >= ${filters.since.toISOString()}
        and source in (${sql.join(sources.map((s) => sql`${s}`))})
      group by normalized
    ) g
    order by g.searches desc, g.last_searched_at desc
    limit ${limit}
  `.execute(db);

  const summaries = rows.rows.map((row) => ({
    normalized: row.normalized,
    query: row.query ?? row.normalized,
    searches: Number(row.searches),
    resultCount: Number(row.result_count ?? 0),
    lastSearchedAt: row.last_searched_at,
  }));

  /*
   * Filtered here rather than in SQL.
   *
   * "Found nothing" is a fact about the *latest* search for a term, which is a correlated subquery
   * — not something a `having` can see, since `having` filters the group and the group has many
   * result counts in it. Cheap because the set is already capped at `limit`.
   */
  return zeroOnly ? summaries.filter((s) => s.resultCount === 0) : summaries;
}

export interface SearchLogStats {
  /** Every search in the window, whatever its source. */
  total: number;
  /** Distinct terms, after folding. */
  terms: number;
  /** Searches that found nothing — the headline number this screen exists to move. */
  zeroResult: number;
  /** When the log starts, or null when it is empty. Says how much history a report is reading. */
  since: string | null;
}

export async function searchLogStats(
  db: Kysely<Database>,
  filters: Pick<SearchLogFilters, 'since' | 'sources'>,
): Promise<SearchLogStats> {
  const sources = filters.sources ?? SOURCES;
  if (sources.length === 0) return { total: 0, terms: 0, zeroResult: 0, since: null };

  const row = await db
    .selectFrom('search_queries')
    .where('created_at', '>=', filters.since.toISOString())
    .where('source', 'in', sources as string[])
    .select((eb) => [
      eb.fn.countAll<number>().as('total'),
      sql<number>`count(distinct normalized)`.as('terms'),
      // `sum(case …)` because it is the counting idiom every dialect here shares.
      sql<number>`coalesce(sum(case when result_count = 0 then 1 else 0 end), 0)`.as('zero_result'),
      sql<string | null>`min(created_at)`.as('since'),
    ])
    .executeTakeFirst();

  return {
    total: Number(row?.total ?? 0),
    terms: Number(row?.terms ?? 0),
    zeroResult: Number(row?.zero_result ?? 0),
    since: row?.since ?? null,
  };
}

/**
 * Retention: drop everything older than a date.
 *
 * Blunt and dated, exactly as `purgeAuditLogBefore` is. There is no targeted delete here and there
 * should not be — but note the reason differs from the audit log's. There, aiming a delete is what
 * lets somebody erase evidence about themselves. Here, nothing identifies anybody, so the risk is
 * the other way round: a log kept forever slowly becomes a corpus somebody could correlate against
 * other records. Age is the only axis either of them needs.
 *
 * **Nothing calls this yet, and that is the same status `purgeAuditLogBefore` has had since it was
 * written.** The capability is here so an operator has one; scheduling it is a decision about
 * deleting a deployment's data, which is not one a library should make on its behalf by adding a
 * delete to a cron that already runs every five minutes. If this does get wired into
 * `publishDueItems`' sweep, the interval and the age want stating on Settings → System, because a
 * report that silently stops going back further than ninety days is one people misread.
 */
export async function purgeSearchLogBefore(db: Kysely<Database>, before: Date): Promise<number> {
  const result = await db
    .deleteFrom('search_queries')
    .where('created_at', '<', before.toISOString())
    .executeTakeFirst();

  return Number(result.numDeletedRows ?? 0);
}
