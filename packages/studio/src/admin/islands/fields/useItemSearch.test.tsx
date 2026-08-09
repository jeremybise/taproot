// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useItemSearch } from './useItemSearch.js';

/**
 * The asynchrony behind every control that picks a content item.
 *
 * This logic was written twice — in `RelationField` and `LinkTargetSearch` — and tested through
 * neither: both suites drive the *control*, so a broken stale-response guard would show up as a
 * flake nobody could reproduce rather than as a failure. Extracting it is what makes it testable,
 * and these are the properties that were previously being taken on trust.
 */

/** Resolve later than a request made after it, which is the whole point of the ordering guard. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function itemsResponse(items: { id: string; title: string; path: string }[]) {
  return { ok: true, json: async () => ({ items }) } as Response;
}

const alpha = { id: 'a', title: 'Alpha', path: '/alpha' };
const beta = { id: 'b', title: 'Beta', path: '/beta' };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

describe('useItemSearch', () => {
  it('does not reach the server below the minimum length', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useItemSearch('a', { minLength: 2 }));

    await vi.advanceTimersByTimeAsync(500);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
  });

  it('debounces, so typing past a term does not queue a request per keystroke', async () => {
    // The url parameter is declared so `mock.calls[0][0]` is typed; the body ignores it.
    const fetchMock = vi.fn(async (_url: string) => itemsResponse([alpha]));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = renderHook(({ query }) => useItemSearch(query), {
      initialProps: { query: 'n' },
    });

    // Each re-render restarts the timer; only the last one should ever fire.
    rerender({ query: 'nu' });
    rerender({ query: 'nur' });
    rerender({ query: 'nurs' });

    await vi.advanceTimersByTimeAsync(500);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('search=nurs');
  });

  it('discards a slow earlier response so it cannot overwrite a newer one', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(({ query }) => useItemSearch(query), {
      initialProps: { query: 'al' },
    });

    // Let the first request leave. The timer's cleanup cannot recall it.
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ query: 'be' });
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The newer search answers first, then the older one arrives late.
    second.resolve(itemsResponse([beta]));
    await waitFor(() => expect(result.current.results).toEqual([beta]));

    await act(async () => {
      first.resolve(itemsResponse([alpha]));
      /*
        Settled properly rather than by advancing a timer.

        The handler awaits `fetch` and then `response.json()`, so the state update is two microtask
        turns behind the resolve — and an assertion made before both have run passes whether or not
        the guard exists. That is how the first version of this test passed with the guard deleted,
        which is the thing it was written to catch. Awaiting the response's own `json()` puts this
        after the same two turns the handler takes.
      */
      await first.promise.then((response) => response.json());
    });

    // Still the newer answer. Without the ticket this reads [alpha] — the list under the cursor
    // disagreeing with the box above it, which is exactly the bug nobody can reproduce on purpose.
    expect(result.current.results).toEqual([beta]);
  });

  it('leaves the last results alone when a search fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(itemsResponse([alpha]))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(({ query }) => useItemSearch(query), {
      initialProps: { query: 'al' },
    });

    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(result.current.results).toEqual([alpha]));

    rerender({ query: 'alp' });
    await vi.advanceTimersByTimeAsync(300);

    // Emptying here would mean a dropped connection reads as "no such page" — the one answer that
    // sends an editor off to create a duplicate.
    await waitFor(() => expect(result.current.searching).toBe(false));
    expect(result.current.results).toEqual([alpha]);
  });

  it("sends the caller's narrowing parameters and omits empty ones", async () => {
    const fetchMock = vi.fn(async (_url: string) => itemsResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() =>
      useItemSearch('nurs', {
        params: { contentTypeKinds: 'page', contentTypeId: undefined },
        limit: 20,
      }),
    );

    await vi.advanceTimersByTimeAsync(300);

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('contentTypeKinds=page');
    expect(url).toContain('limit=20');
    // An absent parameter must not travel as the string "undefined", which the server would then
    // have to recognise and refuse.
    expect(url).not.toContain('contentTypeId');
  });

  it('does not search at all when disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useItemSearch('nursing', { enabled: false }));
    await vi.advanceTimersByTimeAsync(500);

    // The content-type builder's preview renders `RelationField` with no target and no database
    // behind it; firing a request per keystroke there would 400 in a loop.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
