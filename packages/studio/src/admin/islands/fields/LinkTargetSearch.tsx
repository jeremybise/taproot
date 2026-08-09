import { useState } from 'react';
import { Check, FileText } from 'lucide-react';

import { useItemSearch } from './useItemSearch.js';

/**
 * Find a page by title, and hand back a reference to it.
 *
 * The link form used to be one free-text box, which meant an author typed a path from memory and the
 * link broke silently the next time that page moved. Choosing the item instead stores
 * `taproot:item:{id}`, and the delivery layer resolves it to wherever the page is *now* — the same
 * rule menu items already follow, for the same reason.
 *
 * The debounce, the ordering of overlapping responses and the "a failed search leaves the last
 * results alone" rule all live in `useItemSearch` now. They were written here and in `RelationField`
 * separately and identically, which is two chances for one of them to lose the stale-response guard.
 *
 * `minLength: 2`, unlike the pickers that narrow to one content type: this searches every type at
 * once, where a single letter matches most of a site and the list is noise before it is useful.
 */
export interface LinkTarget {
  id: string;
  title: string;
  path: string;
}

interface Props {
  /** Prefix for the ids this renders; the caller owns the surrounding form. */
  id: string;
  /** The page picked so far, shown instead of the results so a choice is visibly a choice. */
  chosen: LinkTarget | null;
  onPick: (target: LinkTarget) => void;
  onClear: () => void;
}

export function LinkTargetSearch({ id, chosen, onPick, onClear }: Props) {
  const [query, setQuery] = useState('');
  const { results, searching } = useItemSearch(query, { minLength: 2, limit: 20 });

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium">
        Search pages by title
      </label>
      <input
        id={id}
        type="search"
        value={query}
        /* The dialog focuses this on open — see `onOpenAutoFocus` there. */
        data-autofocus
        placeholder="Start typing a page title"
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          setQuery(event.target.value);
          // Typing again is how a choice is undone, which is the same move the address panel makes:
          // one visible thing is the answer, and editing the other replaces it.
          if (chosen) onClear();
        }}
        className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2.5 py-2 text-sm"
      />
      <p id={`${id}-hint`} className="mt-1.5 text-xs text-content-subtle">
        A link chosen this way is stored as a reference, so it follows the page if it is renamed or
        moved.
      </p>

      {/*
        Polite: results change as the author types, and an assertive region would interrupt the
        word being typed — the same reasoning as the accessibility panel's summary.
      */}
      <div aria-live="polite" className="sr-only">
        {chosen
          ? `${chosen.title} chosen`
          : searching
            ? 'Searching'
            : results.length > 0
              ? `${results.length} pages found`
              : ''}
      </div>

      {chosen ? (
        <p className="mt-3 flex items-start gap-2.5 rounded-md border border-accent bg-accent-subtle px-3 py-2.5">
          <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{chosen.title}</span>
            <span className="block truncate font-mono text-xs text-content-subtle">
              {chosen.path}
            </span>
          </span>
        </p>
      ) : (
        results.length > 0 && (
          <ul className="mt-3 max-h-44 overflow-y-auto rounded-md border border-border">
            {results.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  /*
                    `click`, not `mousedown`, and there is no longer a `mousedown` handler beside it.

                    The old inline form had one that called `preventDefault`, because pressing here
                    moved focus out of the editor and collapsed the selection — the difference
                    between wrapping a phrase in a link and inserting one at the cursor. In a dialog
                    focus has already left the editor before this list exists, so there is nothing
                    left for that to protect; the caret's range is captured when the dialog opens and
                    restored when Apply runs. What has not changed is that the act belongs on
                    `click`: Enter and Space raise one with no `mousedown` before it, so acting on
                    the press would make this reachable by pointer and by nothing else.
                  */
                  onClick={() => onPick(item)}
                  className="flex w-full items-start gap-2.5 border-b border-border px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-surface-sunken"
                >
                  <FileText
                    className="mt-0.5 h-4 w-4 shrink-0 text-content-muted"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="block truncate font-mono text-xs text-content-subtle">
                      {item.path}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
