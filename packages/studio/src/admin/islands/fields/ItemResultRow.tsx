import type { ReactNode } from 'react';

import { statusMeta } from '../../status.js';
import type { ItemSearchResult } from './useItemSearch.js';

/**
 * How a content item reads in a list of candidates: title first, path underneath it.
 *
 * **The hierarchy is the point, not the markup.** Every `<select>` this replaces rendered
 * `Title (path)` on one line at one weight, so a picker over a nested site read as a wall of URLs
 * and the title — the thing an editor actually knows the page by — was the part in brackets. The
 * path still has to be there: two pages can legitimately share a title, and the path is what tells
 * `/admissions/apply` from `/financial-aid/apply`. It is *subordinate*, not absent.
 *
 * Shared so the four controls that pick an item cannot drift into four opinions about that, the
 * same reason `status.ts` and `Timestamp.astro` exist. `RelationField` already rendered it this way
 * and was the only one that did.
 */

export function ItemSummary({
  title,
  path,
  /**
   * Shown when the title is missing because the item is gone.
   *
   * A relation can outlive its target — the row is deleted and the id stays in `data` — and the
   * control has to say so rather than render an empty line.
   */
  fallback = 'Item no longer exists',
}: {
  title?: string;
  path?: string;
  fallback?: string;
}) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium">{title ?? fallback}</span>
      {path && (
        <span className="block truncate font-mono text-xs text-content-subtle">{path}</span>
      )}
    </span>
  );
}

/**
 * The status pill beside a candidate, drawn only when the status is worth remarking on.
 *
 * Published is the expected state and a badge on every row would be noise that hides the two rows
 * that matter. Worth saying on a picker specifically: choosing a draft produces a link that renders
 * as nothing for a visitor, and the person choosing it is the only one positioned to notice before
 * it ships.
 *
 * The label is always a word. Colour alone would put this under WCAG 1.4.1, which is the rule
 * `StatusBadge.astro` states for the server-rendered half.
 */
export function ItemStatusPill({ status }: { status?: string }) {
  if (!status || status === 'published') return null;
  const meta = statusMeta(status);
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${meta.badgeClass}`}
    >
      {meta.label}
    </span>
  );
}

/**
 * One selectable candidate.
 *
 * A real `<button>`, which is what makes this list keyboard-reachable without a line of code: no
 * roving tabindex, no `aria-activedescendant`, none of the ARIA combobox pattern. That is a
 * deliberate choice over a hand-built combobox — see `ItemPicker` for the argument.
 *
 * `click`, never `mousedown`. Enter and Space raise a click with no `mousedown` before it, so acting
 * on the press makes a control reachable by pointer and by nothing else. `LinkTargetSearch` records
 * the same rule and the reason it once needed the opposite.
 */
export function ItemResultButton({
  item,
  icon,
  onSelect,
  disabled,
}: {
  item: ItemSearchResult;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-sunken disabled:opacity-40"
    >
      {icon}
      <ItemSummary title={item.title} path={item.path} />
      <ItemStatusPill status={item.status} />
    </button>
  );
}
