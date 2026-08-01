import { useState } from 'react';
import type { ContentTypeRow, FieldRow } from '@taprootcms/core';

import type { MediaOption } from '../mediaOptions.js';
import { MediaField } from './media/MediaField.js';

/**
 * Content type settings.
 *
 * `api_id` and `kind` are shown read-only: the first is referenced by code and integrations, and
 * the second determines how every existing item's path was built, so changing it would strand
 * URLs. Both are fixed at creation and the UI says so rather than offering an edit the server
 * would reject.
 */
export default function ContentTypeSettings({
  contentType,
  fields,
  images = [],
}: {
  contentType: ContentTypeRow;
  fields: FieldRow[];
  /** Image assets selectable as this type's default social card. */
  images?: MediaOption[];
}) {
  const [name, setName] = useState(contentType.name);
  const [namePlural, setNamePlural] = useState(contentType.name_plural);
  const [description, setDescription] = useState(contentType.description ?? '');
  const [titleField, setTitleField] = useState(contentType.title_field ?? '');
  const [urlPrefix, setUrlPrefix] = useState(contentType.url_prefix ?? '');
  const [ogImageId, setOgImageId] = useState(contentType.default_og_image_id ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/taproot/content-types/${contentType.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          name_plural: namePlural.trim(),
          description: description.trim() || null,
          title_field: titleField || null,
          default_og_image_id: ogImageId || null,
          ...(contentType.kind === 'collection' ? { url_prefix: urlPrefix.trim() || null } : {}),
        }),
      });

      const body = (await response.json().catch(() => null)) as { error?: string } | null;

      if (!response.ok) {
        setFailed(true);
        setMessage(body?.error ?? `Save failed (${response.status}).`);
        return;
      }

      setFailed(false);
      setMessage('Settings saved.');
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

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="ct-name" className="block text-sm font-medium">
            Name
          </label>
          <input
            id="ct-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor="ct-plural" className="block text-sm font-medium">
            Plural name
          </label>
          <input
            id="ct-plural"
            required
            value={namePlural}
            onChange={(e) => setNamePlural(e.target.value)}
            className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div>
        <label htmlFor="ct-description" className="block text-sm font-medium">
          Description <span className="font-normal text-content-subtle">(optional)</span>
        </label>
        <p id="ct-description-hint" className="mt-0.5 text-xs text-content-subtle">
          Shown to editors when they choose what kind of content to create.
        </p>
        <textarea
          id="ct-description"
          rows={2}
          maxLength={500}
          value={description}
          aria-describedby="ct-description-hint"
          onChange={(e) => setDescription(e.target.value)}
          className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label htmlFor="ct-title-field" className="block text-sm font-medium">
          Title field
        </label>
        <p id="ct-title-field-hint" className="mt-0.5 text-xs text-content-subtle">
          Which field labels an item in admin lists. Defaults to the item's own title.
        </p>
        <select
          id="ct-title-field"
          value={titleField}
          aria-describedby="ct-title-field-hint"
          onChange={(e) => setTitleField(e.target.value)}
          className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
        >
          <option value="">— Use the item title —</option>
          {fields
            .filter((field) => field.type === 'text')
            .map((field) => (
              <option key={field.id} value={field.api_id}>
                {field.label}
              </option>
            ))}
        </select>
      </div>

      <div>
        <span id="ct-og-image-label" className="block text-sm font-medium">
          Default social image
        </span>
        <p id="ct-og-image-hint" className="mt-0.5 text-xs text-content-subtle">
          Used when an item of this type has not chosen its own. Changing it updates every item
          still inheriting — nothing is copied onto items at creation.
        </p>
        <MediaField
          id="ct-og-image"
          labelledBy="ct-og-image-label"
          describedBy="ct-og-image-hint"
          value={ogImageId ? [ogImageId] : []}
          onChange={(ids) => setOgImageId(ids[0] ?? '')}
          library={images}
          accept={['image/']}
          noun="social image"
        />
      </div>

      {contentType.kind === 'collection' && (
        <div>
          <label htmlFor="ct-url-prefix" className="block text-sm font-medium">
            URL prefix
          </label>
          <p id="ct-url-prefix-hint" className="mt-0.5 text-xs text-content-subtle">
            Items of this type live under <code className="font-mono">/{urlPrefix || '…'}/</code>.
            Changing it does not move existing items — that lands with bulk operations.
          </p>
          <input
            id="ct-url-prefix"
            value={urlPrefix}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            aria-describedby="ct-url-prefix-hint"
            onChange={(e) => setUrlPrefix(e.target.value)}
            className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-sm"
          />
        </div>
      )}

      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:opacity-60"
      >
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}
