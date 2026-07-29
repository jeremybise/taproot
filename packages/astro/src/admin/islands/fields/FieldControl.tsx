import { FIELD_TYPE_META, type BlockInstance, type FieldRow } from '@taproot/core';

import { BlockListEditor, type BlockTypeOption } from './BlockListEditor.js';
import { RichTextEditor } from './RichTextEditor.js';

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
   * Block types with their fields, for `block` fields. Resolved on the server for the same reason
   * terms are: the editor page already reads the content type, so the block schemas ride along
   * rather than costing a request per block field.
   */
  blockTypes?: BlockTypeOption[];
  /** Media assets selectable by a `media` field, resolved server-side with their public URLs. */
  media?: { id: string; filename: string; url: string }[];
  /**
   * Preview mode: inputs are inert and ids are namespaced so a preview rendered next to the real
   * editor cannot collide with it or steal its label associations.
   */
  preview?: boolean;
  /**
   * Extra id namespace, for the same field definition rendered more than once on a page.
   *
   * Two blocks of the same type render the *same* `FieldRow`, so without this both of their inputs
   * would get `id="field-<row id>"` — duplicate ids, and a label that focuses the first block's
   * input no matter which one was clicked. The block editor passes the block instance's id.
   */
  idPrefix?: string;
}

export function FieldControl({
  field,
  value,
  errors,
  onChange,
  termsByTaxonomy,
  blockTypes,
  media,
  preview = false,
  idPrefix,
}: FieldControlProps) {
  const id = [preview ? 'preview' : 'field', idPrefix, field.id].filter(Boolean).join('-');
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  // Needed by controls that cannot be the target of a `<label for>` — see the richtext case.
  const labelId = `${id}-label`;
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
      <label id={labelId} htmlFor={id} className="block text-sm font-medium">
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
        /**
         * The label is associated with `aria-labelledby` rather than `htmlFor`.
         *
         * A `<label for>` only binds to a labelable element, and the editable region is a
         * `contenteditable` div — so the outer label's `htmlFor` points at an id that exists but
         * cannot claim it. Naming the region explicitly is what makes a screen reader announce
         * which field it is in.
         */
        return (
          <RichTextEditor
            id={id}
            value={(value as string) ?? ''}
            onChange={(html) => onChange(html || null)}
            labelledBy={labelId}
            describedBy={describedBy || undefined}
            invalid={Boolean(errors?.length)}
            allowedTags={stringArrayOr(config.allowedFormats, undefined)}
            disabled={preview}
          />
        );

      case 'media': {
        /**
         * A select of the library rather than a browsing modal.
         *
         * The full picker — a grid with search and upload in place — is a real piece of work, and
         * shipping a second bespoke one here would mean two to replace. The SEO panel uses the
         * same shape for the same reason, and both move together when the picker lands.
         *
         * Multiple selection is not offered yet, so a field configured for it edits only its first
         * value; that is stated rather than silently discarding the rest.
         */
        const selected = Array.isArray(value) ? ((value as string[])[0] ?? '') : ((value as string) ?? '');
        const multiple = config.multiple === true;

        return (
          <>
            <select
              {...shared}
              value={selected}
              onChange={(e) => {
                const next = e.target.value || null;
                onChange(multiple ? (next ? [next] : []) : next);
              }}
            >
              <option value="">— None —</option>
              {(media ?? []).map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.filename}
                </option>
              ))}
            </select>
            {media && media.length === 0 && (
              <p className="mt-1 text-xs text-content-subtle">
                No images in the library yet. Upload one under Media.
              </p>
            )}
            {multiple && (
              <p className="mt-1 text-xs text-content-subtle">
                This field allows several files, but only one can be chosen until the media picker
                arrives.
              </p>
            )}
          </>
        );
      }

      case 'block': {
        const allowed = stringArrayOr(config.allowedBlocks, []) ?? [];
        const available = (blockTypes ?? []).filter(
          // An empty allow-list means "any block type", matching the field config's default and
          // what the server validates against.
          (blockType) => allowed.length === 0 || allowed.includes(blockType.api_id),
        );

        return (
          <BlockListEditor
            value={Array.isArray(value) ? (value as BlockInstance[]) : []}
            onChange={(blocks) => onChange(blocks)}
            blockTypes={available}
            maxBlocks={numberOr(config.maxBlocks, undefined)}
            termsByTaxonomy={termsByTaxonomy}
            media={media}
            labelledBy={labelId}
            disabled={preview}
          />
        );
      }

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

function stringArrayOr(value: unknown, fallback: string[] | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : fallback;
}

function toDateInputValue(value: unknown, includeTime: boolean): string {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return includeTime ? date.toISOString().slice(0, 16) : date.toISOString().slice(0, 10);
}

export default FieldControl;
