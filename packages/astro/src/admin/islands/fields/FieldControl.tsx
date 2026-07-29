import { FIELD_TYPE_META, type FieldRow } from '@taproot/core';

/**
 * Renders a single field's input from its definition.
 *
 * Shared deliberately between the content item editor and the content-type builder's live
 * preview. A builder whose preview does not match the real editor is worse than no preview at
 * all, so there is one implementation and the two cannot drift.
 *
 * Phase 1 tranche B replaces the richtext placeholder with TipTap and the media placeholder with
 * a library picker; tranche C does relation. Until then those types render an honest notice rather
 * than a control that pretends to work.
 */

/** One selectable term, flattened out of its tree with the depth it sat at. */
export interface TermOption {
  id: string;
  name: string;
  depth: number;
}

export interface FieldControlProps {
  field: FieldRow;
  value: unknown;
  errors?: string[];
  onChange: (value: unknown) => void;
  /**
   * Selectable terms, keyed by taxonomy id.
   *
   * Resolved on the server and passed in rather than fetched here: the editor page already reads
   * the content type to render at all, so pulling the terms in the same pass avoids a request per
   * taxonomy field on every page load. The content-type builder's preview passes nothing, and the
   * control degrades to an empty picker rather than breaking.
   */
  termsByTaxonomy?: Record<string, TermOption[]>;
  /**
   * Preview mode: inputs are inert and ids are namespaced so a preview rendered next to the real
   * editor cannot collide with it or steal its label associations.
   */
  preview?: boolean;
}

