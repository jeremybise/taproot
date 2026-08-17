import { useState } from 'react';
import {
  BUILT_IN_COLUMNS,
  DEFAULT_COLUMNS,
  ITEM_SORTS,
  ITEM_SORT_LABELS,
  columnCandidates,
  indexedValueKind,
  type ContentTypeRow,
  type FieldRow,
} from '@taprootcms/core';

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
/** Swap two entries, returning a new array — the reorder every move button performs. */
function swap(keys: string[], from: number, to: number): string[] {
  if (to < 0 || to >= keys.length) return keys;
  const next = [...keys];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/**
 * What a column key is called, whether it names a built-in or a field.
 *
 * A key naming a field that has since been deleted keeps the key itself as its label rather than
 * rendering blank. `resolveListColumns` drops it from the actual list, so this only shows on the
 * settings screen — where seeing the stale key is exactly what tells an admin to remove it.
 */
function columnLabel(key: string, fields: FieldRow[]): string {
  if ((BUILT_IN_COLUMNS as readonly string[]).includes(key)) return builtInLabel(key);
  return fields.find((field) => field.api_id === key)?.label ?? key;
}

/** The built-in columns' visible names, matching what the list's own headings say. */
function builtInLabel(key: string): string {
  return key === 'title'
    ? 'Title'
    : key === 'path'
      ? 'Path'
      : key === 'status'
        ? 'Status'
        : key === 'updated'
          ? 'Updated'
          : 'Created';
}

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
  const [listColumns, setListColumns] = useState<string[]>(() => {
    let stored: string[] | null = null;
    try {
      const parsed = contentType.list_columns ? JSON.parse(contentType.list_columns) : null;
      if (Array.isArray(parsed)) stored = parsed.filter((k): k is string => typeof k === 'string');
    } catch {
      // A stored value that will not parse falls back to the defaults rather than emptying the
      // screen — the `parseJson` precedent, and the same fallback `resolveListColumns` applies.
    }
    if (!stored || stored.length === 0) return [...DEFAULT_COLUMNS];

    /*
     * Title is put back if a stored order somehow lacks it.
     *
     * `resolveListColumns` already forces it when rendering, so a list can never lose its link to
     * the editor — but without this the settings screen would show an order that does not match
     * what the list actually renders, and saving would silently re-add it. Better to show the truth.
     */
    return stored.includes('title') ? stored : ['title', ...stored];
  });
  const [listSort, setListSort] = useState(contentType.list_sort ?? 'path');
  const [listSortField, setListSortField] = useState(contentType.list_sort_field ?? '');
  const [urlPrefix, setUrlPrefix] = useState(contentType.url_prefix ?? '');
  const [previewPath, setPreviewPath] = useState(contentType.preview_path ?? '');
  const [itemPages, setItemPages] = useState(contentType.item_pages === 1);
  const [hideFromNav, setHideFromNav] = useState(contentType.hide_from_nav === 1);
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
          list_columns: listColumns,
          list_sort: listSort,
          // Only meaningful for the two field orders; sent null otherwise so the column cannot hold
          // a stale field name that means nothing — the same rule `publish_at` follows off
          // `scheduled`.
          list_sort_field:
            listSort === 'field_asc' || listSort === 'field_desc' ? listSortField || null : null,
          default_og_image_id: ogImageId || null,
          // Every kind can clutter a sidebar, so this is sent unconditionally rather than folded
          // into one of the kind-gated groups below.
          hide_from_nav: hideFromNav,
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
        <span id="ct-columns-label" className="block text-sm font-medium">
          List columns
        </span>
        <p id="ct-columns-hint" className="mt-0.5 text-xs text-content-subtle">
          What the list of these shows. Title always appears — it carries the link to the editor, so
          a list without it could not be clicked out of.
        </p>

        {/*
          An ordered list with Move up / Move down, not a set of checkboxes.

          The order is what the list actually renders, so it has to be expressible — and it is
          arranged with **buttons rather than dragging**. The house rule is that drag is added
          *alongside* keyboard control and never instead of it, so buttons alone satisfy it fully;
          this is a screen configured once per content type, and dnd-kit here would be fifty lines of
          boilerplate for an interaction nobody repeats. `SortableFieldList` remains the pattern if
          dragging ever earns its place.

          Every control names the column it acts on. A column of identical "Move up" buttons is
          unusable in a screen reader's control list — the same rule `BlockListEditor` follows.
        */}
        <ul
          aria-labelledby="ct-columns-label"
          aria-describedby="ct-columns-hint"
          className="mt-2 space-y-1 rounded-md border border-border p-2"
        >
          {listColumns.map((key, index) => {
            const label = columnLabel(key, fields);
            const locked = key === 'title';
            return (
              <li key={key} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {label}
                  {locked && <span className="ml-1 text-content-subtle">(always shown)</span>}
                </span>

                <button
                  type="button"
                  disabled={index === 0}
                  aria-label={`Move ${label} up`}
                  onClick={() => setListColumns(swap(listColumns, index, index - 1))}
                  className="rounded border border-border-strong px-2 py-1 text-xs transition-colors hover:bg-surface-sunken disabled:opacity-40"
                >
                  <span aria-hidden="true">↑</span>
                </button>
                <button
                  type="button"
                  disabled={index === listColumns.length - 1}
                  aria-label={`Move ${label} down`}
                  onClick={() => setListColumns(swap(listColumns, index, index + 1))}
                  className="rounded border border-border-strong px-2 py-1 text-xs transition-colors hover:bg-surface-sunken disabled:opacity-40"
                >
                  <span aria-hidden="true">↓</span>
                </button>
                <button
                  type="button"
                  disabled={locked}
                  aria-label={`Remove the ${label} column`}
                  onClick={() => setListColumns(listColumns.filter((entry) => entry !== key))}
                  className="rounded border border-border-strong px-2 py-1 text-xs text-danger transition-colors hover:bg-danger-subtle disabled:opacity-40 disabled:text-content-subtle"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>

        {/*
          Adding appends to the end, which is where somebody looking at an ordered list expects a new
          entry to land — and it is then one Move up away from anywhere else.
        */}
        {(() => {
          const available = [
            ...BUILT_IN_COLUMNS.map((key) => ({ key: key as string, label: builtInLabel(key) })),
            ...columnCandidates(fields).map((field) => ({ key: field.api_id, label: field.label })),
          ].filter((column) => !listColumns.includes(column.key));

          if (available.length === 0) return null;

          return (
            <div className="mt-2">
              <p id="ct-columns-add" className="text-xs font-medium text-content-subtle">
                Add a column
              </p>
              <div aria-labelledby="ct-columns-add" className="mt-1.5 flex flex-wrap gap-2">
                {available.map((column) => (
                  <button
                    key={column.key}
                    type="button"
                    onClick={() => setListColumns([...listColumns, column.key])}
                    className="rounded-md border border-border-strong px-2.5 py-1 text-xs font-medium transition-colors hover:bg-surface-sunken"
                  >
                    + {column.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      <div className="@container">
        <div className="grid gap-4 @sm:grid-cols-2">
          <div>
            <label htmlFor="ct-list-sort" className="block text-sm font-medium">
              Default order
            </label>
            <p id="ct-list-sort-hint" className="mt-0.5 text-xs text-content-subtle">
              How the list is sorted when nobody has filtered it.
            </p>
            <select
              id="ct-list-sort"
              value={listSort}
              aria-describedby="ct-list-sort-hint"
              onChange={(e) => setListSort(e.target.value)}
              className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
            >
              {ITEM_SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {ITEM_SORT_LABELS[sort]}
                </option>
              ))}
            </select>
          </div>

          {(listSort === 'field_asc' || listSort === 'field_desc') && (
            <div>
              <label htmlFor="ct-list-sort-field" className="block text-sm font-medium">
                Order by which field
              </label>
              <p id="ct-list-sort-field-hint" className="mt-0.5 text-xs text-content-subtle">
                Only fields the value index carries — text, number, yes/no, date and choice.
              </p>
              <select
                id="ct-list-sort-field"
                value={listSortField}
                aria-describedby="ct-list-sort-field-hint"
                onChange={(e) => setListSortField(e.target.value)}
                className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
              >
                <option value="">— Pick a field —</option>
                {fields
                  .filter((field) => indexedValueKind(field.type))
                  .map((field) => (
                    <option key={field.id} value={field.api_id}>
                      {field.label}
                    </option>
                  ))}
              </select>
            </div>
          )}
        </div>
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

      {contentType.kind !== 'block' && (
        <div className="rounded-md border border-border bg-surface-raised px-4 py-3">
          <label htmlFor="ct-hide-from-nav" className="flex items-start gap-2.5 text-sm font-medium">
            <input
              id="ct-hide-from-nav"
              type="checkbox"
              checked={hideFromNav}
              aria-describedby="ct-hide-from-nav-hint"
              onChange={(e) => setHideFromNav(e.target.checked)}
              className="mt-0.5"
            />
            Hide from the sidebar
          </label>
          <p id="ct-hide-from-nav-hint" className="mt-1 text-xs text-content-subtle">
            {/*
              What it does *not* do is the part worth saying. A checkbox called "hide" reads as a
              way to make content go away, and somebody ticking it needs to know before they save
              that it is a navigation preference and nothing else.
            */}
            For content that is always reached through something else — a listing&rsquo;s entries, a
            directory&rsquo;s people — so the sidebar keeps to what people open every day. Items of
            this type are not hidden: they still appear under <strong>All content</strong>, still
            turn up in search, and this type&rsquo;s own list stays where it is.
          </p>
        </div>
      )}

      {contentType.kind === 'collection' && (
        <div>
          <label htmlFor="ct-url-prefix" className="block text-sm font-medium">
            URL prefix
          </label>
          <p id="ct-url-prefix-hint" className="mt-0.5 text-xs text-content-subtle">
            Items of this type live under <code className="font-mono">/{urlPrefix || '…'}/</code>.
            Lowercase letters, numbers and hyphens — <strong>not</strong> underscores, unlike the API
            id. Changing it does not move existing items — that lands with bulk operations.
          </p>
          {/*
           * `title` is what a browser shows on a pattern mismatch, in place of "please match the
           * requested format" — which names neither the field's rule nor the character that broke
           * it. Worth having even though the value can no longer arrive invalid on its own: this
           * form round-trips every field, so a prefix rejected here blocks every unrelated edit on
           * the screen, and the message is the only thing on offer explaining why.
           */}
          <input
            id="ct-url-prefix"
            value={urlPrefix}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            title="Lowercase letters, numbers and hyphens, with no underscores — for example alum-profile."
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
