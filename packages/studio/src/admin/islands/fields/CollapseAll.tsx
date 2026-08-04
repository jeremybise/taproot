import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';

/**
 * "Expand all" / "Collapse all" for a list of collapsible rows.
 *
 * **Two buttons rather than one toggle.** A single control would need `aria-expanded`, which
 * describes the state of the thing a control owns — and this one owns many panels that are freely
 * in mixed states, so there is no honest value to put there. A toggle whose label flips also has
 * nothing to say when half the rows are open: "Expand all" and "Collapse all" are both meaningful
 * at once, and each is idempotent.
 *
 * Neither is ever disabled. Pressing "Expand all" when everything is already open does nothing
 * visible, so the caller announces the outcome through the live region it already has — feedback a
 * disabled button cannot give, and no gap in the tab order.
 */
export function CollapseAll({
  onExpandAll,
  onCollapseAll,
  label,
}: {
  onExpandAll: () => void;
  onCollapseAll: () => void;
  /** What is being expanded, plural — "blocks", "entries". Named so the two buttons never collide. */
  label: string;
}) {
  return (
    <div className="mb-2 flex justify-end gap-1">
      <button
        type="button"
        onClick={onExpandAll}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
      >
        <ChevronsUpDown aria-hidden="true" size={13} />
        Expand all {label}
      </button>
      <button
        type="button"
        onClick={onCollapseAll}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
      >
        <ChevronsDownUp aria-hidden="true" size={13} />
        Collapse all {label}
      </button>
    </div>
  );
}

export default CollapseAll;
