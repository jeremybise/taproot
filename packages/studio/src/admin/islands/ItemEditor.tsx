import { useId, useState } from 'react';
import {
  slugify,
  transitionLabel,
  transitionsFrom,
  type ContentStatus,
  type FieldRow,
  type SeoData,
} from '@taproot/core';

import { FieldControl, type TermOption } from './fields/FieldControl.js';
import type { BlockTypeOption, ReusableBlockOption } from './fields/BlockListEditor.js';
import AccessibilityPanel from './AccessibilityPanel.js';
import SeoPanel from './SeoPanel.js';
import type { MediaOption } from '../mediaOptions.js';
import type { RelationTarget } from '../relationOptions.js';
import { STATUS_META } from '../status.js';

/**
 * The content item editor.
 *
 * Renders one input per field from the content type's schema, through `FieldControl` — the same
 * component the content-type builder previews with, so the two cannot drift.
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
    publishAt: string | null;
    parentId: string | null;
    data: Record<string, unknown>;
    seo: SeoData;
  };
  /** Candidate parents for hierarchical types. Empty for collections and singletons. */
  parents: { id: string; title: string; path: string }[];
  /** Selectable terms for any taxonomy fields, keyed by taxonomy id. Resolved server-side. */
  termsByTaxonomy?: Record<string, TermOption[]>;
  relationTargets?: Record<string, RelationTarget>;
  /** Block types with their fields, for any block fields on this type. */
  blockTypes?: BlockTypeOption[];
  /** Library entries placeable into a block field. */
  reusableBlocks?: ReusableBlockOption[];
  canPublish: boolean;
  isHierarchical: boolean;
  /**
   * The media library's first page, with resolved public URLs.
   *
   * One list for both the SEO panel and any `media` fields, rather than one query each: the panel
   * constrains itself to images through the picker's accept list, so narrowing it here would only
   * stop a document field from ever reaching a PDF.
   */
  media?: MediaOption[];
  /**
   * The assets this item already references, however old they are.
   *
   * Separate from `media` because that is the library's most recent page: an item pointing at an
   * asset uploaded a year ago is not in it, and the accessibility panel reading alt text from the
   * page on hand would report every one of those images as undescribed. Same trap
   * `relationTargetsForFields` already avoids by being handed the item's stored data.
   */
  referencedMedia?: MediaOption[];
  /** The content type's default social image, inherited when the item chooses none. */
  defaultOgImage?: MediaOption | null;
  /** Where this item resolves publicly. Empty for a singleton, which has no path of its own. */
  path?: string;
  origin?: string;
  /**
   * The release whose staged version is being edited, if any.
   *
   * Its presence changes what this form *is*. Without it the editor writes to `content_items` and a
   * published page changes the moment it saves; with it the editor writes to `release_items` and the
   * live page is untouched until the release publishes. That is the whole point of the feature — the
   * tuition page can be rewritten weeks early without the new figure appearing on the site — so the
   * mode is announced rather than merely implied by a different endpoint.
   *
   * Status, scheduling, and parent are all absent in this mode. A release publishes what is in it,
   * so "what status will this end up in" is the release's question, not the item's; and accepting a
   * status here would be a route to a transition `canChangeStatus` never saw.
   */
  release?: { id: string; name: string } | null;
}