export function FieldControl({
  field,
  value,
  errors,
  onChange,
  termsByTaxonomy,
  preview = false,
}: FieldControlProps) {
  const id = preview ? `preview-field-${field.id}` : `field-${field.id}`;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const config = parseConfig(field.config);
  const required = field.required === 1;

  const describedBy = [field.help_text ? hintId : null, errors?.length ? errorId : null]
    .filter(Boolean)
    .join(' ');

  const shared = {
    id,
    required,
    disabled: preview,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': errors?.length ? (true as const) : undefined,
    className: `mt-1.5 w-full rounded-md border bg-surface px-3 py-2 text-sm ${
      errors?.length ? 'border-danger' : 'border-border-strong'
    } ${preview ? 'cursor-default opacity-90' : ''}`,
  };

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {field.label || <span className="text-content-subtle">Untitled field</span>}
        {required && (
          <span className="ml-1 text-danger" aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="sr-only-focusable"> (required)</span>}
      </label>

      {field.help_text && (
        <p id={hintId} className="mt-0.5 text-xs text-content-subtle">
          {field.help_text}
        </p>
      )}

      {renderControl()}

      {errors?.length ? (
        <p id={errorId} className="mt-1.5 text-sm text-danger">
          {errors.join(' ')}
        </p>
      ) : null}
    </div>
  );

  function renderControl() {
    switch (field.type) {
      case 'text':
        return config.multiline ? (
          <textarea
            {...shared}
            rows={4}
            maxLength={numberOr(config.maxLength, undefined)}
            placeholder={stringOr(config.placeholder, '')}
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
          />
        ) : (
          <input
            {...shared}
            type="text"
            maxLength={numberOr(config.maxLength, undefined)}
            placeholder={stringOr(config.placeholder, '')}
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
          />
        );

      case 'number':
        return (
          <input
            {...shared}
            type="number"
            min={numberOr(config.min, undefined)}
            max={numberOr(config.max, undefined)}
            step={config.integer === true ? 1 : numberOr(config.step, undefined)}
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
        );

      case 'boolean':
        return (
          <div className="mt-1.5 flex items-center gap-2">
            <input
              id={id}
              type="checkbox"
              disabled={preview}
              checked={value === undefined ? config.defaultValue === true : Boolean(value)}
              aria-describedby={describedBy || undefined}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span className="text-sm text-content-muted">Enabled</span>
          </div>
        );

      case 'date':
        return (
          <input
            {...shared}
            type={config.includeTime ? 'datetime-local' : 'date'}
            min={stringOr(config.min, undefined)}
            max={stringOr(config.max, undefined)}
            value={toDateInputValue(value, Boolean(config.includeTime))}
            onChange={(e) =>
              onChange(e.target.value ? new Date(e.target.value).toISOString() : null)
            }
          />
        );

      case 'select': {
        const options = optionsOf(config);

        if (config.multiple === true) {
          // A multi-select listbox is hostile on touch and awkward with a screen reader; a
          // checkbox group is understood everywhere and needs no instructions.
          const selected = Array.isArray(value) ? (value as string[]) : [];
          return (
            <fieldset className="mt-1.5" disabled={preview}>
              <legend className="sr-only-focusable">{field.label}</legend>
              <div className="space-y-1.5 rounded-md border border-border-strong bg-surface px-3 py-2.5">
                {options.length === 0 && (
                  <p className="text-sm text-content-subtle">No options configured yet.</p>
                )}
                {options.map((option) => (
                  <div key={option.value} className="flex items-center gap-2">
                    <input
                      id={`${id}-${option.value}`}
                      type="checkbox"
                      disabled={preview}
                      checked={selected.includes(option.value)}
                      onChange={(e) =>
                        onChange(
                          e.target.checked
                            ? [...selected, option.value]
                            : selected.filter((v) => v !== option.value),
                        )
                      }
                    />
                    <label htmlFor={`${id}-${option.value}`} className="text-sm">
                      {option.label}
                    </label>
                  </div>
                ))}
              </div>
            </fieldset>
          );
        }

        return (
          <select
            {...shared}
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">— None —</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );
      }

      case 'taxonomy': {
        const taxonomyId = stringOr(config.taxonomyId, undefined);
        const options = taxonomyId ? (termsByTaxonomy?.[taxonomyId] ?? []) : [];

        if (!taxonomyId) {
          return (
            <p className="mt-1.5 rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-content-subtle">
              This field is not pointed at a taxonomy yet. Choose one in the content type builder.
            </p>
          );
        }

        if (options.length === 0) {
          return (
            <p className="mt-1.5 rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-content-subtle">
              That taxonomy has no terms yet.
            </p>
          );
        }

        // Depth is shown as an indent rather than folded into the label text, so a screen reader
        // announces the term's own name and nothing else. `multiple` defaults to true for taxonomy
        // fields, matching the field config schema.
        if (config.multiple !== false) {
          const selected = Array.isArray(value) ? (value as string[]) : [];
          return (
            <fieldset className="mt-1.5" disabled={preview}>
              <legend className="sr-only-focusable">{field.label}</legend>
              <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-md border border-border-strong bg-surface px-3 py-2.5">
                {options.map((term) => (
                  <div
                    key={term.id}
                    className="flex items-center gap-2"
                    style={{ marginLeft: `${term.depth * 1.25}rem` }}
                  >
                    <input
                      id={`${id}-${term.id}`}
                      type="checkbox"
                      disabled={preview}
                      checked={selected.includes(term.id)}
                      onChange={(e) =>
                        onChange(
                          e.target.checked
                            ? [...selected, term.id]
                            : selected.filter((entry) => entry !== term.id),
                        )
                      }
                    />
                    <label htmlFor={`${id}-${term.id}`} className="text-sm">
                      {term.name}
                    </label>
                  </div>
                ))}
              </div>
            </fieldset>
          );
        }

        return (
          <select
            {...shared}
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">— None —</option>
            {options.map((term) => (
              <option key={term.id} value={term.id}>
                {`${'— '.repeat(term.depth)}${term.name}`}
              </option>
            ))}
          </select>
        );
      }

      case 'richtext':
        // Tranche B replaces this with TipTap. A textarea stores and round-trips the value
        // correctly meanwhile, so nothing authored now is lost.
        return (
          <textarea
            {...shared}
            rows={8}
            maxLength={numberOr(config.maxLength, undefined)}
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
          />
        );

      default:
        return <PendingControl type={field.type} />;
    }
  }
}

function PendingControl({ type }: { type: FieldRow['type'] }) {
  const meta = FIELD_TYPE_META[type];
  return (
    <p className="mt-1.5 rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-content-subtle">
      The {meta.label.toLowerCase()} editor arrives in Phase {meta.availableIn}. Values already
      stored for this field are kept and are not modified by saving.
    </p>
  );
}

// --- helpers ----------------------------------------------------------------

function parseConfig(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function optionsOf(config: Record<string, unknown>): { label: string; value: string }[] {
  const options = config.options;
  return Array.isArray(options) ? (options as { label: string; value: string }[]) : [];
}

function numberOr(value: unknown, fallback: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function toDateInputValue(value: unknown, includeTime: boolean): string {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return includeTime ? date.toISOString().slice(0, 16) : date.toISOString().slice(0, 10);
}

export default FieldControl;
