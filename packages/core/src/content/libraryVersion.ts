import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * One stamp covering everything shared that a page can depend on without saying so.
 *
 * Two kinds of content are edited somewhere other than the page they appear on: a **reusable block**
 * and a **text snippet**. Neither moves the referencing page's `updated_at`, so a validator built
 * from the page alone answers 304 after either is edited — and per RFC 9111 §4.3.4 a 304 *refreshes*
 * the stored copy's freshness, so the page renews itself indefinitely rather than going stale for
 * one TTL. That bug has shipped here once already; `reusableBlockLibraryVersion` was the fix, and a
 * snippet is the same hole one size down.
 *
 * **One query, not two.** `resolve.ts` reads this on every conditional request, so a second aggregate
 * would be a second round trip on the hot path for a number that is only ever `max`-ed with the
 * first. A `union all` of two aggregates is one statement; the arithmetic happens here.
 *
 * Over-broad in the same way `SITE_TAG` is: editing any shared row invalidates every page's
 * validator. That is rare by construction and costs a revalidation rather than a re-render.
 *
 * Returns `0` when both tables are empty, so the stamp is a stable number rather than sometimes
 * absent — a validator that changes shape when the first row is created would invalidate every page
 * once, for nothing.
 *
 * **`npm run query-count` cannot see this**, because that script measures `resolveDelivery` rather
 * than the route. Say so when changing it rather than reading a green run as "no cost".
 */
export async function contentLibraryVersion(db: Kysely<Database>): Promise<number> {
  const rows = await sql<{ latest: string | null }>`
    select max(updated_at) as latest from reusable_blocks
    union all
    select max(updated_at) as latest from snippets
  `.execute(db);

  let newest = 0;
  for (const row of rows.rows) {
    const parsed = row.latest ? Date.parse(row.latest) || 0 : 0;
    if (parsed > newest) newest = parsed;
  }
  return newest;
}
