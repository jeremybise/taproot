import { useState } from 'react';

import { AiButton } from '../AiButton.js';

/**
 * Generate buttons for the bulk describe grid.
 *
 * ## Why this fills existing inputs instead of rendering them
 *
 * The describe form is server-rendered and works with JavaScript off — that is the property the
 * whole admin is built for, and 5E's grid is a plain `<form method="post">` because of it. Rendering
 * the rows from React would mean reimplementing the inputs, the decorative checkboxes, the labels and
 * the three-state semantics inside an island, and the no-JS path would then have to be a second copy
 * of all of it.
 *
 * So this component renders **only the buttons** and writes into the inputs the server already
 * emitted, by id. Assigning `.value` on a server-rendered input is safe precisely because it is not
 * React-controlled — there is no state for the assignment to fight. It is a progressive enhancement
 * in the strict sense: remove the island and the screen still works, it just stops offering
 * suggestions.
 *
 * ## Nothing here saves
 *
 * The button fills a box. The editor reads it, edits it, or clears it, and **Save descriptions** is
 * still the only thing that writes — which is what keeps a machine from ever marking an image
 * decorative, the one claim no generator can make.
 */

export interface SuggestRow {
  id: string;
  filename: string;
}

interface Props {
  rows: SuggestRow[];
  /** The page these images sit on, when the caller knows it. Alt text is context-dependent. */
  usedOn?: string | null;
}

type RowState = 'idle' | 'working' | 'done' | 'error';

export default function AltTextSuggest({ rows, usedOn = null }: Props) {
  const [state, setState] = useState<Record<string, RowState>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);

  function input(id: string): HTMLInputElement | null {
    return document.getElementById(`alt-${id}`) as HTMLInputElement | null;
  }

  async function suggest(row: SuggestRow): Promise<boolean> {
    setState((prev) => ({ ...prev, [row.id]: 'working' }));
    try {
      const response = await fetch('/api/taproot/ai/alt-text', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaId: row.id, usedOn }),
      });
      const body = (await response.json().catch(() => null)) as
        | { altText?: string; error?: string }
        | null;

      if (!response.ok || !body?.altText) {
        setState((prev) => ({ ...prev, [row.id]: 'error' }));
        setMessage(body?.error ?? `Could not describe ${row.filename} (${response.status}).`);
        return false;
      }

      const field = input(row.id);
      if (field) {
        field.value = body.altText;
        /*
         * Unticking Decorative, because a description and that mark contradict each other.
         *
         * The server resolves the conflict in the same direction — typed text wins — so this is the
         * form agreeing with the endpoint rather than deciding anything. Leaving it ticked would show
         * an editor a row that reads both "described" and "carries no information".
         */
        const decorative = document.getElementById(`decorative-${row.id}`) as HTMLInputElement | null;
        if (decorative) decorative.checked = false;
      }

      setState((prev) => ({ ...prev, [row.id]: 'done' }));
      return true;
    } catch {
      setState((prev) => ({ ...prev, [row.id]: 'error' }));
      setMessage('Could not reach the server.');
      return false;
    }
  }

  /**
   * Sequential, not `Promise.all`.
   *
   * Twenty parallel requests is twenty images uploaded at once to a provider that rate-limits, and
   * the first 429 would fail most of the batch. One at a time is slower and finishes; it also lets an
   * editor watch the boxes fill and stop reading if the quality is wrong.
   */
  async function suggestAll() {
    setRunningAll(true);
    setMessage(null);
    let failed = 0;
    for (const row of rows) {
      // Never overwrite something a person has already written.
      if (input(row.id)?.value.trim()) continue;
      if (!(await suggest(row))) failed += 1;
    }
    setRunningAll(false);
    if (failed > 0) setMessage(`${failed} of ${rows.length} could not be described.`);
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <AiButton onClick={suggestAll} busy={runningAll}>
          Suggest descriptions for empty rows
        </AiButton>
        <p className="text-xs text-content-subtle">
          Fills only the boxes you have left blank. Read each one before saving.
        </p>
      </div>

      {/*
        `role="status"` so a screen reader hears the outcome — the visible change is text appearing in
        an input the user is not focused on, which is otherwise silent.
      */}
      {message && (
        <p role="status" className="mt-2 text-xs text-danger">
          {message}
        </p>
      )}

      <ul className="mt-3 space-y-1">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2 text-xs">
            {/* The filename rides in `srSuffix`: every row's button reads "Suggest", so without it a
                screen-reader user gets a list of identical controls. */}
            <AiButton
              size="sm"
              onClick={() => suggest(row)}
              busy={state[row.id] === 'working'}
              disabled={runningAll}
              srSuffix={`a description for ${row.filename}`}
            >
              Suggest
            </AiButton>
            <span className="min-w-0 truncate text-content-subtle" title={row.filename}>
              {row.filename}
            </span>
            {state[row.id] === 'done' && <span className="text-success-strong">filled</span>}
            {state[row.id] === 'error' && <span className="text-danger">failed</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
