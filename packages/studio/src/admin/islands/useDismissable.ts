import { useEffect, type RefObject } from 'react';

/**
 * Escape and click-outside for a disclosure that React owns.
 *
 * **The second half of one contract.** `UserMenu.astro` drives Astro-rendered `[data-menu]`
 * disclosures with a delegated script; this drives the React-rendered ones. Two implementations, and
 * the split is not laziness: React owns the DOM it renders, so a script setting `hidden` on a
 * React-rendered panel loses that attribute on the next re-render — a race with no good fix. Keeping
 * the open state in React and the behaviour here is the version that cannot desynchronise.
 *
 * The contract both sides implement, so a change to one is a change to the other:
 *  - the trigger carries `aria-expanded` and `aria-controls`
 *  - Escape closes, and only when this disclosure is the open one
 *  - a click outside closes; a click inside does not
 *  - closing returns focus to the trigger
 *
 * `capture: true` on the pointer listener, because a menu item that navigates or re-renders can
 * remove itself before a bubbling handler runs — and then the click is measured against an element
 * no longer in the document, which reads as "outside" and closes the menu before its own handler
 * fires.
 */
export function useDismissable(
  container: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (target && container.current?.contains(target)) return;
      onClose();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      /**
       * Stopped here so the navigation drawer's own document-level Escape handler does not also
       * fire. Both guard on their own state, so only one of them is ever open — but a menu inside
       * an open drawer would otherwise close both with one press.
       */
      event.stopPropagation();
      onClose();
    }

    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [container, open, onClose]);
}
