import { useEffect, useId, useState } from 'react';

import { ItemResultButton, ItemSummary } from './ItemResultRow.js';
import { useItemSearch, type ItemSearchResult } from './useItemSearch.js';

/**
 * Choose one content item, from a first page or by searching past it.
 *
 * Replaces two `<select>`s that had outgrown the interaction: the menus screen's "Page" list, capped
 * at 200 items so a larger site simply could not link its newer pages into a menu, and the item
 * editor's parent picker, capped at 500 paths on one line each. `parentOptions.ts` named this
 * control before it existed — *"the answer beyond that is a searchable control on `RelationField`'s
 * pattern"*.
 *
 * ## Not an ARIA combobox, deliberately
 *
 * A search `<input>` above a list of real `<button>`s. That is what `RelationField` and
 * `LinkTargetSearch` already are, and it is keyboard-complete for free — Tab reaches each candidate,
 * Enter and Space activate it, and nothing needs a roving tabindex or `aria-activedescendant`. The
 * combobox pattern would buy a shorter tab sequence and cost a hand-built widget, which is the trade
 * the house rule about custom widgets already settles (see `LinkDialog`'s mode selector, which is a
 * radio group drawn as tabs for the same reason).
 *
 * ## The server renders a `<select>`, and that is load-bearing twice
 *
 * `enhanced` is false during SSR and the first client render, exactly as `draggable` is in
 * `MenuItemList` and `BlockListEditor` — so the server emits a plain grouped `<select>` and the
 * search UI replaces it only once React is running. Two independent reasons, either sufficient:
 *
 *  - **The menus add-forms are ordinary HTML POSTs that work with no JavaScript**, which
 *    `menus/[id].astro` states as a property of the screen. A React-only control would remove that
 *    silently, leaving a form whose only input renders as nothing.
 *  - **`scripts/a11y-audit.mjs` runs with `runScripts: 'outside-only'`**, so what axe sees *is* the
 *    server render. A native `<select>` there keeps those routes genuinely audited instead of
 *    quietly auditing an empty div — the same trap as auditing a closed `<dialog>`. The hydrated
 *    control gets its own jsdom axe test, following `MediaPicker` and `RichTextEditor`.
 *
 * The chosen id rides in a hidden input under `name`, so the form's POST body is byte-identical
 * whether or not the enhancement ran. A caller driving React state instead passes `onChange` and no
 * `name`.
 */

export interface ItemPickerOption extends ItemSearchResult {
  /**
   * Group heading, when the caller wants one — the owning content type, for the parent picker.
   *
   * Options must already be contiguous by group, which is the same requirement `<optgroup>` imposes
   * and the reason `parentCandidates` sorts stably by type.
   */
  groupLabel?: string;
}

interface Props {
  /** DOM id for the labelled control — the `<select>` before enhancement, the search box after. */
  id: string;
  /** Form field name. Omit for a caller that only wants `onChange`. */
  name?: string;
  value: string | null;
  onChange?: (id: string | null) => void;
  /** The server-resolved first page. Searching reaches past it. */
  options: ItemPickerOption[];
  /**
   * How many candidates exist in total, so the control can say what it is not showing.
   *
   * Said plainly rather than left to be discovered: an editor who cannot find an item they know
   * exists will conclude it is gone rather than that they need to type.
   */
  total?: number;
  /** Query parameters narrowing the search — `contentTypeId`, `contentTypeKinds`. */
  searchParams?: Record<string, string | undefined>;
  /** Ids the caller will not accept — the item being edited, and its own descendants. */
  excludeIds?: string[];
  /**
   * Paths whose subtree is excluded.
   *
   * The parent picker needs this on *search results* and not only on the first page: an item cannot
   * move under its own descendant, and the server refuses it, but an option that can only ever
   * produce an error should never have been offered.
   */
  excludeSubtreeOf?: string | null;
  /**
   * Native `required` on the pre-enhancement `<select>`.
   *
   * It cannot carry over: the enhanced control holds its value in a hidden input, and browsers
   * exclude hidden inputs from constraint validation entirely. So after hydration an empty required
   * field is caught by the server, which answers the form's own `?error=` branch. That is the same
   * arrangement the content-type delete confirmation already relies on — the server is the check,
   * and a client-side one is a convenience that must not be the only one.
   */
  required?: boolean;
  disabled?: boolean;
  describedBy?: string;
  /** Label for the "nothing chosen" state and the search box, e.g. "page". */
  noun?: string;
  /** Offered as an explicit choice when the field is optional — "Top level", "No parent". */
  emptyLabel?: string;
}

