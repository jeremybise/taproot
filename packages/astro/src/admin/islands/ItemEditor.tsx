import { useId, useState } from 'react';
import { slugify, type ContentStatus, type FieldRow, type SeoData } from '@taproot/core';

import { FieldControl, type TermOption } from './fields/FieldControl.js';
import SeoPanel, { type MediaOption } from './SeoPanel.js';
import { STATUS_META, STATUS_ORDER } from '../status.js';

/**
 * The content item editor.
 *
 * Renders one input per field from the content type's schema. Phase 1 replaces the richtext,
 * media, relation, and taxonomy placeholders with real editors; the save contract does not change
 * when it does.
 *
 * Server-side validation errors come back keyed by field `api_id`, which is what lets each message
 * be rendered next to its own input and wired up with `aria-describedby` rather than dumped in a
 * single summary at the top.
 */

interface Props {
  itemId?: string;
  contentTypeId: string;
  contentTypeName: string;
  fields: FieldRow[];
  initial: {
    title: string;
    slug: string;
    status: ContentStatus;
    parentId: string | null;
    data: Record<string, unknown>;
    seo: SeoData;
  };
  /** Candidate parents for hierarchical types. Empty for collections and singletons. */
  parents: { id: string; title: string; path: string }[];
  /** Selectable terms for any taxonomy fields, keyed by taxonomy id. Resolved server-side. */
  termsByTaxonomy?: Record<string, TermOption[]>;
  canPublish: boolean;
  isHierarchical: boolean;
  /** Image assets selectable as a social card, with their resolved public URLs. */
  images?: MediaOption[];
  /** The content type's default social image, inherited when the item chooses none. */
  defaultOgImage?: MediaOption | null;
  /** Where this item resolves publicly. Empty for a singleton, which has no path of its own. */
  path?: string;
  origin?: string;
}

/**
 * The statuses the editor offers, in workflow order.
 *
 * Derived from the shared table rather than listed again here, so a status can never carry one
 * label in a list and another in the editor. `scheduled` is normally excluded — nothing yet flips
 * a scheduled item live, so offering it would promise a behaviour that does not exist — but an
 * item already in that status keeps its option, or the select would render blank and quietly
 * misreport what the item is while still saving it unchanged.
 */
function statusOptions(current: ContentStatus): ContentStatus[] {
  return STATUS_ORDER.filter((status) => STATUS_META[status].settable || status === current);
}

