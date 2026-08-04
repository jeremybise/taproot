import { useState } from 'react';

/**
 * Per-row collapse state for the two editors that compose a list of things: `BlockListEditor` and
 * `RepeaterField`.
 *
 * Shared rather than written twice because the two disagreed for a phase — blocks collapsed and
 * repeater rows did not — and the fix was to give repeaters the pattern blocks already had, not to
 * invent a second one.
 *
 * **Nothing here persists, and that is deliberate.** The only flash-free precedent in this admin is
 * a cookie read on the server before any HTML is sent (`data-theme`, `data-preview`), and per-row
 * state keyed by block instance id is far too fine-grained to spend a cookie on; `localStorage`
 * would be read after first paint and flash the wrong shape. State resets on save, which is what
 * `BlockListEditor` has always done.
 *
 * **The default is expanded, and that is load-bearing for `npm run a11y`.** The audit runs with
 * `runScripts: 'outside-only'`, so what axe sees is the island's *server-rendered* markup with this
 * hook's initial state — every panel open. A collapsed panel carries `hidden`, which is
 * `display: none`, and axe skips its contents entirely. Defaulting to collapsed (for long lists,
 * say) would silently drop every field inside every block from the audit while the run still
 * reported zero, which is the same failure the sheets fix documents from the other direction.
 */
export function useCollapsible() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function collapseAll(ids: string[]) {
    setCollapsed(new Set(ids));
  }

  function expandAll() {
    setCollapsed(new Set());
  }

  return { collapsed, toggle, collapseAll, expandAll };
}
