import { useState } from 'react';
import type { ContentTypeRow, FieldRow } from '@taprootcms/core';

import type { MediaOption } from '../mediaOptions.js';
import { MediaField } from './media/MediaField.js';
import { IconInline } from '../components/IconInline.js';
import { contentTypeIcons } from '../contentTypeIcons.js';

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
  const [summaryTemplate, setSummaryTemplate] = useState(contentType.summary_template ?? '');
  const [icon, setIcon] = useState(contentType.icon ?? '');
  const [urlPrefix, setUrlPrefix] = useState(contentType.url_prefix ?? '');
  const [previewPath, setPreviewPath] = useState(contentType.preview_path ?? '');
  const [itemPages, setItemPages] = useState(contentType.item_pages === 1);
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
          summary_template: summaryTemplate.trim() || null,
          icon: icon || null,
          default_og_image_id: ogImageId || null,
          ...(contentType.kind === 'collection'
            ? { url_prefix: urlPrefix.trim() || null, item_pages: itemPages }
            : {}),
          // `null` rather than omitted when blank, so clearing the box turns preview back off.
          // Omitting it would read as "not provided" and keep the old value — the `undefined`/`null`
          // distinction `updateContentType` makes, from the side that has to send it.
          ...(contentType.kind === 'singleton'
            ? { preview_path: previewPath.trim() || null }
            : {}),
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

      <div className="@container">
        <div className="grid gap-4 @sm:grid-cols-2">
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
        <label htmlFor="ct-summary-template" className="block text-sm font-medium">
          Summary line <span className="font-normal text-content-subtle">(optional)</span>
        </label>
        <p id="ct-summary-template-hint" className="mt-0.5 text-xs text-content-subtle">
          How one of these reads in a list, and — for a block type — on its collapsed row. Write
          <code className="mx-1 font-mono">{'{{ field_api_id }}'}</code>
          where a value should go. Leave it empty to use the item's own title.
        </p>
        <input
          id="ct-summary-template"
          value={summaryTemplate}
          maxLength={200}
          placeholder={
            /* A worked example beats an abstract one: it shows a token, a literal separator, and
               that two fields can be combined, which is the whole reason this is not a field picker. */
            fields.length > 1
              ? `{{ ${fields[0]!.api_id} }} · {{ ${fields[1]!.api_id} }}`
              : fields.length === 1
                ? `{{ ${fields[0]!.api_id} }}`
                : '{{ headline }}'
          }
          aria-describedby="ct-summary-template-hint ct-summary-template-fields"
          onChange={(e) => setSummaryTemplate(e.target.value)}
          className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-sm"
        />
        {fields.length > 0 && (
          /*
            The available names, listed rather than left to be remembered. A token naming a field
            that does not exist renders as nothing — deliberately, since a template outlives the
            fields it names — which is forgiving at save time and unhelpful at authoring time unless
            the real names are on screen.
          */
          <p id="ct-summary-template-fields" className="mt-1.5 text-xs text-content-subtle">
            Fields you can use:{' '}
            {fields.map((f, i) => (
              <span key={f.id}>
                {i > 0 && ', '}
                <code className="font-mono">{f.api_id}</code>
              </span>
            ))}
          </p>
        )}
      </div>

      <div>
        <span id="ct-icon-label" className="block text-sm font-medium">
          Sidebar icon
        </span>
        <p id="ct-icon-hint" className="mt-0.5 text-xs text-content-subtle">
          Shown beside this type in the sidebar. Decoration only — the name is always there too, so
          the choice is never what tells one entry from another.
        </p>
        {/*
          A radio group, not a `<select>` of names nobody can picture and not a grid of bare icon
          buttons.

          Radios give the platform's own roving focus and arrow-key movement for a single choice out
          of a set, which is the same reason `LinkDialog`'s mode selector is a radio group drawn as
          tabs. Each option carries its Lucide name as visible text beside the mark: it is what makes
          the control usable without colour or shape recognition, and it is the string an author
          would search for to ask why an icon looks the way it does.
        */}
        <div
          role="radiogroup"
          aria-labelledby="ct-icon-label"
          aria-describedby="ct-icon-hint"
          /*
            Breakpoint columns rather than `repeat(auto-fill, minmax(9.5rem, 1fr))`.

            The auto-fill version read better and `reflowHazards()` was right to refuse it: a
            152px minimum track is a fixed track, and at a 305px viewport a single column of it
            plus the panel's padding is the shape that overflows. One column on a phone is also
            simply the correct answer — a two-up grid there truncates every name to "graduat…",
            which defeats the point of showing the names at all.
          */
          className="mt-2 grid max-h-64 grid-cols-1 gap-1.5 overflow-y-auto rounded-md border border-border p-2 sm:grid-cols-2 xl:grid-cols-3"
        >
          {[
            { name: '', label: 'Default' },
            ...contentTypeIcons.map((n) => ({ name: n as string, label: n as string })),
          ].map(
            (option) => (
              <label
                key={option.name || 'default'}
                className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors ${
                  icon === option.name
                    ? 'border-accent bg-accent-subtle font-medium'
                    : 'border-transparent hover:bg-surface-sunken'
                }`}
              >
                <input
                  type="radio"
                  name="ct-icon"
                  value={option.name}
                  checked={icon === option.name}
                  onChange={() => setIcon(option.name)}
                  className="shrink-0"
                />
                <IconInline name={option.name || 'file-text'} className="h-4 w-4 shrink-0" />
                <span className="min-w-0 truncate">{option.label}</span>
              </label>
            ),
          )}
        </div>
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

      {contentType.kind === 'collection' && (
        <div className="rounded-md border border-border bg-surface-raised px-4 py-3">
          <label htmlFor="ct-item-pages" className="flex items-start gap-2.5 text-sm font-medium">
            <input
              id="ct-item-pages"
              type="checkbox"
              checked={itemPages}
              aria-describedby="ct-item-pages-hint"
              onChange={(e) => setItemPages(e.target.checked)}
              className="mt-0.5"
            />
            Items have their own pages
          </label>
          <p id="ct-item-pages-hint" className="mt-1 text-xs text-content-subtle">
            On, each item is a page on your site at its own URL. Turn it off for content that is only
            ever shown in a listing — a staff directory, a set of testimonials, a list of course
            sections. Those items still exist, still have field values and still appear wherever your
            site lists them; they simply have no page of their own, so nothing is served at their
            address and site search leaves them out.
          </p>
        </div>
      )}

      {contentType.kind === 'singleton' && (
        <div>
          <label htmlFor="ct-preview-path" className="block text-sm font-medium">
            Preview path <span className="font-normal text-content-subtle">(optional)</span>
          </label>
          <p id="ct-preview-path-hint" className="mt-0.5 text-xs text-content-subtle">
            Where your site renders this on the web — <code className="font-mono">/</code> for a
            homepage. Setting it turns on the live preview pane for this singleton. Leave it empty
            for a singleton that is not a page, like site-wide settings or contact details: there
            is nothing to look at, and pointing a preview somewhere else would show you a page this
            content is not.
          </p>
          <input
            id="ct-preview-path"
            value={previewPath}
            placeholder="/"
            aria-describedby="ct-preview-path-hint"
            onChange={(e) => setPreviewPath(e.target.value)}
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
