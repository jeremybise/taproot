/**
 * The endpoint a site mounts so its *browser* can report a search.
 *
 * Companion to `createTaprootSearchHandler`, and it exists for the same reason: the API key must
 * not reach the browser. A type-ahead knows things the server cannot — whether somebody committed
 * to a search, picked a suggestion, or gave up — and that knowledge is in the page, so the report
 * has to start there and be forwarded.
 *
 * ```ts
 * // src/pages/api/search-log.ts
 * import { createTaprootSearchLogHandler } from '@taprootcms/astro';
 * import { taproot } from '../../taproot.ts';
 *
 * export const prerender = false;
 * export const POST = createTaprootSearchLogHandler({ client: taproot });
 * ```
 *
 * **It answers 204 whatever happens.** A visitor's search has already been answered by the time
 * this is called, so there is nothing a failure could tell anybody who could act on it — and a
 * client that had to handle an error would be a client with error handling on a telemetry call.
 * This deliberately differs from the *purge* handler, which does report failure, because there the
 * caller is a retry queue whose only way to replay is a response saying it did not work.
 *
 * The endpoint is same-origin and unauthenticated, exactly like the search proxy beside it, so it
 * is spammable by anyone who can load the site. What bounds the damage is that a row is small, the
 * query is length-capped on both sides, and the log names nobody — the worst outcome is a noisy
 * report, not exposure. A site expecting abuse should put a rate limit in front of it.
 */

import type { TaprootClient } from './index.js';

type Reporter = Pick<TaprootClient, 'logSearch'>;

export interface TaprootSearchLogHandlerOptions {
  /** The client from `createTaprootClient`. Its key needs the `search:write` scope. */
  client: Reporter;
  /**
   * Shortest query worth recording.
   *
   * Matches the search handler's `minLength` by default for a reason: below it no search was run,
   * so a row would record a result count of zero for a question nobody asked and land in the
   * "found nothing" report.
   */
  minLength?: number;
}

export function createTaprootSearchLogHandler(options: TaprootSearchLogHandlerOptions) {
  const { client, minLength = 2 } = options;

  return async function POST(context: { request: Request }): Promise<Response> {
    // Never cached, never stored: this is a write surface and its answer says nothing.
    const done = new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });

    try {
      const body = (await context.request.json()) as {
        query?: unknown;
        resultCount?: unknown;
        source?: unknown;
      };

      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (query.length < minLength) return done;

      const source = body.source;
      if (source !== 'page' && source !== 'suggest' && source !== 'abandoned') return done;

      const resultCount = Number(body.resultCount);
      if (!Number.isFinite(resultCount)) return done;

      await client.logSearch({ query, resultCount, source });
    } catch (error) {
      /**
       * Swallowed, including a malformed body.
       *
       * The alternative is a 400 that some script somewhere would start logging to a console, for
       * an event nobody is waiting on. Recorded to the server console so it is diagnosable, which
       * is the same place `recordSearch` puts its own failures.
       */
      console.error('[taproot] search log forward failed', error);
    }

    return done;
  };
}
