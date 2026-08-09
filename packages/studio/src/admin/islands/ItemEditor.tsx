import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  isFieldVisible,
  primaryTransition,
  slugify,
  transitionLabel,
  transitionsFrom,
  type ContentStatus,
  type FieldRow,
  type SeoData,
} from '@taprootcms/core';

import { FieldControl, type TermOption } from './fields/FieldControl.js';
import { ItemPicker } from './fields/ItemPicker.js';
import type { SnippetOption } from './fields/SnippetField.js';
import type { BlockTypeOption, ReusableBlockOption } from './fields/BlockListEditor.js';
import AccessibilityPanel from './AccessibilityPanel.js';
import PreviewPane from './PreviewPane.js';
import SeoPanel from './SeoPanel.js';
import type { MediaOption } from '../mediaOptions.js';
import type { ParentOption } from '../parentOptions.js';
import type { RelationTarget } from '../relationOptions.js';
import { STATUS_META } from '../status.js';
import { useDismissable } from './useDismissable.js';
import EditorActionIcons, { writePreviewPaneState } from './EditorActionIcons.js';

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
  /**
   * The first page of candidate parents. Empty for collections and singletons.
   *
   * Grouped by `typeName` in sidebar order — a parent need not share this item's content type, so
   * on a nested site this is every page-kind item and a flat list stops being readable. See
   * `parentOptions.ts` for why the picker used to be narrowed to one type and what that broke.
   */
  parents: ParentOption[];
  /** How many page-kind items exist, so the picker can say what its first page is not showing. */
  parentTotal?: number;
  /**
   * This item's own path, so the picker can keep its subtree out of *search results*.
   *
   * `parentCandidates` already excludes self and descendants from the first page. Once searching
   * reaches past that page the same exclusion has to happen client-side, or an editor can find their
   * own child by typing its title and choose a move the server will refuse. Absent on the create
   * screen, where the item does not exist and has nothing beneath it.
   *
   * **This is the row's `path`, and `path` below is not** — that one is `previewPathFor`, the
   * address a visitor sees. They differ for a singleton, and a singleton never reaches this control
   * anyway; the two are kept apart because conflating them is what sent the preview pane at
   * `/__singleton/{api_id}` once already.
   */
  itemPath?: string;
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
  /** Every reusable text snippet, for any `snippet` field on this type or inside its blocks. */
  snippets?: SnippetOption[];
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
  /**
   * Where a visitor sees this item, from `previewPathFor` — **not** the row's `path`.
   *
   * For a page or collection the two are the same. For a singleton they are not: the row's path is
   * the synthetic `/__singleton/{api_id}` and this is the address the site actually renders it at,
   * which only the content type's preview path can say. Both readers below mean the public URL —
   * the pane opens on it, and the SEO panel shows it under the snippet — so sending the row's path
   * pointed both at a URL no visitor requests.
   */
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
  /**
   * The live preview pane, when this item has a page to preview.
   *
   * Absent for a singleton or a brand-new item — the first has only the synthetic
   * `/__singleton/{api_id}`, which is an addressing convenience rather than a route, and the second
   * has no id for a token to name. `open` comes from a cookie the server read, so the pane's state
   * survives the full-page navigation `save()` performs.
   */
  preview?: { open: boolean; siteConfigured: boolean } | null;
  /**
   * Open releases this item is not already in, and whether this role may create one.
   *
   * Staging is contributor and creating is editor, so the two halves are gated separately — the
   * select is offered to anyone who can stage, and only an editor sees "New release…".
   */
  releases?: { addable: { id: string; name: string }[]; canCreate: boolean } | null;
  /**
   * The icon actions in the sticky bar. Absent on the create screen, which has no item to preview,
   * no revisions, nothing linking to it and nothing to delete.
   */
  actions?: { previewable: boolean; showReferences: boolean; showDelete: boolean } | null;
}

/**
 * Contiguous runs of one content type, for the parent picker's `<optgroup>`s.
 *
 * A walk rather than a bucketing, because `parentCandidates` has already sorted the list so each
 * type's options sit together — and bucketing would throw away the path ordering *within* a type
 * that its stable sort exists to preserve. `<optgroup>` requires contiguity anyway, so trusting the
 * incoming order and asserting it here are the same thing.
 */