export default function ItemEditor({
  itemId,
  contentTypeId,
  contentTypeName,
  fields,
  initial,
  parents,
  termsByTaxonomy,
  canPublish,
  isHierarchical,
  images = [],
  defaultOgImage = null,
  path = '/',
  origin = '',
}: Props) {
  const [title, setTitle] = useState(initial.title);
  const [slug, setSlug] = useState(initial.slug);
  /**
   * Whether the slug is following the title.
   *
   * New items start linked, so typing a title fills the slug in visibly rather than leaving the
   * field blank and having one appear from nowhere after saving. Editing the slug by hand breaks
   * the link, and an existing item never re-links — its URL is already published.
   */
  const [slugLinked, setSlugLinked] = useState(!itemId && !initial.slug);
  const [status, setStatus] = useState<ContentStatus>(initial.status);
  const [parentId, setParentId] = useState<string | null>(initial.parentId);
  const [data, setData] = useState<Record<string, unknown>>(initial.data);
  const [seo, setSeo] = useState<SeoData>(initial.seo);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage(null);

    // Blank overrides are dropped rather than stored as empty strings. `resolveSeo` treats blank
    // as absent anyway, but persisting `metaTitle: ""` would make a cleared field look deliberate
    // in a revision diff and in the API response.
    const payload = { title, slug, status, parentId, data, seo: pruneSeo(seo) };
    const url = itemId ? `/api/taproot/items/${itemId}` : '/api/taproot/items';

    try {
      const response = await fetch(url, {
        method: itemId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(itemId ? payload : { ...payload, contentTypeId }),
      });

      const body = (await response.json().catch(() => null)) as {
        item?: { id: string; path: string };
        error?: string;
        fields?: Record<string, string[]>;
      } | null;

      if (!response.ok) {
        setErrors(body?.fields ?? {});
        setMessage(body?.error ?? `Save failed (${response.status}).`);
        return;
      }

      if (!itemId && body?.item) {
        window.location.href = `/admin/content/${body.item.id}?saved=1`;
        return;
      }

      /**
       * Reload rather than reporting success in place.
       *
       * Everything around this form is server-rendered from the item as it was when the page
       * loaded: the heading, the breadcrumb, the path in the sub-header, and the revision history
       * below. Saving used to leave all of them showing the previous values — a rename displayed
       * the old title next to the new one until someone reloaded by hand.
       *
       * Re-rendering them from the island would mean maintaining a second copy of that markup and
       * hand-managing the focus and announcement that a real navigation gives for free. The flash
       * lands in the layout's live region on the way back.
       */
      window.location.href = `/admin/content/${itemId}?updated=1`;
    } catch {
      setMessage('Could not reach the server. Your changes have not been saved.');
    } finally {
      setBusy(false);
    }
  }

  function setValue(apiId: string, value: unknown) {
    setData((current) => ({ ...current, [apiId]: value }));
  }

  return (
    <form onSubmit={save} className="grid gap-8 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0 space-y-6">
        <div role="alert" aria-live="assertive">
          {message && (
            <p
              className={`rounded-md border px-4 py-3 text-sm ${
                message === 'Saved.'
                  ? 'border-accent bg-accent-subtle'
                  : 'border-danger bg-danger-subtle'
              }`}
            >
              {message}
            </p>
          )}
        </div>

        <div>
          <label htmlFor={`${formId}-title`} className="block text-sm font-medium">
            Title
          </label>
          <input
            id={`${formId}-title`}
            required
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (slugLinked) setSlug(slugify(e.target.value));
            }}
            className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor={`${formId}-slug`} className="block text-sm font-medium">
            Slug
          </label>
          <p id={`${formId}-slug-hint`} className="mt-0.5 text-xs text-content-subtle">
            The last part of the URL. Changing it moves the page and leaves a redirect behind
            automatically.
          </p>
          <input
            id={`${formId}-slug`}
            value={slug}
            onChange={(e) => {
              // Typing here takes manual control; the slug stops following the title.
              setSlugLinked(false);
              setSlug(e.target.value);
            }}
            aria-describedby={`${formId}-slug-hint`}
            placeholder={slugify(title) || 'derived-from-the-title'}
            className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-sm"
          />
        </div>

        <section aria-labelledby={`${formId}-fields`} className="space-y-6">
          <h2 id={`${formId}-fields`} className="text-base font-semibold">
            {contentTypeName} fields
          </h2>

          {fields.length === 0 && (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-content-muted">
              This content type has no fields yet.
            </p>
          )}

          {fields.map((field) => (
            <FieldControl
              key={field.id}
              field={field}
              value={data[field.api_id]}
              errors={errors[field.api_id]}
              onChange={(value) => setValue(field.api_id, value)}
              termsByTaxonomy={termsByTaxonomy}
            />
          ))}
        </section>
      </div>

      {/* Sidebar ---------------------------------------------------------- */}
      <aside className="space-y-6">
        <div className="rounded-lg border border-border bg-surface-raised p-4">
          <h2 className="text-sm font-semibold">Publishing</h2>

          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={`${formId}-status`} className="block text-sm font-medium">
                Status
              </label>
              {/*
                The same badge the lists use, so the colour an editor learns while scanning a list
                means the same thing here. It tracks local state rather than the saved value, which
                is the honest reading of a form: it shows what will be saved, not what is stored.
              */}
              <span
                className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_META[status].badgeClass}`}
              >
                {STATUS_META[status].label}
              </span>
            </div>
            <select
              id={`${formId}-status`}
              value={status}
              onChange={(e) => setStatus(e.target.value as ContentStatus)}
              className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
            >
              {statusOptions(status).map((option) => (
                <option
                  key={option}
                  value={option}
                  disabled={STATUS_META[option].needsPublish && !canPublish}
                >
                  {STATUS_META[option].label}
                  {STATUS_META[option].needsPublish && !canPublish ? ' (needs editor role)' : ''}
                </option>
              ))}
            </select>
            {!canPublish && (
              <p className="mt-1.5 text-xs text-content-subtle">
                Your role can save drafts and submit for review. An editor publishes.
              </p>
            )}
          </div>

          {isHierarchical && (
            <div className="mt-4">
              <label htmlFor={`${formId}-parent`} className="block text-sm font-medium">
                Parent page
              </label>
              <select
                id={`${formId}-parent`}
                value={parentId ?? ''}
                onChange={(e) => setParentId(e.target.value || null)}
                className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
              >
                <option value="">— Top level —</option>
                {parents.map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {parent.path}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-content-subtle">
                Moving a page rewrites the URLs of everything beneath it and leaves redirects.
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-5 w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? 'Saving…' : itemId ? 'Save changes' : 'Create item'}
          </button>
        </div>

        {/*
          Below Publishing rather than above it. The save button has to stay reachable without
          scrolling past a panel most edits never touch, and the SEO fields are reviewed at the end
          of writing a page rather than the start.
        */}
        <SeoPanel
          seo={seo}
          onChange={setSeo}
          itemTitle={title}
          path={path}
          origin={origin}
          images={images}
          defaultOgImage={defaultOgImage}
        />
      </aside>
    </form>
  );
}

/**
 * Drop keys whose value carries no meaning, so absence is the only way "unset" is represented.
 *
 * Without this a cleared meta title round-trips as `""`, which is falsy everywhere it is read but
 * shows up as a real change in the revision diff — a save that changed nothing looks like one that
 * did.
 */
function pruneSeo(seo: SeoData): SeoData {
  const pruned: SeoData = {};

  if (seo.metaTitle?.trim()) pruned.metaTitle = seo.metaTitle.trim();
  if (seo.metaDescription?.trim()) pruned.metaDescription = seo.metaDescription.trim();
  if (seo.ogImageId) pruned.ogImageId = seo.ogImageId;
  if (seo.noIndex) pruned.noIndex = true;

  return pruned;
}
