import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';

import type { RelationOption, RelationTarget } from '../../relationOptions.js';
import { statusMeta } from '../../status.js';

/**
 * The editor for a `relation` field.
 *
 * Inline rather than a modal dialog, which is where this differs from the media picker on purpose.
 * A media library is browsed by eye and rewards a big grid; a list of content items is read by
 * title, so there is nothing to see that a filtered list under a search box does not already show,
 * and a dialog would add a focus trap and a portal for no gain. That puts relation next to the
 * taxonomy control, which is its closest sibling — both pick records by name from a known set.
 *
 * The candidate list arrives as a prop for the first page and is searched through the items API
 * beyond it, the same split the media picker uses: a content type can hold far more items than
 * belong in a server-rendered prop.
 */

export interface RelationFieldProps {
  /** Placed on the group, so the field's `<label for>` has a target that exists. */
  id?: string;
  /** The field label's id. A group cannot be named by `<label for>`, so it is named by this. */
  labelledBy?: string;
  describedBy?: string;
  /** Ordered item ids. Single-value fields use a one-element array. */
  value: string[];
  onChange: (ids: string[]) => void;
  target: RelationTarget | null;
  /**
   * Whether the field names a target type at all, as distinct from whether its items are loaded.
   *
   * The content-type builder's live preview renders through this same control with no candidates
   * resolved — it has no database. Without the distinction a correctly configured field would tell
   * the author it had no target, which is the one thing they had just finished setting.
   */
  hasTarget?: boolean;
  multiple?: boolean;
  disabled?: boolean;
  invalid?: boolean;
}

