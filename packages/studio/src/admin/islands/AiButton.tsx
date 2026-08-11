import { IconInline } from '../components/IconInline.js';

/**
 * The one control that calls a model, so every place that does looks the same.
 *
 * Extracted for the reason `StatusBadge` and `Timestamp` are: two screens offer AI suggestions — the
 * bulk describe grid and an item's SEO panel — and presentation duplicated across two files is
 * presentation that drifts. It is also the thing an editor has to *recognise*: the whole point of a
 * marker is that it means the same thing everywhere, which a per-screen approximation cannot promise.
 *
 * ## The mark is reinforcement, never the message
 *
 * Every caller passes a label saying what will happen — "Suggest", "Generate from page content" — so
 * the sparkles and its colour add emphasis to a sentence that already stands alone. That is the rule
 * the status badges follow and the reason they clear WCAG 1.4.1 by construction: strip the colour and
 * the icon and the control still reads correctly. `aria-hidden` on the icon is the other half — it is
 * decoration beside a real label, not a second thing to announce.
 *
 * ## Why it is an outline button and not a solid one
 *
 * Pressing it spends the deployment's API credit and produces a suggestion somebody still has to
 * read. That is precisely not the confident primary action of a screen, and a solid violet button
 * beside a solid accent Save would be two controls competing to look most important. The colour lives
 * in the mark and the border; the surface stays quiet until hover.
 */

interface Props {
  onClick: () => void;
  /** What pressing it does. Required — the marker never carries the meaning on its own. */
  children: React.ReactNode;
  /** Shown in place of `children` while a request is in flight. */
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  /**
   * `sm` for a per-row control in a list, `md` for a section-level one.
   *
   * Two sizes rather than a free `className`, so a caller cannot quietly restyle the marker into
   * something that no longer reads as the same control.
   */
  size?: 'sm' | 'md';
  /** Visually hidden suffix naming the row, where every button on screen shares one label. */
  srSuffix?: string;
}

export function AiButton({
  onClick,
  children,
  busyLabel = 'Generating…',
  busy = false,
  disabled = false,
  size = 'md',
  srSuffix,
}: Props) {
  const sizing = size === 'sm' ? 'gap-1.5 px-2 py-1 text-xs' : 'gap-2 px-3 py-1.5 text-sm';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      /*
       * `border-ai/40` rather than a solid `border-ai`: at full strength a violet outline reads as a
       * validation state on a form, which is the one thing this must not look like.
       *
       * `disabled:opacity-60` matches every other busy control in the admin — the label changing to
       * "Generating…" is what actually reports the state, since opacity alone is not a status.
       */
      className={`inline-flex items-center rounded-md border border-ai/40 bg-surface font-medium text-content transition-colors hover:bg-ai-subtle disabled:opacity-60 ${sizing}`}
    >
      <IconInline
        name="sparkle"
        className={size === 'sm' ? 'h-3.5 w-3.5 text-ai' : 'h-4 w-4 text-ai'}
      />
      {busy ? busyLabel : children}
      {srSuffix && <span className="sr-only-focusable"> {srSuffix}</span>}
    </button>
  );
}

export default AiButton;
