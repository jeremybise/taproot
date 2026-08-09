import { useCallback, useRef, useState } from 'react';
import { Library, Plus } from 'lucide-react';

import { useDismissable } from '../useDismissable.js';
import type { BlockTypeOption, ReusableBlockOption } from './BlockListEditor.js';

/**
 * Choosing what to add to a composed region.
 *
 * This replaced one button per block type laid out in a wrapping row. **That reasoning was right and
 * has expired**, and it is worth recording rather than deleting: the old comment argued that adding
 * a block is the most common action here, so a picker "makes it two interactions and a decision
 * about which control commits it". True with three block types. At fifteen it is a wall of buttons
 * an editor reads every time to find the one they want, and the library entries sat below it in
 * accent-bordered chips that out-shouted the block types themselves — the loudest thing on the
 * screen being the option that puts *shared* content on the page, which is the one worth a moment's
 * thought.
 *
 * So: one "Add a block" button opening a panel that is searchable, with the library as a second,
 * quieter section rather than a louder one.
 *
 * ## A disclosure, not a dialog
 *
 * `scripts/a11y-audit.mjs` runs with `runScripts: 'outside-only'`, so it only ever sees an island's
 * server-rendered markup — a Radix dialog portalled to `document.body` after hydration is invisible
 * to it, and this panel holds a search box and every block type's name. Keeping it a plain
 * disclosure inside the island's own tree means the whole thing stays in the DOM the audit reads,
 * and it implements the four points `useDismissable.ts` documents rather than inventing a fifth
 * behaviour.
 *
 * Filtering is local: every block type is already in props, so a search here is a substring match
 * rather than a request.
 */

interface Props {
  idPrefix: string;
  blockTypes: BlockTypeOption[];
  reusableBlocks: ReusableBlockOption[];
  onAdd: (apiId: string) => void;
  onAddReference: (entry: ReusableBlockOption) => void;
}

export function AddBlockPanel({
  idPrefix,
  blockTypes,
  reusableBlocks,
  onAdd,
  onAddReference,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useDismissable(container, open, close);

  const term = query.trim().toLowerCase();
  const matches = (text: string) => text.toLowerCase().includes(term);

  const types = term ? blockTypes.filter((t) => matches(t.name) || matches(t.api_id)) : blockTypes;
  const entries = term ? reusableBlocks.filter((e) => matches(e.name)) : reusableBlocks;

  const panelId = `${idPrefix}-add-panel`;
  const searchId = `${idPrefix}-add-search`;

  /** Closing after adding, because the common case is placing one block and going back to editing. */
  function choose(run: () => void) {
    run();
    setQuery('');
    setOpen(false);
  }

  return (
    <div ref={container} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-sunken"
      >
        <Plus aria-hidden="true" size={14} />
        Add a block
      </button>

      {open && (
        <div
          id={panelId}
          className="absolute left-0 z-30 mt-1 w-full min-w-0 max-w-md rounded-lg border border-border bg-surface-raised p-2 shadow-lg"
        >
          {/* Only once the list is long enough to be worth filtering — a search box over four
              entries is a control that costs more attention than it saves. */}
          {blockTypes.length + reusableBlocks.length > 6 && (
            <>
              <label htmlFor={searchId} className="sr-only-focusable">
                Search block types
              </label>
              <input
                id={searchId}
                type="search"
                value={query}
                autoFocus
                placeholder="Search blocks"
                onChange={(event) => setQuery(event.target.value)}
                className="mb-2 w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm"
              />
            </>
          )}

          <p
            id={`${idPrefix}-types-heading`}
            className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-content-subtle"
          >
            Block types
          </p>
          <ul aria-labelledby={`${idPrefix}-types-heading`} className="max-h-56 overflow-y-auto">
            {types.length === 0 ? (
              <li className="px-2 py-2 text-xs text-content-subtle">No block types match that.</li>
            ) : (
              types.map((blockType) => (
                <li key={blockType.id}>
                  <button
                    type="button"
                    onClick={() => choose(() => onAdd(blockType.api_id))}
                    className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-sunken"
                  >
                    <span className="block truncate text-sm font-medium">{blockType.name}</span>
                    {blockType.description && (
                      <span className="block truncate text-xs text-content-subtle">
                        {blockType.description}
                      </span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>

          {reusableBlocks.length > 0 && (
            <>
              <p
                id={`${idPrefix}-library-heading`}
                className="mt-2 border-t border-border px-1 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-content-subtle"
              >
                From the library
              </p>
              {/*
                Quieter than the block types above, not louder. Placing one of these puts shared
                content on the page and editing it later changes every other page using it — a
                decision worth a moment, which accent-bordered chips at the top of the list were
                actively working against.
              */}
              <ul
                aria-labelledby={`${idPrefix}-library-heading`}
                className="max-h-40 overflow-y-auto"
              >
                {entries.length === 0 ? (
                  <li className="px-2 py-2 text-xs text-content-subtle">
                    No library entries match that.
                  </li>
                ) : (
                  entries.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => choose(() => onAddReference(entry))}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-sunken"
                      >
                        <Library aria-hidden="true" size={14} className="shrink-0 text-content-muted" />
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        <span className="shrink-0 text-xs text-content-subtle">shared</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default AddBlockPanel;
