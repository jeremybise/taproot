import { useId, useRef, useState } from 'react';
import {
  FIELD_TYPE_META,
  FIELD_TYPES,
  type FieldRow,
  type FieldType,
} from '@taproot/core';

/**
 * Field management for a content type.
 *
 * Phase 0 deliberately keeps this a plain list with add/edit/remove and keyboard-driven
 * reordering. Phase 1 turns it into the full visual builder (live preview, per-type option forms,
 * drag-and-drop) — the API it talks to is already the right shape for that.
 *
 * Reordering is buttons rather than drag-and-drop on purpose: a drag-only interaction is
 * unusable by keyboard and is exactly the hand-built pattern that fails WCAG 2.1 SC 2.1.1.
 * When drag-and-drop arrives in Phase 1 it must be an *addition* to these controls, not a
 * replacement.
 */

interface Props {
  contentTypeId: string;
  initialFields: FieldRow[];
}

interface DraftField {
  api_id: string;
  label: string;
  type: FieldType;
  required: boolean;
  help_text: string;
  /** Newline-separated options for select fields. */
  options: string;
}

const emptyDraft: DraftField = {
  api_id: '',
  label: '',
  type: 'text',
  required: false,
  help_text: '',
  options: '',
};

export default function FieldBuilder({ contentTypeId, initialFields }: Props) {
  const [fields, setFields] = useState<FieldRow[]>(initialFields);
  const [draft, setDraft] = useState<DraftField>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const formId = useId();
  const labelRef = useRef<HTMLInputElement>(null);

  async function request(url: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        (body as { error?: string } | null)?.error ?? `Request failed (${response.status}).`;
      throw new Error(message);
    }
    return body;
  }

  async function addField(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const config: Record<string, unknown> = {};
      if (draft.type === 'select') {
        const options = draft.options
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [label, value] = line.split('|').map((part) => part.trim());
            return { label: label!, value: value || slugToValue(label!) };
          });
        if (options.length === 0) {
          throw new Error('A select field needs at least one option.');
        }
        config.options = options;
      }

      const body = (await request(`/api/taproot/content-types/${contentTypeId}/fields`, {
        method: 'POST',
        body: JSON.stringify({
          api_id: draft.api_id.trim() || toApiId(draft.label),
          label: draft.label.trim(),
          type: draft.type,
          required: draft.required,
          localized: false,
          position: fields.length,
          help_text: draft.help_text.trim() || null,
          config,
        }),
      })) as { field: FieldRow };

      setFields((current) => [...current, body.field]);
      setDraft(emptyDraft);
      setStatus(`Added the ${body.field.label} field.`);
      labelRef.current?.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add the field.');
    } finally {
      setBusy(false);
    }
  }

  async function removeField(field: FieldRow) {
    if (!confirm(`Delete the "${field.label}" field? Values stored for it will stop being shown.`)) {
      return;
    }

    setError(null);
    try {
      await request(`/api/taproot/fields/${field.id}`, { method: 'DELETE' });
      setFields((current) => current.filter((f) => f.id !== field.id));
      setStatus(`Removed the ${field.label} field.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove the field.');
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;

    const reordered = [...fields];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved!);
    setFields(reordered);
    setStatus(`Moved ${moved!.label} to position ${target + 1} of ${reordered.length}.`);

    try {
      await request(`/api/taproot/content-types/${contentTypeId}/fields`, {
        method: 'PATCH',
        body: JSON.stringify({ fieldIds: reordered.map((f) => f.id) }),
      });
    } catch (cause) {
      setFields(fields); // Put it back if the save failed.
      setError(cause instanceof Error ? cause.message : 'Could not save the new order.');
    }
  }

  return (
    <div className="space-y-8">
      {/* Announcements for actions that only change part of the page. */}
      <p role="status" aria-live="polite" className="sr-only-focusable">
        {status}
      </p>

      <div role="alert" aria-live="assertive">
        {error && (
          <p className="rounded-md border border-danger bg-danger-subtle px-4 py-3 text-sm">
            {error}
          </p>
        )}
      </div>

      <section aria-labelledby={`${formId}-existing`}>
        <h2 id={`${formId}-existing`} className="mb-3 text-base font-semibold">
          Fields
        </h2>

        {fields.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-content-muted">
            No fields yet. Add one below.
          </p>
        ) : (
          <ol className="space-y-2">
            {fields.map((field, index) => (
              <li
                key={field.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{field.label}</span>
                    <code className="font-mono text-xs text-content-subtle">{field.api_id}</code>
                    {field.required === 1 && (
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs">
                        Required
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm text-content-muted">
                    {FIELD_TYPE_META[field.type].label}
                    {FIELD_TYPE_META[field.type].availableIn > 0 && (
                      <span className="text-content-subtle">
                        {' '}
                        · editor arrives in Phase {FIELD_TYPE_META[field.type].availableIn}
                      </span>
                    )}
                  </p>
                </div>

                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    className="rounded-md border border-border-strong px-2.5 py-1.5 text-sm disabled:opacity-40"
                  >
                    <span aria-hidden="true">↑</span>
                    <span className="sr-only-focusable">
                      Move {field.label} up (currently {index + 1} of {fields.length})
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === fields.length - 1}
                    className="rounded-md border border-border-strong px-2.5 py-1.5 text-sm disabled:opacity-40"
                  >
                    <span aria-hidden="true">↓</span>
                    <span className="sr-only-focusable">
                      Move {field.label} down (currently {index + 1} of {fields.length})
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeField(field)}
                    className="rounded-md border border-border-strong px-2.5 py-1.5 text-sm text-danger hover:bg-danger-subtle"
                  >
                    Remove<span className="sr-only-focusable"> the {field.label} field</span>
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby={`${formId}-add`}>
        <h2 id={`${formId}-add`} className="mb-3 text-base font-semibold">
          Add a field
        </h2>

        <form onSubmit={addField} className="space-y-4 rounded-lg border border-border bg-surface-raised p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${formId}-label`} className="block text-sm font-medium">
                Label
              </label>
              <input
                id={`${formId}-label`}
                ref={labelRef}
                required
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label htmlFor={`${formId}-type`} className="block text-sm font-medium">
                Type
              </label>
              <select
                id={`${formId}-type`}
                value={draft.type}
                onChange={(e) => setDraft({ ...draft, type: e.target.value as FieldType })}
                className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
              >
                {FIELD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {FIELD_TYPE_META[type].label}
                    {FIELD_TYPE_META[type].availableIn > 0
                      ? ` (Phase ${FIELD_TYPE_META[type].availableIn})`
                      : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-content-subtle">
                {FIELD_TYPE_META[draft.type].description}
              </p>
            </div>
          </div>

          <div>
            <label htmlFor={`${formId}-api`} className="block text-sm font-medium">
              API id <span className="font-normal text-content-subtle">(optional)</span>
            </label>
            <input
              id={`${formId}-api`}
              value={draft.api_id}
              onChange={(e) => setDraft({ ...draft, api_id: e.target.value })}
              placeholder={toApiId(draft.label) || 'derived_from_label'}
              pattern="[a-z][a-z0-9_]*"
              className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-sm"
            />
          </div>

          {draft.type === 'select' && (
            <div>
              <label htmlFor={`${formId}-options`} className="block text-sm font-medium">
                Options
              </label>
              <p id={`${formId}-options-hint`} className="mt-0.5 text-xs text-content-subtle">
                One per line. Use <code className="font-mono">Label|value</code> to set the stored
                value explicitly.
              </p>
              <textarea
                id={`${formId}-options`}
                rows={4}
                required
                value={draft.options}
                onChange={(e) => setDraft({ ...draft, options: e.target.value })}
                aria-describedby={`${formId}-options-hint`}
                className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-sm"
              />
            </div>
          )}

          <div>
            <label htmlFor={`${formId}-help`} className="block text-sm font-medium">
              Help text <span className="font-normal text-content-subtle">(optional)</span>
            </label>
            <input
              id={`${formId}-help`}
              value={draft.help_text}
              onChange={(e) => setDraft({ ...draft, help_text: e.target.value })}
              className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id={`${formId}-required`}
              type="checkbox"
              checked={draft.required}
              onChange={(e) => setDraft({ ...draft, required: e.target.checked })}
            />
            <label htmlFor={`${formId}-required`} className="text-sm">
              Required
            </label>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? 'Adding…' : 'Add field'}
          </button>
        </form>
      </section>
    </div>
  );
}

function toApiId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f$1');
}

function slugToValue(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
