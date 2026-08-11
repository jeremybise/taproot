/**
 * The one place a suggested description is fetched and written into a form.
 *
 * Three controls now do this — the button inside each card on the describe screen, the one on an
 * asset's own page, and the bulk run above the grid — and they are separate islands rather than one
 * component because of where they sit in the DOM. The describe form is server-rendered and works with
 * JavaScript off, so its rows come from Astro; a React component cannot be in two places at once, and
 * rewriting the rows as an island would mean reimplementing the inputs, the Decorative checkboxes and
 * the three-state semantics, with the no-JS path kept as a second copy of all of it.
 *
 * So the islands render **only buttons** and write into the inputs the server already emitted, by id.
 * Assigning `.value` on a server-rendered input is safe precisely because it is not React-controlled:
 * there is no state for the assignment to fight. Remove every island and the screens still work, they
 * just stop offering suggestions — which is also why the buttons are absent rather than inert when the
 * feature is off.
 *
 * What must not be duplicated is *this* — the request, the three-state reconciliation, and the rule
 * about not overwriting somebody's words. That is what this module is.
 */

/** What the caller needs to reach the two inputs belonging to one asset. */
export interface SuggestTarget {
  mediaId: string;
  filename: string;
  /** The alt input's DOM id. Both screens spell it `alt-{mediaId}`; passed rather than assumed. */
  inputId: string;
  /** The Decorative checkbox's id, where the screen has one. */
  decorativeId?: string;
  /** The page the image sits on, when known. Alt text is context-dependent. */
  usedOn?: string | null;
}

export interface SuggestOutcome {
  ok: boolean;
  /** Set when `ok` is false. Already phrased for an editor. */
  error?: string;
}

function field(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null;
}

/** Whether somebody has already written in this box. The bulk run refuses to overwrite one. */
export function hasText(target: SuggestTarget): boolean {
  return !!field(target.inputId)?.value.trim();
}

export async function suggestAltText(target: SuggestTarget): Promise<SuggestOutcome> {
  try {
    const response = await fetch('/api/taproot/ai/alt-text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaId: target.mediaId, usedOn: target.usedOn ?? null }),
    });

    const body = (await response.json().catch(() => null)) as
      | { altText?: string; error?: string }
      | null;

    if (!response.ok || !body?.altText) {
      return {
        ok: false,
        error: body?.error ?? `Could not describe ${target.filename} (${response.status}).`,
      };
    }

    const input = field(target.inputId);
    if (input) {
      input.value = body.altText;

      /*
       * Unticking Decorative, because a description and that mark contradict each other.
       *
       * The server resolves the same conflict in the same direction — typed text wins — so this is the
       * form agreeing with the endpoint rather than deciding anything. Leaving it ticked would show an
       * editor a row reading both "described" and "carries no information".
       */
      if (target.decorativeId) {
        const decorative = field(target.decorativeId);
        if (decorative) decorative.checked = false;
      }

      /*
       * `input` and `change` are dispatched because these inputs are not always plain.
       *
       * On the describe grid they are server-rendered HTML and nothing is listening. On an asset's own
       * page the same markup sits beside a form that may grow a dirty-state guard or an island later,
       * and an assignment to `.value` fires no event on its own — so a listener added afterwards would
       * silently never see the fill. Dispatching costs nothing and removes a trap.
       */
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }
}

/**
 * Whether a bulk run is under way, shared across the islands on one page.
 *
 * A module-scoped flag rather than props or a custom event, and it works because every island on the
 * page is hydrated from this same module instance — so the bulk control and each row button are
 * already looking at one variable. The listener set is what lets React see it change:
 * `useSyncExternalStore` is the supported way to read something outside the tree, and without it the
 * row buttons would refuse to act while still *looking* enabled, which is worse than either.
 *
 * It exists to stop a second request being paid for while the first is in flight. Correctness does not
 * depend on it — the bulk loop skips a row that already has text either way — but each press spends
 * real credit, so a control that cannot be double-fired is worth ten lines.
 */
let bulkRunning = false;
const listeners = new Set<() => void>();

export function isBulkRunning(): boolean {
  return bulkRunning;
}

export function setBulkRunning(value: boolean): void {
  bulkRunning = value;
  for (const listener of listeners) listener();
}

export function subscribeBulk(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
