import { useState } from 'react';
import type { FieldRow } from '@taproot/core';

import { FieldControl, type TermOption } from './fields/FieldControl.js';
import type { MediaOption } from '../mediaOptions.js';

/**
 * Editing one library entry.
 *
 * The same `FieldControl`s the item editor uses, so a reusable call-to-action is edited with the
 * same inputs as an inline one. What differs is the consequence, and the screen says so: saving
 * here changes every page that references this entry.
 */

interface Props {
  id: string;
  fields: FieldRow[];
  initial: { name: string; description: string; data: Record<string, unknown> };
  termsByTaxonomy?: Record<string, TermOption[]>;
  media?: MediaOption[];
  usageCount: number;
  canEdit: boolean;
}

export default function ReusableBlockEditor({
  id,
  fields,
  initial,
  termsByTaxonomy,
  media,
  usageCount,
  canEdit,
}: Props) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [data, setData] = useState(initial.data);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage(null);

    try {
      const response = await fetch(`/api/taproot/reusable-blocks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null, data }),
      });

      const body = (await response.json().catch(() => null)) as {
        error?: string;
        fields?: Record<string, string[]>;
      } | null;

      if (!response.ok) {
        setErrors(body?.fields ?? {});
        setFailed(true);
        setMessage(body?.error ?? `Save failed (${response.status}).`);
        return;
      }

      setFailed(false);
      setMessage(
        usageCount === 0
          ? 'Saved.'
          : `Saved. ${usageCount} ${usageCount === 1 ? 'page' : 'pages'} using this block now show the new content.`,
      );
    } catch {
      setFailed(true);
      setMessage('Could not reach the server. Your changes have not been saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="max-w-2xl space-y-5">
      <div role="alert" aria-live="assertive">
        {message && (
          <p
            className={`rounded-md border px-4 py-3 text-sm ${
              failed ? 'border-danger bg-danger-subtle' : 'border-accent bg-accent-subtle'
            }`}
          >
            {message}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="rb-name" className="block text-sm font-medium">
          Name
        </label>
        <p id="rb-name-hint" className="mt-0.5 text-xs text-content-subtle">
          How editors find it in the library. Renaming is safe â€” pages reference it by id.
        </p>
        <input
          id="rb-name"
          required
          value={name}
          disabled={!canEdit}
          aria-describedby="rb-name-hint"
          onChange={(e) => setName(e.target.value)}
          className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label htmlFor="rb-description" className="block text-sm font-medium">
          Description <span className="font-normal text-content-subtle">(optional)</span>
        </label>
        <textarea
          id="rb-description"
          rows={2}
          maxLength={500}
          value={description}
          disabled={!canEdit}
          onChange={(e) => setDescription(e.target.value)}
          className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
        />
      </div>

      <fieldset className="space-y-5 border-t border-border pt-5" disabled={!canEdit}>
        <legend className="text-sm font-semibold">Content</legend>
        {fields.length === 0 ? (
          <p className="text-sm text-content-subtle">This block type has no fields.</p>
        ) : (
          fields.map((field) => (
            <FieldControl
              key={field.id}
              field={field}
              value={data[field.api_id]}
              errors={errors[field.api_id]}
              termsByTaxonomy={termsByTaxonomy}
              media={media}
              preview={!canEdit}
              onChange={(value) => setData({ ...data, [field.api_id]: value })}
            />
          ))
        )}
      </fieldset>

      {canEdit && (
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {busy ? 'Savingâ€¦' : 'Save'}
        </button>
      )}
    </form>
  );
}