export function ItemPicker({
  id,
  name,
  value,
  onChange,
  options,
  total,
  searchParams,
  excludeIds = [],
  excludeSubtreeOf = null,
  required = false,
  disabled = false,
  describedBy,
  noun = 'page',
  emptyLabel,
}: Props) {
  const reactId = useId();
  const [selected, setSelected] = useState<string | null>(value);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');

  // False during SSR and the first client render, so both produce identical HTML.
  const [enhanced, setEnhanced] = useState(false);
  useEffect(() => setEnhanced(true), []);

  const { results, searching } = useItemSearch(query, {
    params: searchParams,
    enabled: enhanced && !disabled,
  });

  /**
   * Everything this control has ever seen, by id.
   *
   * Resolving the chosen item from the visible results alone would drop its title the moment a
   * search stopped returning it — the bug the media picker hit, where the footer kept counting an
   * asset the grid had stopped showing.
   */
  const [seen, setSeen] = useState<Map<string, ItemPickerOption>>(
    () => new Map(options.map((option) => [option.id, option])),
  );

  useEffect(() => {
    if (results.length === 0) return;
    setSeen((current) => {
      const next = new Map(current);
      for (const result of results) if (!next.has(result.id)) next.set(result.id, result);
      return next;
    });
  }, [results]);

  const excluded = new Set(excludeIds);

  const allowed = (option: ItemPickerOption) => {
    if (excluded.has(option.id)) return false;
    // `${path}/` rather than `path`, or a sibling whose path merely starts with the same characters
    // would be excluded too — `/programs-archive` is not inside `/programs`.
    if (excludeSubtreeOf && option.path.startsWith(`${excludeSubtreeOf}/`)) return false;
    return true;
  };

  const term = query.trim();
  const candidates = (term === '' ? options : results)
    .filter(allowed)
    .filter((option) => option.id !== selected);

  const chosen = selected ? (seen.get(selected) ?? null) : null;

  function choose(id: string | null, label: string) {
    setSelected(id);
    onChange?.(id);
    setStatus(`${label} chosen.`);
    // Returning the list to the first page is the useful next state: having chosen, the editor is
    // either done or looking for a different one.
    setQuery('');
  }

  /**
   * Before hydration — and for anyone with JavaScript off — this is the whole control.
   *
   * Grouped exactly as it was, because `<optgroup>` is what the server-rendered form has always
   * used and this must stay a working picker rather than a placeholder.
   */
  if (!enhanced) {
    return (
      <select
        id={id}
        name={name}
        required={required}
        disabled={disabled}
        defaultValue={value ?? ''}
        aria-describedby={describedBy}
        className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
      >
        {(emptyLabel || !required) && <option value="">{emptyLabel ?? '— None —'}</option>}
        {groupOptions(options).map((group) =>
          group.label ? (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title} ({option.path})
                </option>
              ))}
            </optgroup>
          ) : (
            group.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.title} ({option.path})
              </option>
            ))
          ),
        )}
      </select>
    );
  }

  const listId = `${reactId}-results`;

  return (
    <div className="mt-1.5">
      {name && <input type="hidden" name={name} value={selected ?? ''} />}

      {/*
        The current choice, above the search box rather than replacing it.

        Replacing it was the first shape and is wrong for one concrete reason: the caller labels this
        control with `<label for={id}>`, and `id` has to land on a labelable element in *every*
        state. A search box that disappears once something is chosen leaves that label pointing at
        nothing — silently inert, announced correctly through other means, and broken only for
        click-to-focus. `packages/studio/CLAUDE.md` records that failure mode; this is the shape that
        cannot have it. It is also `RelationField`'s arrangement, where the chosen entries sit above
        the search rather than in place of it.
      */}
      {selected && (
        <div className="mb-2 flex items-start gap-2.5 rounded-md border border-border-strong bg-surface px-3 py-2">
          {chosen ? (
            <ItemSummary title={chosen.title} path={chosen.path} />
          ) : (
            /*
              Chosen, but not resolvable to a title — a stored id whose row has been deleted, or one
              from outside the first page that no search has surfaced. Shown as the id rather than as
              an empty box, which would read as nothing being selected at all.
            */
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-content-subtle">
              {selected}
            </span>
          )}
          {!disabled && (
            <button
              type="button"
              onClick={() => choose(null, emptyLabel ?? 'Nothing')}
              className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-surface-sunken"
            >
              Clear
            </button>
          )}
        </div>
      )}

      <input
        id={id}
        type="search"
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Search ${noun}s by title or path`}
        aria-controls={listId}
        aria-describedby={describedBy}
        className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm disabled:opacity-60"
      />

      {!disabled && (
        <>
          <ul id={listId} className="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
            {emptyLabel && term === '' && selected && (
              <li>
                <button
                  type="button"
                  onClick={() => choose(null, emptyLabel)}
                  className="w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-sunken"
                >
                  {emptyLabel}
                </button>
              </li>
            )}

            {candidates.length === 0 ? (
              <li className="px-1 py-2 text-xs text-content-subtle">
                {searching
                  ? 'Searching…'
                  : term === ''
                    ? `No ${noun}s available.`
                    : `No ${noun}s match “${term}”.`}
              </li>
            ) : (
              groupOptions(candidates).map((group) =>
                group.label ? (
                  /*
                    A labelled group is a nested list, so the heading names the items under it. With
                    no groups the buttons stay flat — wrapping every candidate in a second single-item
                    list would announce a list of one to a screen reader on every row.
                  */
                  <li key={group.label}>
                    <p
                      id={`${reactId}-${slug(group.label)}`}
                      className="px-2 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-content-subtle"
                    >
                      {group.label}
                    </p>
                    <ul aria-labelledby={`${reactId}-${slug(group.label)}`} className="space-y-0.5">
                      {group.options.map((option) => (
                        <li key={option.id}>
                          <ItemResultButton
                            item={option}
                            onSelect={() => choose(option.id, option.title)}
                          />
                        </li>
                      ))}
                    </ul>
                  </li>
                ) : (
                  group.options.map((option) => (
                    <li key={option.id}>
                      <ItemResultButton
                        item={option}
                        onSelect={() => choose(option.id, option.title)}
                      />
                    </li>
                  ))
                ),
              )
            )}
          </ul>

          {term === '' && total !== undefined && total > options.length && (
            /*
              Said plainly rather than left to be discovered. The list is a page, not the set, and an
              editor who cannot find an item they know exists will conclude it is gone rather than
              that they need to type.
            */
            <p className="mt-1.5 text-xs text-content-subtle">
              Showing {options.length} of {total}. Search to reach the rest.
            </p>
          )}
        </>
      )}

      {/* Choosing changes a value that is otherwise only visible. */}
      <p aria-live="polite" className="sr-only-focusable">
        {status}
      </p>
    </div>
  );
}

/**
 * Split a contiguous list into its groups, preserving order.
 *
 * Contiguity is assumed rather than sorted for, matching `ItemEditor`'s `groupByType`: the server
 * already sorted, and re-grouping here would be a second ordering free to disagree with it.
 */
function groupOptions(
  options: ItemPickerOption[],
): { label: string | undefined; options: ItemPickerOption[] }[] {
  const groups: { label: string | undefined; options: ItemPickerOption[] }[] = [];
  for (const option of options) {
    const current = groups.at(-1);
    if (current && current.label === option.groupLabel) current.options.push(option);
    else groups.push({ label: option.groupLabel, options: [option] });
  }
  return groups;
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export default ItemPicker;
