import { useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ExternalLink, FileText, Globe, Link2Off, Paperclip, X } from 'lucide-react';

import { LinkTargetSearch, type LinkTarget } from './LinkTargetSearch.js';
import { MediaPicker } from '../media/MediaPicker.js';
import type { MediaOption } from '../../mediaOptions.js';

/**
 * Everything about one link, in one dialog.
 *
 * It replaces a row of controls that wrapped inside the editor's own toolbar strip. That layout was
 * not merely ugly: the editor column is around 400px with the preview pane open, and an address
 * box, a page search, two checkboxes and two buttons will never fit across it — so the thing an
 * author was being asked to read was three words wide. A dialog is the only one of the obvious
 * shapes whose width does not depend on how wide the field happens to be.
 *
 * It also answers a question the old form could not. Opening it on an existing link showed an empty
 * box and a placeholder saying a page was linked, never *which* page, and the file path did not
 * even do that much — the picker opened with nothing selected, so editing a link to a prospectus
 * looked exactly like adding one. The target is resolved and shown at the top, with the way to
 * open it and the way to remove it beside it.
 */

/**
 * The reference shape, mirrored from `sanitizeHtml`'s `TAPROOT_REF`.
 *
 * Used to choose which panel opens and how the current target is resolved. The sanitiser remains
 * the authority on what may be stored — a reference this got wrong would be dropped there rather
 * than saved malformed — so this copy decides presentation and nothing else.
 */
const TAPROOT_REF = /^taproot:(item|media):([0-9a-f-]{36})$/i;

export type LinkMode = 'page' | 'file' | 'url';

export interface LinkOptions {
  newTab: boolean;
  noFollow: boolean;
}

/** The link mark's attributes as TipTap reports them, or null when there is no link at the caret. */
export interface CurrentLink {
  href: string;
  target: string | null;
  rel: string | null;
}

interface Reference {
  kind: 'item' | 'media';
  id: string;
}

export function parseReference(href: string | undefined): Reference | null {
  const match = TAPROOT_REF.exec(href ?? '');
  if (!match) return null;
  return { kind: match[1]!.toLowerCase() as 'item' | 'media', id: match[2]! };
}

/** Which panel a given href belongs to, so opening an existing link lands on its own kind. */
export function linkModeFor(href: string | undefined): LinkMode {
  const reference = parseReference(href);
  if (reference?.kind === 'item') return 'page';
  if (reference?.kind === 'media') return 'file';
  return 'url';
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The link the caret sits in. Null when there is none, which is the "add a link" case. */
  current: CurrentLink | null;
  /** Which panel to open on. The paperclip button opens straight onto files. */
  initialMode: LinkMode;
  /** The media library's first page, for the picker every other field uses. */
  media: MediaOption[];
  /** `label` is the text to insert when the caret is collapsed and the link has to carry its own. */
  onApply: (href: string, label: string, options: LinkOptions) => void;
  onRemove: () => void;
}

