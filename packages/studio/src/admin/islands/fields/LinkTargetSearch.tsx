import { useEffect, useRef, useState } from 'react';

/**
 * Find a page by title, and hand back a reference to it.
 *
 * The link form used to be one free-text box, which meant an author typed a path from memory and the
 * link broke silently the next time that page moved. Choosing the item instead stores
 * `taproot:item:{id}`, and the delivery layer resolves it to wherever the page is *now* — the same
 * rule menu items already follow, for the same reason.
 *
 * Debounced, like `RelationField`'s search: the items query is a `LIKE` over two columns and firing
 * one per keystroke queues requests the author has already typed past.
 */
export interface LinkTarget {
  id: string;
  title: string;
  path: string;
}

interface Props {
  /** Rendered under the input; the caller owns the surrounding form. */
  id: string;
  onPick: (target: LinkTarget) => void;
}

export function LinkTargetSearch({ id, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LinkTarget[]>([]);
  const [searching, setSearching] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }

    const ticket = ++latest.current;
    setSearching(true);

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/taproot/items?search=${encodeURIComponent(term)}&limit=20`,
          { headers: { accept: 'application/json' } },
        );
        if (!response.ok) return;
        const body = (await response.json()) as { items: LinkTarget[] };
        // A stale response must not overwrite a newer one; the ticket is what orders them.
        if (ticket !== latest.current) return;
        setResults(body.items);
      } catch {
        // A failed search leaves the last results rather than emptying the list under the cursor.
      } finally {
        if (ticket === latest.current) setSearching(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={id} className="block text-xs font-medium">
        Or link to a page
      </label>
      <input
        id={id}
        type="search"
        value={query}
        placeholder="Search by title"
        aria-describedby={`${id}-hint`}
        onChange={(event) => setQuery(event.target.value)}
        className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm"
      />
      <p id={`${id}-hint`} className="mt-1 text-xs text-content-subtle">
        A link chosen this way follows the page if it moves.
      </p>

      {/*
        Polite: results change as the author types, and an assertive region would interrupt the
        word being typed — the same reasoning as the accessibility panel's summary.
      */}
      <div aria-live="polite" className="sr-only">
        {searching ? 'Searching' : results.length > 0 ? `${results.length} pages found` : ''}
      </div>

      {results.length > 0 && (
        <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border">
          {results.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onPick(item)}
                className="block w-full px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-surface-sunken"
              >
                <span className="block truncate font-medium">{item.title}</span>
                <span className="block truncate font-mono text-xs text-content-subtle">
                  {item.path}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
