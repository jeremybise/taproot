import { useState } from 'react';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { newId, repeaterRowFields, type FieldRow, type RepeaterRow } from '@taprootcms/core';

import { FieldControl, type TermOption } from './FieldControl.js';
import type { MediaOption } from '../../mediaOptions.js';
import type { RelationTarget } from '../../relationOptions.js';

/**
 * The editor for a `repeater` field: several rows of the same small shape.
 *
 * Opening hours, a staff list, a set of FAQs — things that repeat and are not big enough to be
 * content items of their own. The last field type to get an editing control.
 *
 * Each row's inputs come from `FieldControl`, the same component the item editor and the block
 * editor use, because the sub-fields are synthesised into ordinary `FieldRow`s by
 * `repeaterRowFields`. That is what gets a repeater richtext sanitising, media picking, and
 * relation lookups without this file knowing any of those exist.
 *
 * Reordering is by button, following the field builder and the block editor: order is usually the
 * point of a repeater, and the buttons are the primary keyboard path rather than a fallback.
 */

interface Props {
  /** Placed on the group, so the field's `<label for>` has a target that exists. */
  id?: string;
  labelledBy?: string;
  describedBy?: string;
  field: FieldRow;
  value: RepeaterRow[];
  onChange: (rows: RepeaterRow[]) => void;
  termsByTaxonomy?: Record<string, TermOption[]>;
  relationTargets?: Record<string, RelationTarget>;
  media?: MediaOption[];
  minItems?: number;
  maxItems?: number;
  disabled?: boolean;
  invalid?: boolean;
}

export function RepeaterField({
  id,
  labelledBy,
  describedBy,
  field,
  value,
  onChange,
  termsByTaxonomy,
  relationTargets,
  media,
  minItems = 0,
  maxItems,
  disabled = false,
  invalid = false,
}: Props) {
  const [status, setStatus] = useState('');

  const subFields = repeaterRowFields(field);
  const atLimit = maxItems !== undefined && value.length >= maxItems;

  /**
   * A repeater whose shape has not been designed yet.
   *
   * Rendering an "Add entry" button here would produce rows with nowhere to type, which reads as a
   * broken control rather than an unfinished definition — and the fix is on a different screen.
   */
  if (subFields.length === 0) {
    return (
      <p
        id={id}
        className="mt-1.5 rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-content-subtle"
      >
        This repeater has no fields yet. Add some to its configuration in Settings → Content types,
        and each entry gets those inputs here.
      </p>
    );
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onChange(next);
    setStatus(`Entry moved to position ${to + 1} of ${next.length}.`);
  }

  function add() {
    /**
     * Seeded with each sub-field's `defaultValue`, not an empty object.
     *
     * A row added as `{}` fails validation the moment any sub-field is required, so the editor
     * would show an error for something nobody has touched yet. Same reasoning as the block editor.
     */
    const data: Record<string, unknown> = {};
    for (const sub of subFields) {
      const config = safeParse(sub.config);
      if (config.defaultValue !== undefined) data[sub.api_id] = config.defaultValue;
    }

    onChange([...value, { id: newId(), data }]);
    setStatus(`Entry added at position ${value.length + 1}.`);
  }

  return (
    <div
      id={id}
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`mt-1.5 rounded-md border px-3 py-3 ${
        invalid ? 'border-danger' : 'border-border-strong'
      } ${disabled ? 'opacity-90' : ''}`}
    >
      {value.length === 0 ? (
        <p className="text-sm text-content-subtle">
          No entries yet.
          {minItems > 0 && ` At least ${minItems} ${minItems === 1 ? 'is' : 'are'} required.`}
        </p>
      ) : (
        <ol className="space-y-3">
          {value.map((row, index) => (
            <li key={row.id} className="rounded-lg border border-border bg-surface-raised p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                {/*
                  The position is the row's only name. Without it every control in every row would
                  announce identically, and a screen reader's list of form fields would be a wall of
                  the same three labels repeated.
                */}
                <span className="text-xs font-medium text-content-subtle">
                  Entry {index + 1} of {value.length}
                </span>

                {!disabled && (
                  <div className="flex gap-1">
                    <IconButton
                      label={`Move entry ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => move(index, index - 1)}
                    >
                      <ChevronUp className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={`Move entry ${index + 1} down`}
                      disabled={index === value.length - 1}
                      onClick={() => move(index, index + 1)}
                    >
                      <ChevronDown className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={`Remove entry ${index + 1}`}
                      onClick={() => {
                        onChange(value.filter((_, position) => position !== index));
                        setStatus(`Entry ${index + 1} removed.`);
                      }}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                {subFields.map((sub) => (
                  <FieldControl
                    key={sub.id}
                    field={sub}
                    value={row.data[sub.api_id]}
                    termsByTaxonomy={termsByTaxonomy}
                    relationTargets={relationTargets}
                    media={media}
                    preview={disabled}
                    /*
                      Every row renders the same sub-field definitions, so without this each row's
                      inputs would share a DOM id with the row above and a label would focus the
                      wrong one. The row's own id is what separates them — the same fix the block
                      editor needed for two blocks of one type.
                    */
                    idPrefix={row.id}
                    onChange={(fieldValue) =>
                      onChange(
                        value.map((candidate, position) =>
                          position === index
                            ? { ...candidate, data: { ...candidate.data, [sub.api_id]: fieldValue } }
                            : candidate,
                        ),
                      )
                    }
                  />
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}

      {!disabled && (
        <div className="mt-3">
          {atLimit ? (
            <p className="text-xs text-content-subtle">
              This field holds at most {maxItems} {maxItems === 1 ? 'entry' : 'entries'}.
            </p>
          ) : (
            <button
              type="button"
              onClick={add}
              className="rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-sunken"
            >
              + Add entry
            </button>
          )}
        </div>
      )}

      {/* Adding, removing, and reordering all change a list that is otherwise only visible. */}
      <p aria-live="polite" className="sr-only-focusable">
        {status}
      </p>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded-md border border-border p-1.5 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

export default RepeaterField;
