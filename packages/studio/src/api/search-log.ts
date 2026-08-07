import { isSearchSource, recordSearch, MAX_LOGGED_QUERY } from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handleScoped, json } from './_shared.js';

/**
 * Report a search a visitor made.
 *
 * **A write, and deliberately not a side effect of the read.** The obvious implementation logs
 * inside `deliverSearch` and needs no endpoint at all — and it would be wrong in a way nobody would
 * catch by looking at it. `/delivery/search` answers with `s-maxage=86400`, and a consumer's own
 * results page is cached too, so the *second* person to search "nursing" is served from an edge
 * cache and never reaches an origin. A log fed by the read path therefore undercounts in proportion
 * to how popular a term is: the report would rank the terms nobody repeats as the most searched,
 * and it would look plausible.
 *
 * So the consumer reports explicitly, over a path that is never cached. Which also buys the thing
 * the CMS could not have worked out for itself — **intent**. A type-ahead sends a request per
 * settled keystroke, and only the site knows whether a given one was somebody committing to a
 * search, choosing a suggestion, or giving up. `source` carries that, and the reports keep the
 * three apart.
 *
 * Not under `/delivery`, because that namespace is the read contract. This is the one thing a site
 * may write, and `search:write` is a scope a key does not have unless somebody granted it.
 */

const bodySchema = z.strictObject(
  {
    /** Capped at the storage limit so an oversized body is refused rather than silently truncated. */
    query: z.string().max(MAX_LOGGED_QUERY * 4),
    resultCount: z.number().int().min(0),
    source: z.string().refine(isSearchSource, 'Unknown search source.'),
  },
  { error: 'Unexpected field in search log entry.' },
);

export const POST = handleScoped(
  async ({ context, taproot }) => {
    let body: unknown;
    try {
      body = await context.request.json();
    } catch {
      return apiError(400, 'Body must be JSON.');
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return apiError(422, parsed.error.issues[0]?.message ?? 'Invalid search log entry.');
    }

    await recordSearch(taproot.db.db, parsed.data);

    /**
     * 204, and never a body.
     *
     * Nothing the caller can do with an answer: `recordSearch` does not throw, because the search
     * being described has already been answered and the visitor already has their results. A
     * failure here has nobody to report to who could act on it — the same reasoning
     * `recordAuditEntry` follows, one step further along.
     */
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  },
  { scope: 'search:write' },
);

/**
 * A GET here would be a way to read the log with a key, which is not what the scope grants.
 *
 * Answered explicitly rather than left to Astro's 404, so the refusal names the reason: the log is
 * an admin report and reading it needs a session.
 */
export const GET = () =>
  json({ error: 'The search log is readable from the admin only.' }, { status: 405 });
