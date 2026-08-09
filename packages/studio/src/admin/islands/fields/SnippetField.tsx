import type { ResolvedSnippet } from '@taprootcms/core';

/**
 * Choose a reusable text snippet.
 *
 * The structured half of the snippet feature. A `{{ token }}` is right when the value goes *inside a
 * sentence*; this is right when the value **is** the field — a chart's data point, a figure in a
 * stat block — where the consumer wants `4500` rather than the sentence "$4,500" it would otherwise
 * have to parse back.
 *
 * ## A `<select>`, not a searchable picker
 *
 * `ItemPicker` exists because a site holds hundreds of pages and a `<select>` past a few hundred
 * options is unusable. A snippet library is *tens* of rows — a value worth defining once is a value
 * somebody deliberately decided to share — so the searchable control would be machinery bought for a
 * problem this list does not have, and a native select is fully keyboard- and screen-reader-complete
 * with no code at all. If a deployment ever reaches the point where this is uncomfortable, the fix is
 * `ItemPicker`'s pattern, and that is a known road.
 *
 * The option label carries the rendered value as well as the name, because "Current tuition" alone
 * does not answer the question an editor has when picking one, which is *what will this put on the
 * page*.
 */

export interface SnippetOption extends ResolvedSnippet {
  apiId: string;
  name: string;
}

interface Props {
  id: string;
  value: string;
  onChange: (apiId: string) => void;
  snippets: SnippetOption[];
  /**
   * Kinds this field accepts. Empty means any — matching `media.accept` and `link.allowedKinds`,
   * and deliberately unlike `embed.allowedHosts`, where empty admits nothing.
   */
  allowedKinds?: string[];
  describedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
}

export function SnippetField({
  id,
  value,
  onChange,
  snippets,
  allowedKinds = [],
  describedBy,
  invalid = false,
  disabled = false,
}: Props) {
  const offered =
    allowedKinds.length === 0
      ? snippets
      : snippets.filter((snippet) => allowedKinds.includes(snippet.kind));

  /*
   * A stored value whose snippet is gone, or is excluded by this field's kinds, still appears.
   *
   * Dropping it would make the control render as "nothing chosen" while the item in fact holds a
   * reference — so an untouched save would silently rewrite the field. Same rule the parent picker
   * follows for an id outside its first page.
   */
  const missing = value && !offered.some((snippet) => snippet.apiId === value);

  if (snippets.length === 0) {
    return (
      <p
        id={id}
        className="mt-1.5 rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-content-subtle"
      >
        No text snippets exist yet. Create one under Library → Text snippets and it becomes
        selectable here.
      </p>
    );
  }

  return (
    <div className="mt-1.5">
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full rounded-md border bg-surface px-3 py-2 text-sm ${
          invalid ? 'border-danger' : 'border-border-strong'
        }`}
      >
        <option value="">— None —</option>
        {missing && (
          // Named as unavailable rather than shown as a bare id, so the reason is on screen.
          <option value={value}>{value} — no longer available</option>
        )}
        {offered.map((snippet) => (
          <option key={snippet.apiId} value={snippet.apiId}>
            {snippet.name} — {snippet.display}
          </option>
        ))}
      </select>

      {offered.length === 0 && !missing && (
        <p className="mt-1.5 text-xs text-content-subtle">
          No snippets match the kinds this field accepts.
        </p>
      )}
    </div>
  );
}

export default SnippetField;
