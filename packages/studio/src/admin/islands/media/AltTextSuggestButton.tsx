import { useState, useSyncExternalStore } from 'react';

import { AiButton } from '../AiButton.js';
import {
  isBulkRunning,
  subscribeBulk,
  suggestAltText,
  type SuggestTarget,
} from './altTextSuggest.js';

/**
 * Suggest a description for one asset, mounted beside the box it fills.
 *
 * One island per card on the describe grid, and one on an asset's own page. Beside the input rather
 * than in a list underneath it, because a control that fills a specific box should be next to that box
 * — a column of buttons paired to rows by position asks the reader to keep the mapping in their head,
 * and gets it wrong the moment anything wraps.
 *
 * It renders nothing but a button. See `altTextSuggest.ts` for why the form stays server-rendered.
 */

interface Props extends SuggestTarget {
  /**
   * Included in the accessible name where several of these share a screen.
   *
   * Every button on the describe grid reads "Suggest", so without it a screen-reader user gets a list
   * of identical controls. Off on an asset's own page, where there is exactly one and the filename is
   * the heading above it.
   */
  nameRow?: boolean;
  label?: string;
}

export default function AltTextSuggestButton({
  nameRow = false,
  label = 'Suggest',
  ...target
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reading the shared flag the supported way. A plain module variable would not re-render this.
  const bulkRunning = useSyncExternalStore(subscribeBulk, isBulkRunning, () => false);

  async function run() {
    // Guarded as well as disabled: the flag can flip between render and click.
    if (busy || isBulkRunning()) return;
    setBusy(true);
    setError(null);
    const outcome = await suggestAltText(target);
    if (!outcome.ok) setError(outcome.error ?? 'That did not work.');
    setBusy(false);
  }

  return (
    <>
      <AiButton
        size="sm"
        onClick={run}
        busy={busy}
        disabled={bulkRunning}
        srSuffix={nameRow ? `a description for ${target.filename}` : undefined}
      >
        {label}
      </AiButton>

      {/*
        `role="status"` so the outcome is announced: the visible change on success is text appearing in
        an input the user is not focused on, which is otherwise silent, and a failure is only this line.
      */}
      {error && (
        <p role="status" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </>
  );
}