export function LinkDialog({
  open,
  onOpenChange,
  current,
  initialMode,
  media,
  onApply,
  onRemove,
}: Props) {
  const id = useId();
  const [mode, setMode] = useState<LinkMode>(initialMode);
  const [url, setUrl] = useState(current && !parseReference(current.href) ? current.href : '');
  const [page, setPage] = useState<LinkTarget | null>(null);
  const [file, setFile] = useState<MediaOption | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newTab, setNewTab] = useState(current?.target === '_blank');
  const [noFollow, setNoFollow] = useState(/nofollow/.test(current?.rel ?? ''));
  const contentRef = useRef<HTMLDivElement>(null);

  const resolved = useResolvedTarget(open ? current?.href : undefined);

  /**
   * Files are offered when there is a library to offer, or when this link already points at one.
   *
   * The second half matters for the same reason the resolved card does: a link to a file has to be
   * editable even from a screen whose library page happens not to include that asset.
   */
  const fileMode = media.length > 0 || parseReference(current?.href)?.kind === 'media';
  const modes = MODES.filter((entry) => entry.value !== 'file' || fileMode);

  /** What Apply would produce, or null when the chosen panel has nothing in it yet. */
  const pending = ((): { href: string; label: string } | null => {
    if (mode === 'page') {
      if (page) return { href: `taproot:item:${page.id}`, label: page.title };
      // No new choice, but the link already points at a page: Apply then means "keep the target,
      // take the options I just changed", which is the only way to tick "new tab" on an existing
      // link without re-finding the page it points at.
      if (parseReference(current?.href)?.kind === 'item') {
        return { href: current!.href, label: resolved.label ?? 'this page' };
      }
      return null;
    }

    if (mode === 'file') {
      if (file) return { href: `taproot:media:${file.id}`, label: file.filename };
      if (parseReference(current?.href)?.kind === 'media') {
        return { href: current!.href, label: resolved.label ?? 'this file' };
      }
      return null;
    }

    const typed = url.trim();
    // The address is the label: with nothing selected a link has to show something, and the address
    // is all this panel knows about where it goes.
    return typed ? { href: typed, label: typed } : null;
  })();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    /**
     * `stopPropagation` as well, and it is not belt and braces.
     *
     * Radix portals this dialog to `document.body`, so it is nowhere near the item editor in the
     * DOM — but React propagates events through the *React* tree, not the DOM one, and the React
     * tree still has the editor's `<form onSubmit={save}>` above it. Without this, pressing Apply
     * saved the whole content item and redirected: the link never landed, and what an author saw
     * was the page reloading with their link missing. `preventDefault` does not help, because the
     * outer handler is a React handler doing its own thing rather than a native submit.
     */
    event.stopPropagation();
    if (!pending) return;
    onApply(pending.href, pending.label, { newTab, noFollow });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          ref={contentRef}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[min(34rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-surface-raised shadow-xl"
          aria-describedby={`${id}-description`}
          /*
            Focus the panel's own control, not the close button.

            Radix's default is the first tabbable thing inside, which here is the ✕ — so a dialog
            opened to type an address opened with focus on the way out of it. The panels mark their
            primary control with `data-autofocus` rather than each of them being handed a ref,
            because the one that needs it lives inside `LinkTargetSearch` and this is not a thing
            that component should have to know about.

            Only on open. Switching panels afterwards deliberately leaves focus on the radio group,
            which is where someone using the arrow keys still is.
          */
          onOpenAutoFocus={(event) => {
            const target = contentRef.current?.querySelector<HTMLElement>('[data-autofocus]');
            if (!target) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div>
                <Dialog.Title className="text-base font-semibold">
                  {current ? 'Edit link' : 'Add a link'}
                </Dialog.Title>
                <Dialog.Description
                  id={`${id}-description`}
                  className="mt-0.5 text-xs text-content-subtle"
                >
                  Links to a page or a file follow it if it is renamed or moved.
                </Dialog.Description>
              </div>
              <Dialog.Close
                className="rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
                aria-label="Close without changing the link"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Dialog.Close>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {current && <CurrentTarget id={id} resolved={resolved} onRemove={onRemove} />}

              {/*
                A radio group, not a tablist, though it is drawn as one.

                Three panels behind three controls is the shape of tabs, and hand-built tabs are one
                of the reliable ways to ship a keyboard trap: roving tabindex, arrow wrapping, and
                the tab/panel relationship all have to be written by hand and stay written. A radio
                group is the same interaction — arrow keys move and switch, Tab leaves for the panel
                — from the platform, announced as "1 of 3", and with nothing to keep in step. The
                house rule about custom widgets is what settles it: off-the-shelf behaviour rarely
                fails, hand-built behaviour is where WCAG failures creep in.
              */}
              <fieldset className={current ? 'mt-4' : ''}>
                <legend className="text-xs font-medium">What should this link to?</legend>
                <div className="mt-1.5 flex gap-0.5 rounded-md border border-border-strong bg-surface p-0.5">
                  {modes.map((entry) => {
                    const Icon = entry.icon;
                    const active = mode === entry.value;
                    return (
                      <label
                        key={entry.value}
                        className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded px-2 py-1.5 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
                          active
                            ? 'bg-accent-subtle font-medium text-content'
                            : 'text-content-muted hover:bg-surface-sunken'
                        }`}
                      >
                        {/*
                          Hidden rather than absent: the input is what makes this a radio group at
                          all, and the ring is carried by the label through `has-[:focus-visible]`
                          because the control it would otherwise sit on cannot be seen.
                        */}
                        <input
                          type="radio"
                          name={`${id}-mode`}
                          value={entry.value}
                          checked={active}
                          onChange={() => setMode(entry.value)}
                          className="sr-only"
                        />
                        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {entry.label}
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {/* One height for every panel, so switching between them does not resize the dialog
                  under the pointer that is still moving between the three controls. */}
              <div className="mt-4 min-h-56">
                {mode === 'page' && (
                  <LinkTargetSearch
                    id={`${id}-page`}
                    chosen={page}
                    onPick={setPage}
                    onClear={() => setPage(null)}
                  />
                )}

                {mode === 'file' && (
                  <FilePanel
                    chosen={file}
                    current={parseReference(current?.href)?.kind === 'media' ? resolved : null}
                    onChoose={() => setPickerOpen(true)}
                  />
                )}

                {mode === 'url' && (
                  <div>
                    <label htmlFor={`${id}-url`} className="block text-xs font-medium">
                      Link address
                    </label>
                    <input
                      id={`${id}-url`}
                      value={url}
                      data-autofocus
                      placeholder="/admissions or https://example.edu"
                      aria-describedby={`${id}-url-hint`}
                      onChange={(event) => setUrl(event.target.value)}
                      className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2.5 py-2 text-sm"
                    />
                    <p id={`${id}-url-hint`} className="mt-1.5 text-xs text-content-subtle">
                      A path on this site, or a full address including <code>https://</code>. An
                      address typed here is stored as typed, so it breaks if that page later moves —
                      link to a page instead where you can.
                    </p>
                  </div>
                )}
              </div>

              <fieldset className="mt-4 border-t border-border pt-4">
                <legend className="sr-only">Link options</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={newTab}
                    onChange={(event) => setNewTab(event.target.checked)}
                  />
                  Open in a new tab
                </label>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={noFollow}
                    onChange={(event) => setNoFollow(event.target.checked)}
                  />
                  {/* Said as what it does rather than as `nofollow`, which means nothing to most of
                      the people writing here. */}
                  Tell search engines not to follow
                </label>
              </fieldset>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
              <p className="text-xs text-content-subtle">{pending ? '' : WAITING_FOR[mode]}</p>
              <div className="flex shrink-0 gap-2">
                <Dialog.Close className="rounded-md border border-border-strong px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-sunken">
                  Cancel
                </Dialog.Close>
                <button
                  type="submit"
                  disabled={!pending}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:opacity-60"
                >
                  Apply
                </button>
              </div>
            </div>
          </form>

          {/*
            Nested inside this dialog rather than replacing it, so a file chosen here comes back to
            a form that still holds the options that were ticked before the picker opened.

            It is the same picker every other place an asset is chosen uses — the media field, the
            SEO panel, a content type's social card — because a fourth bespoke chooser is the thing
            that rule exists to prevent. `selected` carries the file this link already points at,
            which is what makes reopening it show a selection rather than a blank grid.
          */}
          {pickerOpen && (
            <MediaPicker
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              library={media}
              selected={selectedFileIds(file, current)}
              noun="file"
              onConfirm={(assets) => {
                setPickerOpen(false);
                if (assets[0]) setFile(assets[0]);
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const MODES = [
  { value: 'page', label: 'Page', icon: FileText },
  { value: 'file', label: 'File', icon: Paperclip },
  { value: 'url', label: 'Web address', icon: Globe },
] as const satisfies readonly { value: LinkMode; label: string; icon: typeof FileText }[];

/** What the footer says while Apply is unavailable — the reason, rather than a dead button. */
const WAITING_FOR: Record<LinkMode, string> = {
  page: 'Search for the page to link to.',
  file: 'Choose the file to link to.',
  url: 'Type an address to link to.',
};

function selectedFileIds(file: MediaOption | null, current: CurrentLink | null): string[] {
  if (file) return [file.id];
  const reference = parseReference(current?.href);
  return reference?.kind === 'media' ? [reference.id] : [];
}

// --- The link as it stands ---------------------------------------------------

interface ResolvedTarget {
  kind: LinkMode;
  /** The human name: a page title, a filename, or the address itself. */
  label: string | null;
  /** The line underneath: a path, a file type, or nothing. */
  detail: string | null;
  /** Where the "open" control goes, or null while it is still being resolved. */
  openHref: string | null;
  openLabel: string;
  /** True once a reference has been looked up and found to point at nothing. */
  missing: boolean;
}

function CurrentTarget({
  id,
  resolved,
  onRemove,
}: {
  id: string;
  resolved: ResolvedTarget;
  onRemove: () => void;
}) {
  const Icon = resolved.kind === 'page' ? FileText : resolved.kind === 'file' ? Paperclip : Globe;

  return (
    <section
      aria-labelledby={`${id}-current`}
      className="rounded-md border border-border bg-surface px-3 py-3"
    >
      <h3 id={`${id}-current`} className="text-xs font-medium text-content-subtle">
        Currently links to
      </h3>
      <div className="mt-1.5 flex items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-content-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm font-medium ${resolved.missing ? 'text-warning' : ''}`}>
            {resolved.label ?? 'Looking it up…'}
          </p>
          {resolved.detail && (
            <p className="truncate font-mono text-xs text-content-subtle">{resolved.detail}</p>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {resolved.openHref && (
          <a
            href={resolved.openHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-surface-sunken"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            {resolved.openLabel}
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-surface-sunken"
        >
          <Link2Off className="h-3.5 w-3.5" aria-hidden="true" />
          Remove link
        </button>
      </div>
    </section>
  );
}

/**
 * Resolve a stored href into something worth reading.
 *
 * A reference is correct and unreadable — `taproot:item:0199…` tells an author nothing about which
 * page they are about to replace — so the id is exchanged for a title through the same endpoints
 * the relation field and the media field already use. An address needs no lookup and reports
 * itself immediately, which is why the fetch is skipped rather than run and discarded.
 */
function useResolvedTarget(href: string | undefined): ResolvedTarget {
  const reference = parseReference(href);
  const [state, setState] = useState<ResolvedTarget>(() => initialTarget(href));

  useEffect(() => {
    setState(initialTarget(href));
    if (!reference) return;

    let cancelled = false;
    (async () => {
      try {
        const response =
          reference.kind === 'item'
            ? await fetch(`/api/taproot/items/${reference.id}`, {
                headers: { accept: 'application/json' },
              })
            : await fetch(`/api/taproot/media?ids=${reference.id}`, {
                headers: { accept: 'application/json' },
              });
        if (!response.ok) throw new Error(String(response.status));

        const body = (await response.json()) as {
          item?: { id: string; title: string; path: string };
          media?: { id: string; filename: string; url: string; mime_type: string }[];
        };
        if (cancelled) return;

        if (reference.kind === 'item' && body.item) {
          setState({
            kind: 'page',
            label: body.item.title,
            detail: body.item.path,
            // The editor, not the site: this deployment serves the admin and the API and has no
            // opinion about what a consumer's URL for that page is. Its own screen is a thing it
            // can always link to correctly.
            openHref: `/admin/content/${body.item.id}`,
            openLabel: 'Open in the editor',
            missing: false,
          });
          return;
        }

        const asset = body.media?.[0];
        if (reference.kind === 'media' && asset) {
          setState({
            kind: 'file',
            label: asset.filename,
            detail: asset.mime_type,
            openHref: asset.url,
            openLabel: 'Open the file',
            missing: false,
          });
          return;
        }

        setState(brokenTarget(reference.kind, href!));
      } catch {
        if (!cancelled) setState(brokenTarget(reference.kind, href!));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [href]);

  return state;
}

function initialTarget(href: string | undefined): ResolvedTarget {
  const reference = parseReference(href);
  if (!reference) {
    return {
      kind: 'url',
      label: href ?? null,
      detail: null,
      openHref: href ?? null,
      openLabel: 'Open the address',
      missing: false,
    };
  }
  // Deliberately no `openHref` yet: a reference cannot be opened until it has been resolved into
  // something with a URL, and a control that appears a moment later is better than one that 404s.
  return {
    kind: reference.kind === 'item' ? 'page' : 'file',
    label: null,
    detail: null,
    openHref: null,
    openLabel: '',
    missing: false,
  };
}

/**
 * A reference that resolves to nothing.
 *
 * Said plainly rather than hidden: at delivery an unresolvable link simply unwraps — the text
 * stays and the `<a>` goes — so an author who is never told sees a link in the editor and no link
 * on the site, with nothing connecting the two.
 */
function brokenTarget(kind: 'item' | 'media', href: string): ResolvedTarget {
  return {
    kind: kind === 'item' ? 'page' : 'file',
    label: kind === 'item' ? 'This page no longer exists' : 'This file is no longer in the library',
    detail: href,
    openHref: null,
    openLabel: '',
    missing: true,
  };
}

// --- The file panel ----------------------------------------------------------

function FilePanel({
  chosen,
  current,
  onChoose,
}: {
  chosen: MediaOption | null;
  /** The file this link already points at, when it points at one. */
  current: ResolvedTarget | null;
  onChoose: () => void;
}) {
  const name = chosen?.filename ?? (current?.missing ? null : current?.label);
  const detail = chosen?.mimeType ?? (current?.missing ? null : current?.detail);

  return (
    <div>
      <p className="text-xs font-medium">File</p>
      <div className="mt-1.5 rounded-md border border-border-strong bg-surface px-3 py-3">
        {name ? (
          <div className="flex items-start gap-2.5">
            <Paperclip className="mt-0.5 h-4 w-4 shrink-0 text-content-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{name}</p>
              {detail && <p className="truncate text-xs text-content-subtle">{detail}</p>}
            </div>
          </div>
        ) : (
          <p className="text-sm text-content-subtle">No file chosen.</p>
        )}
        <button
          type="button"
          onClick={onChoose}
          /* Opened by the paperclip, this is the panel's own control — see `onOpenAutoFocus`. */
          data-autofocus
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-sunken"
        >
          <Paperclip className="h-4 w-4" aria-hidden="true" />
          {name ? 'Choose a different file' : 'Choose a file'}
        </button>
      </div>
      <p className="mt-1.5 text-xs text-content-subtle">
        Stored as a reference to the asset, so replacing the file in the library keeps every link to
        it working.
      </p>
    </div>
  );
}

export default LinkDialog;