function groupByType(parents: ParentOption[]): { typeName: string; parents: ParentOption[] }[] {
  const groups: { typeName: string; parents: ParentOption[] }[] = [];

  for (const parent of parents) {
    const current = groups.at(-1);
    if (current && current.typeName === parent.typeName) current.parents.push(parent);
    else groups.push({ typeName: parent.typeName, parents: [parent] });
  }

  return groups;
}

export default function ItemEditor({
  itemId,
  contentTypeId,
  contentTypeName,
  fields,
  initial,
  parents,
  parentTotal,
  itemPath,
  termsByTaxonomy,
  relationTargets,
  blockTypes,
  reusableBlocks,
  canPublish,
  isHierarchical,
  media = [],
  snippets = [],
  referencedMedia = [],
  defaultOgImage = null,
  path = '/',
  origin = '',
  release = null,
  preview = null,
  releases = null,
  actions = null,
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
  const [previewOpen, setPreviewOpen] = useState(preview?.open ?? false);

  /**
   * The pane's open state is read from `<html>`, not owned here.
   *
   * The control that toggles it is the icon in the page header, which is server-rendered Astro and
   * therefore outside this island. Rather than invent a channel between the two, both use the
   * attribute the layout already stamps from the cookie: the button writes it, this observes it, and
   * the CSS that widens the container reads the same thing. One value, one writer.
   *
   * An observer rather than a click handler because there is no element here to bind to — and it
   * survives anything else that comes to set the attribute later.
   */
  useEffect(() => {
    if (!preview) return;

    const root = document.documentElement;
    const sync = () => setPreviewOpen(root.dataset.preview === 'open');
    sync();

    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-preview'] });
    return () => observer.disconnect();
  }, [preview]);

  /**
   * Split at `xl`, swap below it.
   *
   * A field column and a live preview genuinely need two columns; at 375px there is room for one.
   * So below `xl` the same control becomes a switch — preview open means the form is hidden and the
   * pane has the screen, and vice versa — rather than stacking a preview under a long form where it
   * would update off-screen, out of sight of the person typing.
   *
   * `hidden` (`display: none`), never off-screen positioning: a form that is merely moved keeps
   * every one of its inputs in the tab order behind the preview.
   *
   * Class strings are written out whole rather than assembled, because Tailwind 4 finds classes by
   * scanning source text.
   */
  const splitting = Boolean(preview) && previewOpen;
  const layoutClass = splitting
    ? 'grid gap-8 xl:grid-cols-[26rem_minmax(0,1fr)] xl:items-start'
    // Not a grid when closed. The pane still renders — its `id` has to stay resolvable for the
    // header button's `aria-controls` — and an empty grid row would leave `gap-8` of dead space
    // under the form on every screen that never opens a preview.
    : '';

  /**
   * Hidden below `xl` while the preview has the screen; always shown from `xl` up, where both fit.
   *
   * **What goes with the form is the sticky bar, and the eye icon is in it.** Hiding this therefore
   * hides the control that would put it back — which for two phases left a phone with an open
   * preview and no way out of it short of navigating away and losing the edit. `PreviewPane` renders
   * its own "Back to editing" below `xl` for exactly that reason; anything else that becomes the
   * only route out of a state must not be inside the thing that state hides.
   */
  const formHiddenClass = splitting ? 'hidden xl:block' : '';

  /**
   * What can be done from where the item *is*, not from what the form currently shows.
   *
   * The API compares against the row in the database, so measuring from local state would offer a
   * chain of moves — draft to review to published in one save — that the boundary would refuse as
   * a single jump. One save is one transition.
   */
  const transitions = transitionsFrom(initial.status);

  /**
   * Split into the one promoted button and everything else.
   *
   * `primaryTransition` may answer `undefined` — a published page has no forward move worth
   * promoting — in which case every transition is in the menu and its trigger says "Change status…"
   * rather than "More…".
   */
  const primaryTo = primaryTransition(initial.status, canPublish);
  const primary = transitions.find((transition) => transition.to === primaryTo);
  const others = transitions.filter((transition) => transition.to !== primaryTo);

  /**
   * Adding to a release, from the sidebar rather than a banner at the top of the page.
   *
   * It used to be a no-JS form of one submit button per open release, which is why the comment it
   * replaced argued for `formaction`. That argument was about the *page*, and this screen's page
   * already cannot be used without JavaScript — the whole editor is an island, and Save is in it. So
   * the trade here is placement against a no-JS path that this particular screen never had.
   *
   * The gain is not only placement: the old buttons posted a form and redirected to the release
   * screen, discarding whatever was unsaved. This is a fetch, so you stay on the item.
   */
  const [releaseTarget, setReleaseTarget] = useState('');
  const [newReleaseName, setNewReleaseName] = useState('');
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseNote, setReleaseNote] = useState<string | null>(null);

  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  const closeStatusMenu = useCallback(() => setStatusMenuOpen(false), []);
  useDismissable(statusMenuRef, statusMenuOpen, closeStatusMenu);

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

  async function addToRelease() {
    if (!itemId || !releaseTarget) return;
    setReleaseBusy(true);
    setReleaseNote(null);

    try {
      let releaseId = releaseTarget;
      let releaseName = releases?.addable.find((entry) => entry.id === releaseTarget)?.name ?? '';

      if (releaseTarget === '__new') {
        const created = await fetch('/api/taproot/releases', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: newReleaseName.trim() }),
        });
        if (!created.ok) {
          setReleaseNote('Could not create that release.');
          return;
        }
        // Two calls rather than a new endpoint: create, then stage into what was created.
        const body = (await created.json()) as { release: { id: string; name: string } };
        releaseId = body.release.id;
        releaseName = body.release.name;
      }

      const staged = await fetch(`/api/taproot/releases/${releaseId}/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentItemId: itemId }),
      });

      setReleaseNote(
        staged.ok
          ? `Added to ${releaseName}. Your unsaved edits here are untouched.`
          : 'Could not add this item to that release.',
      );
      if (staged.ok) {
        setReleaseTarget('');
        setNewReleaseName('');
      }
    } catch {
      setReleaseNote('Could not reach the server.');
    } finally {
      setReleaseBusy(false);
    }
  }

  function setValue(apiId: string, value: unknown) {
    setData((current) => ({ ...current, [apiId]: value }));
  }

  return (
    <div className={layoutClass}>
      {/*
        `@container` on the rail so the field controls inside can size against *this column* rather
        than the viewport. In split mode the rail is 26rem while the viewport is ≥1280px, so a
        viewport-keyed `sm:grid-cols-2` inside a field config would fire on a 416px column — the
        breakpoint measuring the wrong box, which is the one place that mismatch actually bites.
      */}
      <form onSubmit={save} className={`@container min-w-0 ${formHiddenClass}`}>
        {/*
          One bar, always, and it spans both columns.

          It used to appear only in split mode, where the sidebar stacks below the fields and Save
          would otherwise sit past every one of them. The same is true of a long form in any mode, so
          it is unconditional now — and because it must span, the form is a column with the bar first
          and the two-column grid inside it, rather than the bar being one cell of that grid.

          Offset by `--admin-topbar-h` rather than pinned at `top: 0`: below `lg` the shell's own
          sticky bar is already there. `z-10` keeps it under every overlay and under `PageHeader`'s
          20 — see the note in `PreviewPane`, which sits at `xl:z-0` specifically to stay out of the
          stacking context this bar's `backdrop-blur` creates.
        */}
        <div
          className="sticky z-10 -mx-1 mb-6 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface/95 px-1 py-2 backdrop-blur"
          style={{ top: 'var(--admin-topbar-h)' }}
        >
          <span
            className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_META[status].badgeClass}`}
          >
            {STATUS_META[status].label}
          </span>

          <div className="flex items-center gap-2">
            {actions && (
              <EditorActionIcons
                previewable={actions.previewable}
                previewOpen={previewOpen}
                onTogglePreview={(open) => writePreviewPaneState(open)}
                showReferences={actions.showReferences}
                showDelete={actions.showDelete}
              />
            )}
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {busy ? 'Saving…' : release ? 'Save to release' : itemId ? 'Save changes' : 'Create item'}
            </button>
          </div>
        </div>

        <div className={splitting ? 'space-y-6' : 'grid gap-8 lg:grid-cols-[1fr_18rem]'}>
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

          {/*
            Conditionally hidden fields are filtered out here rather than being passed to
            `FieldControl` for it to hide itself. Filtering in the parent is what keeps
            `FieldControl` a component that renders one field and knows nothing about its siblings —
            and it means a hidden field's control never mounts, so a richtext editor inside one is
            not built and torn down as somebody ticks a box.

            `isFieldVisible` is the same function `validateItemData` calls on the server. Two
            implementations would eventually disagree, and the shape of that disagreement is a field
            an editor cannot see and cannot save without.
          */}
          {fields
            .filter((field) => isFieldVisible(field, fields, data))
            .map((field) => (
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
              snippets={snippets}
            />
            ))}
        </section>
      </div>

      {/* Sidebar ---------------------------------------------------------- */}
      {/*
        `min-w-0` is not decoration. A grid item defaults to `min-width: auto`, which refuses to
        shrink below its content's min-content width — so this column sized itself to its widest
        child and pushed the whole page sideways at 320px. Every other flex and grid child in this
        admin already carries it; this one was missed because it never had a narrow viewport to fail
        in.
      */}
      <aside className="min-w-0 space-y-6">
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
              One named action, and the rest behind "More".

              Named acts rather than a status dropdown, still: a `<select>` of statuses asks an
              editor to know that "in_review" is how you submit something and that archived pages
              come back as drafts — the workflow was in the model and nowhere in the interface. That
              argument is about the *labels*, and the labels are unchanged. What changed is that four
              full-width buttons were most of this sidebar, and on any given edit three of them are
              rare. Which one is promoted comes from `primaryTransition` in core, beside the table it
              reads, rather than from whichever key this loop reaches first.

              Offered from the same table the API enforces, filtered to legal moves and then to the
              ones this role may make, so the screen cannot offer something the boundary refuses.
            */}
            {/*
              `role="group"` + `aria-labelledby`, so "Status" still names these controls now that
              they are no longer a `<ul>`. The span cannot become a `<label for>` — a group is not a
              labelable element, and `scripts/a11y-audit.mjs` checks exactly that.
            */}
            <div
              role="group"
              aria-labelledby={`${formId}-status-label`}
              className="mt-2 space-y-1.5"
            >
              {primary && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setStatus(primary.to)}
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50 ${
                    status === primary.to
                      ? 'border-accent bg-accent-subtle'
                      : 'border-border-strong hover:bg-surface-sunken'
                  }`}
                >
                  {transitionLabel(initial.status, primary.to)}
                  {status === primary.to && initial.status !== primary.to && (
                    // A staged intent, not the act — nothing moves until Save, and saying so is what
                    // stops someone leaving the page thinking it did.
                    <span className="ml-1 font-normal text-content-muted">— on save</span>
                  )}
                </button>
              )}

              {others.length > 0 && (
                <div ref={statusMenuRef} className="relative">
                  <button
                    type="button"
                    disabled={busy}
                    aria-expanded={statusMenuOpen}
                    aria-controls={`${formId}-status-menu`}
                    onClick={() => setStatusMenuOpen((wasOpen) => !wasOpen)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-sm text-content-muted transition-colors hover:bg-surface-sunken disabled:opacity-50"
                  >
                    {primary ? 'More…' : 'Change status…'}
                    <ChevronDown aria-hidden="true" className="h-4 w-4" />
                  </button>

                  {/*
                    Rendered only when open, unlike the Astro menus which toggle `hidden`. React
                    controls this subtree, so there is no server-rendered state for the audit to
                    find either way — `ItemEditor.test.tsx` covers it instead.
                  */}
                  {statusMenuOpen && (
                    <ul
                      id={`${formId}-status-menu`}
                      className="absolute left-0 right-0 top-full z-30 mt-1 space-y-0.5 rounded-lg border border-border bg-surface-raised p-1 shadow-lg"
                    >
                      {others.map(({ to, role }) => {
                        const blocked = !canPublish && role === 'editor';
                        return (
                          <li key={to}>
                            <button
                              type="button"
                              disabled={blocked || busy}
                              aria-describedby={blocked ? `${formId}-role-note` : undefined}
                              onClick={() => {
                                setStatus(to);
                                setStatusMenuOpen(false);
                              }}
                              className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 ${
                                status === to
                                  ? 'bg-accent-subtle font-medium'
                                  : 'hover:bg-surface-sunken'
                              }`}
                            >
                              {transitionLabel(initial.status, to)}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}

              {status !== initial.status && (
                <button
                  type="button"
                  onClick={() => setStatus(initial.status)}
                  className="w-full rounded-md px-3 py-1.5 text-left text-sm text-content-muted transition-colors hover:bg-surface-sunken"
                >
                  Keep as {STATUS_META[initial.status].label.toLowerCase()}
                </button>
              )}
            </div>

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
              {/*
                A searchable picker rather than a `<select>` of every page-kind item.

                The old control listed `parent.path` and nothing else — so on a site with a real
                tree it was a column of URLs with the titles, which is what an editor actually knows
                a page by, absent entirely. `ItemPicker` puts the title first and the path under it,
                and searches past the first page so a deep item is reachable at all.
              */}
              <ItemPicker
                id={`${formId}-parent`}
                value={parentId}
                onChange={setParentId}
                options={groupByType(parents).flatMap((group) =>
                  group.parents.map((parent) => ({
                    id: parent.id,
                    title: parent.title,
                    path: parent.path,
                    groupLabel: group.typeName,
                  })),
                )}
                total={parentTotal}
                // The same narrowing `parentCandidates` applies server-side, so the first page and
                // everything found past it are drawn from one set.
                searchParams={{ contentTypeKinds: 'page' }}
                excludeIds={itemId ? [itemId] : []}
                excludeSubtreeOf={itemPath ?? null}
                emptyLabel="Top level"
                noun="page"
                describedBy={`${formId}-parent-hint`}
              />
              <p id={`${formId}-parent-hint`} className="mt-1.5 text-xs text-content-subtle">
                Moving a page rewrites the URLs of everything beneath it and leaves redirects.
              </p>
            </div>
          )}

          {itemId && releases && (releases.addable.length > 0 || releases.canCreate) && (
            <div className="mt-4 border-t border-border pt-4">
              <label htmlFor={`${formId}-release`} className="block text-sm font-medium">
                Add to a release
              </label>
              <p className="mt-0.5 text-xs text-content-subtle">
                Takes a copy of the content as it is now. You then edit that copy without the live
                page changing.
              </p>

              <select
                id={`${formId}-release`}
                value={releaseTarget}
                onChange={(event) => setReleaseTarget(event.target.value)}
                className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
              >
                <option value="">— Choose a release —</option>
                {releases.addable.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
                {/* Creating is editor-only; staging is not. Two gates, because they are two acts. */}
                {releases.canCreate && <option value="__new">New release…</option>}
              </select>

              {releaseTarget === '__new' && (
                <input
                  aria-label="New release name"
                  placeholder="Name the release"
                  value={newReleaseName}
                  onChange={(event) => setNewReleaseName(event.target.value)}
                  className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
                />
              )}

              <button
                type="button"
                disabled={
                  releaseBusy ||
                  !releaseTarget ||
                  (releaseTarget === '__new' && newReleaseName.trim().length === 0)
                }
                onClick={() => void addToRelease()}
                className="mt-2 w-full rounded-md border border-border-strong px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-sunken disabled:opacity-50"
              >
                {releaseBusy ? 'Adding…' : 'Add to release'}
              </button>

              {/*
                Polite, and it stays on the page. The old buttons redirected to the release screen,
                which is also why this editor's `?staged=` flash could never actually appear.
              */}
              <p role="status" aria-live="polite" className="mt-1.5 text-xs text-content-muted">
                {releaseNote}
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
        </div>
      </form>

      {/*
        After the form, and that is a hard requirement rather than a layout preference.

        An `<iframe>` puts everything inside it into the sequential tab order, and **no attribute
        takes it back out** — `tabindex="-1"` removes the element, not its contents. With the pane
        between the fields and the sidebar, an editor tabbing out of the Title input lands in the
        previewed site's own navigation. Last in the DOM and placed to the right by the grid is the
        only arrangement where "edit, then look" is also the focus order.
      */}
      {preview && itemId && (
        <PreviewPane
          itemId={itemId}
          releaseId={release?.id ?? null}
          title={title}
          slug={slug}
          data={data}
          seo={pruneSeo(seo)}
          itemPath={path}
          siteConfigured={preview.siteConfigured}
          open={previewOpen}
          onClose={() => writePreviewPaneState(false)}
        />
      )}
    </div>
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