export default function ItemEditor({
  itemId,
  contentTypeId,
  contentTypeName,
  fields,
  initial,
  parents,
  termsByTaxonomy,
  relationTargets,
  blockTypes,
  reusableBlocks,
  canPublish,
  isHierarchical,
  media = [],
  referencedMedia = [],
  defaultOgImage = null,
  path = '/',
  origin = '',
  release = null,
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
  /**
   * Held as the `datetime-local` string the input speaks, converted only at the boundary.
   *
   * That input has no timezone and the API wants ISO 8601, so a round trip through `Date` is
   * unavoidable; doing it once on the way out beats doing it on every keystroke and beats storing
   * two representations that can disagree.
   */
  const [publishAt, setPublishAt] = useState(toLocalInput(initial.publishAt));
  const [parentId, setParentId] = useState<string | null>(initial.parentId);
  const [data, setData] = useState<Record<string, unknown>>(initial.data);
  const [seo, setSeo] = useState<SeoData>(initial.seo);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();

  /**
   * What can be done from where the item *is*, not from what the form currently shows.
   *
   * The API compares against the row in the database, so measuring from local state would offer a
   * chain of moves — draft to review to published in one save — that the boundary would refuse as
   * a single jump. One save is one transition.
   */
  const transitions = transitionsFrom(initial.status);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage(null);

    // Blank overrides are dropped rather than stored as empty strings. `resolveSeo` treats blank
    // as absent anyway, but persisting `metaTitle: ""` would make a cleared field look deliberate
    // in a revision diff and in the API response.
    const payload = {
      title,
      slug,
      status,
      // Only meaningful while scheduled; the server clears it on any other status anyway, and
      // sending a stale value would be asking it to.
      publishAt: status === 'scheduled' ? fromLocalInput(publishAt) : null,
      parentId,
      data,
      seo: pruneSeo(seo),
    };

    /**
     * In release mode the payload is deliberately narrower, not just aimed elsewhere.
     *
     * `status`, `publishAt`, and `parentId` are dropped rather than sent and ignored: the staged
     * endpoint refuses them, and building a payload the boundary rejects half of is how a field
     * quietly stops working when somebody later relaxes that schema.
     */
    const url = release
      ? `/api/taproot/releases/${release.id}/items/${itemId}`
      : itemId
        ? `/api/taproot/items/${itemId}`
        : '/api/taproot/items';

    const requestBody = release
      ? { title, slug, data, seo: pruneSeo(seo) }
      : itemId
        ? payload
        : { ...payload, contentTypeId };

    try {
      const response = await fetch(url, {
        method: itemId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
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
      window.location.href = release
        ? `/admin/content/${itemId}?release=${encodeURIComponent(release.id)}&updated=1`
        : `/admin/content/${itemId}?updated=1`;
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
              relationTargets={relationTargets}
              blockTypes={blockTypes}
              reusableBlocks={reusableBlocks}
              // Promoting shares content across pages, so it sits behind the same bar as
              // publishing rather than the one for editing a single page.
              canPromote={canPublish}
              media={media}
            />
          ))}
        </section>
      </div>

      {/* Sidebar ---------------------------------------------------------- */}
      <aside className="space-y-6">
        {release ? (
          <div className="rounded-lg border border-status-scheduled bg-status-scheduled-subtle p-4">
            <h2 className="text-sm font-semibold">Staged in a release</h2>
            <p className="mt-1.5 text-sm">
              You are editing the version waiting in{' '}
              <a href={`/admin/releases/${release.id}`} className="font-medium underline">
                {release.name}
              </a>
              . The live page does not change until that release publishes.
            </p>
            {/*
              No status buttons and no schedule field, and their absence is the point rather than an
              omission. A release publishes everything in it at once, so the moment this page goes
              live is the release's to decide — offering a per-item status here would put two
              answers to one question on the same screen.
            */}
            <p className="mt-2 text-xs text-content-muted">
              Status, scheduling, and the parent page are edited on the live item, not here.
            </p>

            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save to release'}
            </button>

            <a
              href={`/admin/content/${itemId}`}
              className="mt-2 block rounded-md px-3 py-2 text-center text-sm text-content-muted transition-colors hover:bg-surface-sunken"
            >
              Edit the live page instead
            </a>
          </div>
        ) : (
        <div className="rounded-lg border border-border bg-surface-raised p-4">
          <h2 className="text-sm font-semibold">Publishing</h2>

          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-2">
              {/*
                A span, not a `<label for>`: what follows is a list of buttons, and a label
                pointing at a `<ul>` is silently inert — `scripts/a11y-audit.mjs` checks exactly
                that. The list is named by it through `aria-labelledby` instead.
              */}
              <span id={`${formId}-status-label`} className="block text-sm font-medium">
                Status
              </span>
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
            {/*
              Named actions rather than a status dropdown.

              A `<select>` of statuses asks an editor to know that "in_review" is how you submit
              something and that archived pages come back as drafts — the workflow was in the
              model and nowhere in the interface. Buttons named after the act put the graph on the
              screen: what you can do from here, and what each one is called.

              Offered from the same table the API enforces, filtered to legal moves and then to the
              ones this role may make, so the screen cannot offer something the boundary refuses.
            */}
            <ul aria-labelledby={`${formId}-status-label`} className="mt-2 space-y-1.5">
              {transitions.map(({ to, role }) => {
                const blocked = !canPublish && role === 'editor';
                return (
                  <li key={to}>
                    <button
                      type="button"
                      disabled={blocked || busy}
                      aria-describedby={blocked ? `${formId}-role-note` : undefined}
                      onClick={() => setStatus(to)}
                      className={`w-full rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50 ${
                        status === to
                          ? 'border-accent bg-accent-subtle'
                          : 'border-border-strong hover:bg-surface-sunken'
                      }`}
                    >
                      {transitionLabel(initial.status, to)}
                      {status === to && initial.status !== to && (
                        // The button is a staged intent, not the act — nothing moves until Save,
                        // and saying so is what stops someone leaving the page thinking it did.
                        <span className="ml-1 font-normal text-content-muted">
                          — on save
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}

              {status !== initial.status && (
                <li>
                  <button
                    type="button"
                    onClick={() => setStatus(initial.status)}
                    className="w-full rounded-md px-3 py-1.5 text-left text-sm text-content-muted transition-colors hover:bg-surface-sunken"
                  >
                    Keep as {STATUS_META[initial.status].label.toLowerCase()}
                  </button>
                </li>
              )}
            </ul>

            {status === 'scheduled' && (
              <div className="mt-3">
                <label htmlFor={`${formId}-publish-at`} className="block text-sm font-medium">
                  Goes live
                </label>
                <input
                  id={`${formId}-publish-at`}
                  type="datetime-local"
                  required
                  value={publishAt}
                  onChange={(event) => setPublishAt(event.target.value)}
                  aria-describedby={`${formId}-publish-at-hint`}
                  className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
                />
                <p id={`${formId}-publish-at-hint`} className="mt-1.5 text-xs text-content-subtle">
                  {publishAt && fromLocalInput(publishAt)! <= new Date().toISOString()
                    ? 'That time has already passed, so this goes live as soon as it is saved.'
                    : 'Your local time. The page appears for visitors at that moment.'}
                </p>
              </div>
            )}

            {!canPublish && (
              <p id={`${formId}-role-note`} className="mt-2 text-xs text-content-subtle">
                {initial.status === 'published'
                  ? 'This item is live. Taking it down is an editor’s decision — you can still edit the content.'
                  : 'Your role can save drafts and submit for review. An editor publishes.'}
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
        )}

        {/*
          Between Publishing and SEO, and both neighbours are the reason.

          Above Publishing it would push the save button off the screen; below SEO it would sit
          where nobody scrolls, which for a checker is the same as not existing. Here it is the
          thing you pass on the way to publishing, which is exactly when it is worth reading — and
          it collapses to a single line when there is nothing to say, so it costs almost no height
          on the pages that are already fine.
        */}
        <AccessibilityPanel
          fields={fields}
          data={data}
          referencedMedia={referencedMedia}
          library={media}
          blockTypes={blockTypes}
          reusableBlocks={reusableBlocks}
        />

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
          images={media}
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
/**
 * ISO 8601 → the `YYYY-MM-DDTHH:mm` a `datetime-local` input speaks, in the browser's zone.
 *
 * The conversion is the whole reason this is fiddly: the stored value is absolute and the input is
 * wall-clock. Someone scheduling "9am" means 9am where they are, which is what a local input gets
 * right and a naive string slice gets wrong by however many hours they are from UTC.
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** The inverse. An empty or unparseable input is null rather than an invalid date. */
function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pruneSeo(seo: SeoData): SeoData {
  const pruned: SeoData = {};

  if (seo.metaTitle?.trim()) pruned.metaTitle = seo.metaTitle.trim();
  if (seo.metaDescription?.trim()) pruned.metaDescription = seo.metaDescription.trim();
  if (seo.ogImageId) pruned.ogImageId = seo.ogImageId;
  if (seo.noIndex) pruned.noIndex = true;

  return pruned;
}
