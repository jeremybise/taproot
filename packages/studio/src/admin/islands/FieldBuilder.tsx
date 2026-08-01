import { useEffect, useRef, useState } from 'react';
import {
  FIELD_TYPE_META,
  type ContentTypeRow,
  type FieldRow,
  type FieldType,
  type TaxonomyRow,
} from '@taprootcms/core';

import { FieldConfigForm } from './fields/FieldConfigForm.js';
import { FieldTypePicker } from './fields/FieldTypePicker.js';
import { SortableFieldList } from './fields/SortableFieldList.js';

/**
 * The visual content-type builder.
 *
 * Two panes: the field list on the left, and an editor on the right for whichever field is
 * selected (or a new one), showing that type's own options form.
 *
 * There was briefly a third pane previewing the field control itself. It was dropped — it ate
 * horizontal space the options forms needed, and previewing a lone input is not what "preview"
 * usefully means here. Previewing the *rendered page* is, and that lives on the content item
 * editor where the page actually exists.
 */

interface Props {
  contentTypeId: string;
  initialFields: FieldRow[];
  /** All content types, for the relation field's target picker. */
  contentTypes: ContentTypeRow[];
  /** All taxonomies, for the taxonomy field's source picker. */
  taxonomies: TaxonomyRow[];
  /** All block types, for the block field's allowed-blocks picker. */
  blockTypes?: ContentTypeRow[];
  /** Item counts per field api_id that are currently empty, for the "required" warning. */
  itemCount: number;
}

/** A field being edited or created. `id` is absent until it has been saved. */
interface Draft {
  id?: string;
  api_id: string;
  label: string;
  type: FieldType;
  help_text: string;
  required: boolean;
  config: Record<string, unknown>;
}

const NEW_DRAFT: Draft = {
  api_id: '',
  label: '',
  type: 'text',
  help_text: '',
  required: false,
  config: {},
};

