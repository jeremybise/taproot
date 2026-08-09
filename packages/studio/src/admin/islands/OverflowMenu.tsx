import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

import { useDismissable } from './useDismissable.js';

/**
 * The `⋯` menu for actions that crowd a dense row.
 *
 * A block's header carried five icon buttons — drag, disclose, promote-to-library, move up, move
 * down, remove — and on a phone that is most of the row's width before the block's own name. This
 * holds the rare and the destructive ones; **ordering and the disclosure stay visible**, because
 * reordering is the frequent act here and hiding it behind a menu costs a click every single time.
 *
 * ## What this is not
 *
 * Not a `role="menu"`. That pattern owes a roving tabindex, type-ahead, and arrow-key wrapping, and
 * gets in return an announcement most editors do not need — the house rule the admin already follows
 * (see `UserMenu.astro`) is a *disclosure* holding ordinary buttons, which is keyboard-complete for
 * free. This implements the four points `useDismissable.ts` documents as one contract with two
 * implementations: `aria-expanded` and `aria-controls` on the trigger, Escape scoped so it does not
 * also close the navigation drawer, click-outside, and focus back to the trigger.
 *
 * Focus return is done here rather than in the hook, which only reports the intent to close: the
 * hook cannot know which element opened the panel, and a menu that closes leaving focus on
 * `<body>` drops a keyboard user to the top of the page.
 *
 * ## Not shared with the status menu, deliberately
 *
 * `ItemEditor`'s status disclosure uses the same hook and keeps its own markup. It is a full-width
 * labelled button inside a panel; this is an icon button in a toolbar. Folding both into one
 * component means props for width, label, icon and item styling — a component configured into two
 * shapes rather than one shape used twice, which is the thing that later gets split back apart. The
 * *behaviour* is already shared, and that is the part that can be got wrong.
 */

export interface OverflowMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  /** Renders in the danger colour. Still an ordinary button — the server remains the check. */
  danger?: boolean;
}

interface Props {
  /**
   * Names the trigger, and must name *what* it acts on.
   *
   * A page of blocks has one of these per row, so "More actions" repeated eight times tells a
   * screen-reader user which control they are on and nothing about which block it belongs to.
   */
  label: string;
  items: OverflowMenuItem[];
  disabled?: boolean;
}

export function OverflowMenu({ label, items, disabled = false }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useDismissable(container, open, close);

  if (items.length === 0) return null;

  return (
    <div ref={container} className="relative">
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        aria-label={label}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="rounded border border-border-strong p-1.5 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-40"
      >
        <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
      </button>

      {open && (
        <ul
          id={`${id}-menu`}
          /*
            `right-0` so the panel opens inward from a trigger that sits at the end of its row.
            Anchored left it would hang off the right edge of a phone and reintroduce the horizontal
            scrolling the menus screen just had.
          */
          className="absolute right-0 top-full z-30 mt-1 min-w-44 space-y-0.5 rounded-lg border border-border bg-surface-raised p-1 shadow-lg"
        >
          {items.map((item) => (
            <li key={item.label}>
              <button
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  // Closed before the action runs: several of these remove the row this menu is in,
                  // and a panel whose container has just been unmounted cannot return focus anywhere.
                  setOpen(false);
                  item.onSelect();
                }}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors disabled:opacity-40 ${
                  item.danger ? 'text-danger hover:bg-danger-subtle' : 'hover:bg-surface-sunken'
                }`}
              >
                {item.icon}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default OverflowMenu;
