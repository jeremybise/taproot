import { useEffect, useRef, useState } from 'react';

/**
 * Search content items by title or path, debounced, with stale responses discarded.
 *
 * **One copy of the risky part, not one picker to rule them all.** This was written twice — in
 * `RelationField` and in `LinkTargetSearch` — and was about to be written twice more for the menus
 * target picker and the parent picker. What is genuinely duplicated is the asynchrony: the debounce,
 * the ordering of overlapping responses, and what happens when a request fails. What is *not*
 * duplicated is the surrounding control, which differs for good reasons — a relation field orders
 * several values and badges their status, a link dialog shows one chosen page instead of the list.
 * So the seam is here rather than around a component that would have to serve all four.
 *
 * ## The ticket is what orders responses, and the cleanup does not replace it
 *
 * The effect's cleanup clears the *timer*, so a request already in flight is never cancelled — type
 * a fifth character while the four-character search is on the wire and both will resolve. `latest`
 * is a monotonic counter captured per request; a response whose ticket is no longer the newest is
 * dropped. Without it a slow earlier search overwrites a newer one and the list under the cursor
 * disagrees with the box above it.
 *
 * An `AbortController` would also work and would be the more modern spelling. It is deliberately not
 * used: it would need the same guard anyway for the request that has already reached the server, and
 * an aborted fetch rejects into the `catch` below — which is where "a failed search leaves the last
 * results alone" lives, so cancelling would start clearing the list on every keystroke.
 *
 * ## Failure leaves what is on screen
 *
 * A search that throws or answers non-2xx does nothing at all. Emptying the list would mean a
 * dropped connection reads as "no such page", which is the one answer the editor must not be given
 * — they would go and create a duplicate.
 */

export interface ItemSearchResult {
  id: string;
  title: string;
  path: string;
  /** Absent for callers that do not select it; `RelationField` badges anything unpublished. */
  status?: string;
}

export interface ItemSearchOptions {
  /**
   * Extra query parameters — `contentTypeId` for a relation field, `contentTypeKinds` for the parent
   * picker. An `undefined` value is omitted rather than sent as the string "undefined".
   */
  params?: Record<string, string | undefined>;
  /**
   * Shortest term that reaches the server.
   *
   * One by default. `LinkTargetSearch` uses two, because it searches every type at once and a
   * single letter there matches most of a site.
   */
  minLength?: number;
  limit?: number;
  /**
   * Whether searching is possible at all, as distinct from whether a term has been typed.
   *
   * `RelationField` renders with no target in the content-type builder's preview, which has no
   * database behind it; firing a request for every keystroke there would 400 in a loop.
   */
  enabled?: boolean;
}

const DEBOUNCE_MS = 200;

export function useItemSearch(
  query: string,
  { params = {}, minLength = 1, limit = 50, enabled = true }: ItemSearchOptions = {},
): { results: ItemSearchResult[]; searching: boolean } {
  const [results, setResults] = useState<ItemSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const latest = useRef(0);

  /**
   * Serialised, so the effect re-runs when a parameter's *value* changes rather than whenever the
   * caller happens to build a new object. Passing `params` itself would re-run on every render of
   * every caller that writes the object inline, which is all of them.
   */
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  const paramString = search.toString();

  useEffect(() => {
    const term = query.trim();

    if (!enabled || term.length < minLength) {
      setResults([]);
      setSearching(false);
      return;
    }

    const ticket = ++latest.current;
    setSearching(true);

    const timer = setTimeout(async () => {
      const url = new URLSearchParams(paramString);
      url.set('search', term);
      url.set('limit', String(limit));

      try {
        const response = await fetch(`/api/taproot/items?${url.toString()}`, {
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return;
        const body = (await response.json()) as { items: ItemSearchResult[] };
        if (ticket !== latest.current) return;
        setResults(body.items);
      } catch {
        // Deliberately nothing — see the note above about what an empty list would claim.
      } finally {
        if (ticket === latest.current) setSearching(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, paramString, minLength, limit, enabled]);

  return { results, searching };
}