export default function FieldBuilder({
  contentTypeId,
  initialFields,
  contentTypes,
  taxonomies,
  blockTypes = [],
  itemCount,
}: Props) {
  const [fields, setFields] = useState<FieldRow[]>(initialFields);
  const [draft, setDraft] = useState<Draft>(NEW_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);
  const shouldFocusEditor = useRef(false);

  // Selecting a field swaps the whole right-hand pane, which a screen reader would otherwise not
  // notice. Moving focus to its heading announces the change and puts the user at the top of it.
  useEffect(() => {
    if (shouldFocusEditor.current) {
      editorHeadingRef.current?.focus();
      shouldFocusEditor.current = false;
    }
  }, [draft.id]);

  async function request(url: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const payload = body as { error?: string; fields?: Record<string, string[]> } | null;
      const detail = payload?.fields
        ? Object.entries(payload.fields)
            .map(([key, messages]) => `${key}: ${messages.join(', ')}`)
            .join('; ')
        : null;
      throw new Error(detail ?? payload?.error ?? `Request failed (${response.status}).`);
    }
    return body;
  }

  function selectField(field: FieldRow) {
    shouldFocusEditor.current = true;
    setError(null);
    setDraft({
      id: field.id,
      api_id: field.api_id,
      label: field.label,
      type: field.type,
      help_text: field.help_text ?? '',
      required: field.required === 1,
      config: safeParse(field.config),
    });
  }

  function startNewField() {
    shouldFocusEditor.current = true;
    setError(null);
    setDraft(NEW_DRAFT);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      if (draft.id) {
        // api_id and type are fixed after creation — the API rejects them, so they are not sent.
        const body = (await request(`/api/taproot/fields/${draft.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            label: draft.label.trim(),
            help_text: draft.help_text.trim() || null,
            required: draft.required,
            localized: false,
            config: draft.config,
          }),
        })) as { field: FieldRow };

        setFields((current) => current.map((f) => (f.id === body.field.id ? body.field : f)));
        setStatus(`Saved the ${body.field.label} field.`);
      } else {
        const body = (await request(`/api/taproot/content-types/${contentTypeId}/fields`, {
          method: 'POST',
          body: JSON.stringify({
            api_id: draft.api_id.trim() || toApiId(draft.label),
            label: draft.label.trim(),
            type: draft.type,
            help_text: draft.help_text.trim() || null,
            required: draft.required,
            localized: false,
            position: fields.length,
            config: draft.config,
          }),
        })) as { field: FieldRow };

        setFields((current) => [...current, body.field]);
        setStatus(`Added the ${body.field.label} field.`);
        setDraft(NEW_DRAFT);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the field.');
    } finally {
      setBusy(false);
    }
  }

  async function removeField(field: FieldRow) {
    if (
      !confirm(
        `Delete the "${field.label}" field?\n\nValues stored for it on existing content will stop ` +
          `being shown. This cannot be undone.`,
      )
    ) {
      return;
    }

    setError(null);
    try {
      await request(`/api/taproot/fields/${field.id}`, { method: 'DELETE' });
      setFields((current) => current.filter((f) => f.id !== field.id));
      if (draft.id === field.id) setDraft(NEW_DRAFT);
      setStatus(`Removed the ${field.label} field.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove the field.');
    }
  }

  async function reorder(next: FieldRow[]) {
    const previous = fields;
    setFields(next);

    try {
      await request(`/api/taproot/content-types/${contentTypeId}/fields`, {
        method: 'PATCH',
        body: JSON.stringify({ fieldIds: next.map((f) => f.id) }),
      });
    } catch (cause) {
      setFields(previous);
      // The action is implicit here — unlike add or remove, nothing on screen says what was being
      // saved — so the server's message gets prefixed with what was actually attempted.
      const detail = cause instanceof Error ? cause.message : 'The server rejected the request.';
      setError(`Could not save the new field order. ${detail}`);
    }
  }

  const isNew = !draft.id;
  const showRequiredWarning = draft.required && itemCount > 0 && !isNewlyRequiredAlready();

  function isNewlyRequiredAlready(): boolean {
    if (!draft.id) return false;
    const original = fields.find((f) => f.id === draft.id);
    return original?.required === 1;
  }

  return (
    <div className="space-y-6">
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

      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        {/* Field list ---------------------------------------------------- */}
        <section aria-labelledby="field-list-heading" className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 id="field-list-heading" className="text-base font-semibold">
              All fields
            </h3>
            <button
              type="button"
              onClick={startNewField}
              className="rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-sunken"
            >
              Add field
            </button>
          </div>

          <SortableFieldList
            fields={fields}
            selectedId={draft.id ?? null}
            onSelect={selectField}
            onReorder={reorder}
            onRemove={removeField}
          />
        </section>

        {/* Field editor ---------------------------------------------------- */}
        <section aria-labelledby="field-editor-heading" className="min-w-0">
          <h3
            id="field-editor-heading"
            ref={editorHeadingRef}
            tabIndex={-1}
            className="mb-3 text-base font-semibold"
          >
            {isNew ? 'Add a field' : `Edit “${draft.label || 'field'}”`}
          </h3>

          <form onSubmit={save}>
            <div className="min-w-0 space-y-5 rounded-lg border border-border bg-surface-raised p-5">
              <div>
                <label htmlFor="field-label" className="block text-sm font-medium">
                  Label
                </label>
                <p id="field-label-hint" className="mt-0.5 text-xs text-content-subtle">
                  What editors see above the input.
                </p>
                <input
                  id="field-label"
                  required
                  value={draft.label}
                  aria-describedby="field-label-hint"
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label htmlFor="field-api-id" className="block text-sm font-medium">
                  API id
                </label>
                <p id="field-api-id-hint" className="mt-0.5 text-xs text-content-subtle">
                  {isNew
                    ? 'The key this value is stored under. Derived from the label if left blank, and fixed once created.'
                    : 'Fixed after creation — code and integrations reference it.'}
                </p>
                <input
                  id="field-api-id"
                  value={draft.api_id}
                  readOnly={!isNew}
                  aria-describedby="field-api-id-hint"
                  placeholder={toApiId(draft.label) || 'derived_from_label'}
                  pattern="[a-z][a-z0-9_]*"
                  onChange={(e) => setDraft({ ...draft, api_id: e.target.value })}
                  className={`mt-1.5 w-full rounded-md border border-border-strong px-3 py-2 font-mono text-sm ${
                    isNew ? 'bg-surface' : 'bg-surface-sunken text-content-muted'
                  }`}
                />
              </div>

              <FieldTypePicker
                value={draft.type}
                disabled={!isNew}
                onChange={(type) => setDraft({ ...draft, type, config: {} })}
              />

              <div>
                <label htmlFor="field-help" className="block text-sm font-medium">
                  Help text <span className="font-normal text-content-subtle">(optional)</span>
                </label>
                <input
                  id="field-help"
                  value={draft.help_text}
                  onChange={(e) => setDraft({ ...draft, help_text: e.target.value })}
                  className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
                />
              </div>

              <div>
                <div className="flex items-start gap-2">
                  <input
                    id="field-required"
                    type="checkbox"
                    checked={draft.required}
                    aria-describedby={showRequiredWarning ? 'field-required-warning' : undefined}
                    onChange={(e) => setDraft({ ...draft, required: e.target.checked })}
                    className="mt-1"
                  />
                  <label htmlFor="field-required" className="text-sm font-medium">
                    Required
                  </label>
                </div>

                {/*
                  Making a field required is retroactive: existing items with no value for it will
                  fail validation the next time someone saves them. Saying so up front beats an
                  editor discovering it on an unrelated edit.
                */}
                {showRequiredWarning && (
                  <p
                    id="field-required-warning"
                    className="mt-2 rounded-md border border-warning bg-warning-subtle px-3 py-2.5 text-xs"
                  >
                    This type already has {itemCount} {itemCount === 1 ? 'item' : 'items'}. Any that
                    have no value for this field will fail validation the next time they are saved,
                    and an editor will have to fill it in.
                  </p>
                )}
              </div>

              <fieldset className="border-t border-border pt-4">
                <legend className="px-1 text-sm font-medium">
                  {FIELD_TYPE_META[draft.type].label} options
                </legend>
                <div className="mt-2">
                  <FieldConfigForm
                    type={draft.type}
                    config={draft.config}
                    contentTypes={contentTypes}
                    taxonomies={taxonomies}
                    blockTypes={blockTypes}
                    currentContentTypeId={contentTypeId}
                    onChange={(config) => setDraft({ ...draft, config })}
                  />
                </div>
              </fieldset>

              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:opacity-60"
                >
                  {busy ? 'Saving…' : isNew ? 'Add field' : 'Save changes'}
                </button>
                {!isNew && (
                  <button
                    type="button"
                    onClick={startNewField}
                    className="rounded-md border border-border-strong px-4 py-2 text-sm font-medium hover:bg-surface-sunken"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>

          </form>
        </section>
      </div>
    </div>
  );
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toApiId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f$1');
}
