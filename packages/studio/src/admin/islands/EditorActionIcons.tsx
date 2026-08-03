import { Eye, History, Link2, Trash2 } from 'lucide-react';

import { PREVIEW_PANE_COOKIE_NAME } from '../previewPane.js';

/**
 * Preview, history, what-links-here, and — set apart — delete.
 *
 * These were an Astro component in the page header until the editor grew a sticky action bar. The
 * bar has to carry Save, Save is React state (`busy`, a changing label), and a server-rendered
 * header cannot drive it — so the bar belongs to the island, and these came with it rather than
 * leaving the screen with two floating bars.
 *
 * The sheet triggers still work by `data-sheet-open`, matched by id from anywhere on the page. That
 * only holds because `Sheet.astro` now delegates from the document: it used to bind every trigger it
 * could find at load, which is a list that never includes anything React renders afterwards.
 *
 * **Delete is separated on purpose.** Its old placement — a section at the bottom of the page — was
 * a speed bump, and making it a fourth peer icon would make destruction the most reachable action on
 * the screen. The typed confirmation is still checked server-side, so nothing here is load-bearing
 * for safety; this is about not inviting the click.
 */
interface Props {
  previewable: boolean;
  previewOpen: boolean;
  onTogglePreview: (open: boolean) => void;
  showReferences: boolean;
  showDelete: boolean;
}

const ICON = 'rounded-md border border-border-strong p-2 transition-colors hover:bg-surface-sunken';

export default function EditorActionIcons({
  previewable,
  previewOpen,
  onTogglePreview,
  showReferences,
  showDelete,
}: Props) {
  return (
    <div className="flex items-center gap-1">
      {previewable && (
        <button
          type="button"
          aria-pressed={previewOpen}
          aria-controls="editor-preview-pane"
          /* The name says what it does, and `title` gives pointer users the same words. */
          aria-label="Live preview"
          title="Live preview"
          onClick={() => onTogglePreview(!previewOpen)}
          className={`${ICON} ${previewOpen ? 'border-accent bg-accent-subtle' : ''}`}
        >
          <Eye aria-hidden="true" className="h-4 w-4" />
        </button>
      )}

      <button
        type="button"
        data-sheet-open="sheet-history"
        aria-label="Revision history"
        title="Revision history"
        className={ICON}
      >
        <History aria-hidden="true" className="h-4 w-4" />
      </button>

      {showReferences && (
        <button
          type="button"
          data-sheet-open="sheet-references"
          aria-label="What links here"
          title="What links here"
          className={ICON}
        >
          <Link2 aria-hidden="true" className="h-4 w-4" />
        </button>
      )}

      {showDelete && (
        <>
          {/*
            Decorative, so hidden. What the separation expresses is carried for a screen reader by
            the button's own name — the same rule the status badges follow, where colour is never
            the only signal.
          */}
          <span aria-hidden="true" className="mx-1 h-6 w-px bg-border" />
          <button
            type="button"
            data-sheet-open="sheet-delete"
            aria-label="Delete this item"
            title="Delete this item"
            className={`${ICON} text-danger hover:bg-danger-subtle`}
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Write the pane's open state where the server will read it next time.
 *
 * `data-preview` on `<html>` is the single source of truth — the layout stamps it from a cookie
 * before any CSS is sent, the width rule reads it, and the editor observes it. This writes both, so
 * the change lands now *and* survives the navigation `save()` performs.
 *
 * Deliberately without a round trip: this button sits above a form that may hold an hour of unsaved
 * writing, so the `ThemeSwitcher` pattern of posting and redirecting would discard it.
 */
export function writePreviewPaneState(open: boolean): void {
  if (open) document.documentElement.dataset.preview = 'open';
  else delete document.documentElement.dataset.preview;

  document.cookie = `${PREVIEW_PANE_COOKIE_NAME}=${open ? 'open' : 'closed'};path=/;max-age=31536000;samesite=lax`;
}
