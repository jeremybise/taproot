import { useState } from 'react';

import { AiButton } from '../AiButton.js';
import { hasText, setBulkRunning, suggestAltText, type SuggestTarget } from './altTextSuggest.js';

/**
 * Describe every row nobody has written in yet.
 *
 * Above the grid rather than below it, because it acts on all of them: a control whose scope is the
 * whole list belongs where the list starts, next to the sentence explaining what it will do. Below, it
 * reads as belonging to the last card.
 */

interface Props {
  rows: SuggestTarget[];
}

export default function AltTextSuggestAll({ rows }: Props) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  /**
   * Sequential, not `Promise.all`.
   *
   * Twenty parallel requests is twenty images at a provider that rate-limits, where the first 429 fails
   * most of the batch. One at a time is slower and finishes; it also lets an editor watch the boxes fill
   * and stop reading if the quality is wrong.
   */
  async function run() {
    setRunning(true);
    setBulkRunning(true);
    setProgress(null);

    let filled = 0;
    let failed = 0;

    for (const row of rows) {
      // Re-checked per row rather than filtered up front: a row button may have filled one while this
      // was working, and somebody typing during the run must never be overwritten either.
      if (hasText(row)) continue;

      const outcome = await suggestAltText(row);
      if (outcome.ok) filled += 1;
      else failed += 1;
      setProgress(`Described ${filled} of ${rows.length}…`);
    }

    setRunning(false);
    setBulkRunning(false);

    // Stated plainly at the end, including the nothing-to-do case — a button that appears to do
    // nothing is indistinguishable from one that is broken.
    setProgress(
      filled === 0 && failed === 0
        ? 'Every row already has a description.'
        : failed > 0
          ? `Described ${filled}. ${failed} could not be described.`
          : `Described ${filled}.`,
    );
  }

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center gap-3">
        <AiButton onClick={run} busy={running}>
          Suggest descriptions for empty rows
        </AiButton>
        <p className="text-xs text-content-subtle">
          Fills only the boxes you have left blank. Read each one before saving.
        </p>
      </div>

      {progress && (
        <p role="status" className="mt-2 text-xs text-content-muted">
          {progress}
        </p>
      )}
    </div>
  );
}