export function RelationField({
  id,
  labelledBy,
  describedBy,
  value,
  onChange,
  target,
  hasTarget = false,
  multiple = false,
  disabled = false,
  invalid = false,
}: RelationFieldProps) {
  const reactId = useId();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<RelationOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState('');

  /**
   * Everything this control has ever seen, by id.
   *
   * Resolving a chosen item from the visible results only would drop its title the moment a search
   * no longer returned it — the same bug the media picker hit, where the footer kept counting an
   * asset the grid had stopped showing.
   */
  const known = useMemo(() => {
    const map = new Map<string, RelationOption>();
    for (const option of [...(target?.items ?? []), ...found]) map.set(option.id, option);
    return map;
  }, [target, found]);

  /** The latest search, so a slow earlier response cannot overwrite a newer one. */
  const latest = useRef(0);

  useEffect(() => {
    if (!target) return;
    const term = query.trim();
    if (term === '') {
      setSearching(false);
      return;
    }

    const ticket = ++latest.current;
    setSearching(true);

    // Debounced: the items query is a LIKE over two columns, and firing one per keystroke would
    // queue requests the editor has already typed past.
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/taproot/items?contentTypeId=${encodeURIComponent(target.contentTypeId)}` +
            `&search=${encodeURIComponent(term)}&limit=50`,
          { headers: { accept: 'application/json' } },
        );
        if (!response.ok) return;
        const body = (await response.json()) as { items: RelationOption[] };
        if (ticket !== latest.current) return;
        setFound((current) => merge(current, body.items));
      } catch {
        // A search that fails leaves the first page on screen rather than emptying the control.
      } finally {
        if (ticket === latest.current) setSearching(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [query, target]);

  if (!target) {
    return (
      <p
        id={id}
        className="mt-1.5 rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-content-subtle"
      >
        {hasTarget
          ? 'Items of the target type are listed here in the item editor.'
          : 'This field has no target content type yet. Set one in Settings → Content types, and items of that type become selectable here.'}
      </p>
    );
  }

  const chosen = value.map((entry) => ({ id: entry, item: known.get(entry) ?? null }));
  const term = query.trim().toLowerCase();

  /**
   * What the list offers: the search results when searching, the first page otherwise.
   *
   * Already-chosen items are filtered out rather than shown as selected — a single-value field
   * replaces rather than accumulates, and for a multi-value one an item already in the list above
   * is not a candidate.
   */
  const candidates = (term === '' ? target.items : [...known.values()])
    .filter((option) => !value.includes(option.id))
    .filter((option) => (term === '' ? true : matches(option, term)));

  const listId = `${reactId}-results`;
  const searchId = `${reactId}-search`;

  const choose = (option: RelationOption) => {
    const next = multiple ? [...value, option.id] : [option.id];
    onChange(next);
    setStatus(`${option.title} added.`);
    // Clearing the search returns the list to the first page, which is the useful next state:
    // having chosen one, the editor is either done or looking for a different one.
    setQuery('');
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
    setStatus(`Moved to position ${to + 1} of ${next.length}.`);
  };

  return (
    <div
      id={id}
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`mt-1.5 rounded-md border px-3 py-3 ${
        invalid ? 'border-danger' : 'border-border-strong'
      } ${disabled ? 'opacity-90' : ''}`}
    >
      {chosen.length === 0 ? (
        <p className="text-sm text-content-subtle">
          No {target.name.toLowerCase()} chosen{multiple ? ' yet' : ''}.
        </p>
      ) : (
        <ul className="space-y-2">
          {chosen.map((entry, index) => (
            <li key={`${entry.id}-${index}`} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {entry.item?.title ?? 'Item no longer exists'}
                </p>
                <p className="truncate text-xs text-content-subtle">
                  {entry.item?.path ?? entry.id}
                </p>
              </div>

              {entry.item && entry.item.status !== 'published' && (
                /*
                  Worth saying on the page doing the referencing: a relation to a draft renders as
                  nothing for a visitor, and the editor who chose it is the one person able to
                  notice before it ships.
                */
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${
                    statusMeta(entry.item.status).badgeClass
                  }`}
                >
                  {statusMeta(entry.item.status).label}
                </span>
              )}

              {multiple && chosen.length > 1 && (
                <div className="flex shrink-0 gap-1">
                  <IconButton
                    label={`Move ${entry.item?.title ?? 'this item'} up`}
                    disabled={disabled || index === 0}
                    onClick={() => move(index, index - 1)}
                  >
                    <ChevronUp className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={`Move ${entry.item?.title ?? 'this item'} down`}
                    disabled={disabled || index === chosen.length - 1}
                    onClick={() => move(index, index + 1)}
                  >
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              )}

              <IconButton
                label={`Remove ${entry.item?.title ?? 'this item'}`}
                disabled={disabled}
                onClick={() => {
                  onChange(value.filter((_, position) => position !== index));
                  setStatus(`${entry.item?.title ?? 'Item'} removed.`);
                }}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      {!disabled && (multiple || chosen.length === 0) && (
        <div className="mt-3 border-t border-border pt-3">
          <label htmlFor={searchId} className="block text-xs font-medium text-content-subtle">
            {chosen.length === 0
              ? `Choose ${article(target.name)} ${target.name.toLowerCase()}`
              : `Add another ${target.name.toLowerCase()}`}
          </label>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${target.namePlural.toLowerCase()} by title or path`}
            aria-controls={listId}
            className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
          />

          <ul id={listId} className="mt-2 max-h-56 space-y-1 overflow-y-auto">
            {candidates.length === 0 ? (
              <li className="px-1 py-2 text-xs text-content-subtle">
                {searching
                  ? 'Searching…'
                  : term === ''
                    ? `Every ${target.name.toLowerCase()} is already chosen.`
                    : `No ${target.namePlural.toLowerCase()} match “${query.trim()}”.`}
              </li>
            ) : (
              candidates.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    onClick={() => choose(option)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-sunken"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{option.title}</span>
                      <span className="block truncate text-xs text-content-subtle">
                        {option.path}
                      </span>
                    </span>
                    {option.status !== 'published' && (
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${
                          statusMeta(option.status).badgeClass
                        }`}
                      >
                        {statusMeta(option.status).label}
                      </span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>

          {term === '' && target.total > target.items.length && (
            /*
              Said plainly rather than left to be discovered. The list is a page, not the set, and
              an editor who cannot find an item they know exists will otherwise conclude it is gone
              rather than that they need to type.
            */
            <p className="mt-1.5 text-xs text-content-subtle">
              Showing {target.items.length} of {target.total}. Search to reach the rest.
            </p>
          )}
        </div>
      )}

      {/* Choosing, removing, and reordering all change a list that is otherwise only visible. */}
      <p aria-live="polite" className="sr-only-focusable">
        {status}
      </p>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded-md border border-border p-1.5 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function matches(option: RelationOption, term: string): boolean {
  return (
    option.title.toLowerCase().includes(term) || option.path.toLowerCase().includes(term)
  );
}

/** Merge search results into what is already known, without duplicating. */
function merge(current: RelationOption[], incoming: RelationOption[]): RelationOption[] {
  const seen = new Set(current.map((option) => option.id));
  return [...current, ...incoming.filter((option) => !seen.has(option.id))];
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

export default RelationField;
