import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Search, Upload, X } from 'lucide-react';
import { mediaMatchesAccept } from '@taproot/core';

import type { MediaOption } from '../../mediaOptions.js';

/**
 * The media library picker: a grid with search and upload in place.
 *
 * One component for every place an asset is chosen — the media field, the SEO panel's social
 * image, and a content type's default social card. Those were three `<select>`s of filenames,
 * which is a usable control only for someone who already knows what `quad-autumn-2.jpg` looks
 * like. Building one picker rather than three is why the `<select>`s shipped in the first place.
 *
 * The grid is a listbox rather than a grid of buttons or checkboxes. A checkbox per card gives
 * every asset its own tab stop, so reaching the twelfth image costs twelve presses; a listbox is
 * one tab stop with arrow keys inside it, which is the pattern a screen-reader user already
 * expects from "choose from a set of things".
 */

export interface MediaPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The first page of assets, resolved server-side so the grid is populated on first paint. */
  library: MediaOption[];
  /** MIME prefixes this field accepts, e.g. `['image/']`. Empty accepts anything. */
  accept?: string[];
  multiple?: boolean;
  /** Ids already chosen, so reopening shows the current selection rather than a blank slate. */
  selected: string[];
  /**
   * Resolved assets rather than ids: the caller has to render a thumbnail for what was chosen,
   * and an asset uploaded inside the dialog is not in the server-passed library.
   */
  onConfirm: (assets: MediaOption[]) => void;
  canUpload?: boolean;
  /** What is being chosen, lowercase, for button and dialog wording. */
  noun?: string;
}

export function MediaPicker({
  open,
  onOpenChange,
  library,
  accept,
  multiple = false,
  selected,
  onConfirm,
  canUpload = true,
  noun = 'image',
}: MediaPickerProps) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [assets, setAssets] = useState<MediaOption[]>(library);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>(selected);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [status, setStatus] = useState('');

  const gridRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  /**
   * Every asset this dialog has shown, not just the page currently on screen.
   *
   * Selection outlives the grid: choose an image, search for a second one, and the first is no
   * longer among the results. Resolving the confirmed ids against the visible page instead would
   * drop it silently — the footer would still count it, so the only evidence would be the page
   * afterwards. A ref because remembering an asset should not cause a render.
   */
  const seen = useRef(new Map<string, MediaOption>());
  useEffect(() => {
    for (const asset of [...library, ...assets]) seen.current.set(asset.id, asset);
  }, [library, assets]);

  const acceptKey = (accept ?? []).join(',');

  /**
   * The server-passed page is filtered client-side by the same rule the query uses.
   *
   * The SEO panel and a `media` field share one server fetch, so the list arriving here is wider
   * than some fields accept. Filtering with `mediaMatchesAccept` rather than a local copy of the
   * rule is what stops the first page from offering something a search for the same term would not.
   */
  const visible = useMemo(
    () => assets.filter((asset) => mediaMatchesAccept(asset.mimeType, accept)),
    [assets, acceptKey],
  );

  // Reopening starts from what is currently stored, not from where the last visit was left.
  useEffect(() => {
    if (open) {
      setDraft(selected);
      setActiveIndex(0);
      setError(null);
    }
  }, [open]);

  /**
   * Search goes to the server, because the point of a picker is a library too big to eyeball and
   * the server-passed page is only the most recent 60. Debounced so typing does not queue a
   * request per keystroke; the empty query short-circuits back to the page already in hand.
   */
  useEffect(() => {
    if (!open) return;

    if (query.trim() === '') {
      setAssets(library);
      setTotal(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ q: query.trim(), limit: '60' });
        if (acceptKey) params.set('accept', acceptKey);

        const response = await fetch(`/api/taproot/media?${params}`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`Search failed (${response.status})`);

        const body = (await response.json()) as { media: ApiMedia[]; total: number };
        // The API returns raw rows; the island's shape uses camelCase and a resolved URL.
        const results = body.media.map(fromApi);
        setAssets(results);
        setTotal(body.total);
        setActiveIndex(0);
        setStatus(
          `${body.total} ${body.total === 1 ? 'asset matches' : 'assets match'} “${query.trim()}”.`,
        );
        setError(null);
      } catch (cause) {
        if ((cause as Error).name === 'AbortError') return;
        setError('Could not search the library. The assets already loaded are still selectable.');
      } finally {
        setLoading(false);
      }
    }, 200);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, open, acceptKey, library]);

  const toggle = useCallback(
    (asset: MediaOption) => {
      setDraft((current) => {
        if (!multiple) return current[0] === asset.id ? [] : [asset.id];
        return current.includes(asset.id)
          ? current.filter((entry) => entry !== asset.id)
          : [...current, asset.id];
      });
    },
    [multiple],
  );

  const confirm = (ids: string[] = draft) => {
    // Preserve the order the editor selected in, which for a gallery is the order it renders in.
    const chosen = ids
      .map((entry) => seen.current.get(entry) ?? assets.find((asset) => asset.id === entry))
      .filter((asset): asset is MediaOption => Boolean(asset));
    onConfirm(chosen);
    onOpenChange(false);
  };

  const onGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const columns = columnCount(optionElements(gridRef.current));
    const last = visible.length - 1;
    let next = activeIndex;

    switch (event.key) {
      case 'ArrowRight':
        next = Math.min(activeIndex + 1, last);
        break;
      case 'ArrowLeft':
        next = Math.max(activeIndex - 1, 0);
        break;
      case 'ArrowDown':
        next = Math.min(activeIndex + columns, last);
        break;
      case 'ArrowUp':
        next = Math.max(activeIndex - columns, 0);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case ' ':
        event.preventDefault();
        if (visible[activeIndex]) toggle(visible[activeIndex]);
        return;
      case 'Enter': {
        event.preventDefault();
        const asset = visible[activeIndex];
        if (!asset) return;
        // Single choice is one decision, so Enter finishes it. Multiple needs more than one
        // press by definition, so Enter toggles and the Choose button ends the interaction.
        if (multiple) toggle(asset);
        else confirm([asset.id]);
        return;
      }
      default:
        return;
    }

    event.preventDefault();
    setActiveIndex(next);
    optionElements(gridRef.current)[next]?.focus();
  };

  const chosenCount = draft.length;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(60rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-surface-raised shadow-xl"
          aria-describedby={`${id}-description`}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold">
                Choose {multiple ? `${noun}s` : `a${startsWithVowel(noun) ? 'n' : ''} ${noun}`}
              </Dialog.Title>
              <Dialog.Description id={`${id}-description`} className="mt-0.5 text-xs text-content-subtle">
                {multiple
                  ? 'Select as many as you need. They keep the order you choose them in.'
                  : 'Select one, then choose.'}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
              aria-label="Close without choosing"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Dialog.Close>
          </div>

          {/* Search + upload ------------------------------------------------ */}
          <div className="flex flex-wrap items-end gap-3 border-b border-border px-5 py-3">
            <div className="min-w-56 flex-1">
              <label htmlFor={`${id}-search`} className="block text-xs font-medium">
                Search the library
              </label>
              <div className="relative mt-1">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-content-subtle"
                  aria-hidden="true"
                />
                <input
                  id={`${id}-search`}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filename or alt text"
                  className="w-full rounded-md border border-border-strong bg-surface py-2 pl-8 pr-3 text-sm"
                />
              </div>
            </div>

            {canUpload && (
              <button
                type="button"
                onClick={() => setUploadOpen((value) => !value)}
                aria-expanded={uploadOpen}
                aria-controls={`${id}-upload`}
                className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-sunken"
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                Upload a file
              </button>
            )}
          </div>

          {canUpload && uploadOpen && (
            <UploadPanel
              id={`${id}-upload`}
              accept={accept}
              onUploaded={(asset) => {
                setAssets((current) => [asset, ...current]);
                setDraft((current) => (multiple ? [...current, asset.id] : [asset.id]));
                setUploadOpen(false);
                setStatus(`Uploaded ${asset.filename} and selected it.`);
              }}
              onError={setError}
            />
          )}

          {/* Grid ----------------------------------------------------------- */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div role="status" aria-live="polite" className="sr-only-focusable">
              {status}
            </div>

            {error && (
              <p role="alert" className="mb-3 rounded-md border border-danger bg-danger-subtle px-3 py-2 text-sm">
                {error}
              </p>
            )}

            {visible.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-content-muted">
                {loading
                  ? 'Searching…'
                  : query.trim()
                    ? `Nothing in the library matches “${query.trim()}”.`
                    : `No ${noun}s in the library yet.`}
              </p>
            ) : (
              <div
                ref={gridRef}
                role="listbox"
                aria-label="Media library"
                aria-multiselectable={multiple || undefined}
                onKeyDown={onGridKeyDown}
                className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
              >
                {visible.map((asset, index) => {
                  const isSelected = draft.includes(asset.id);
                  const position = draft.indexOf(asset.id) + 1;

                  return (
                    <div
                      key={asset.id}
                      role="option"
                      aria-selected={isSelected}
                      /* One tab stop for the whole grid; arrow keys move within it. */
                      tabIndex={index === activeIndex ? 0 : -1}
                      onFocus={() => setActiveIndex(index)}
                      onClick={() => toggle(asset)}
                      onDoubleClick={() => !multiple && confirm([asset.id])}
                      className={`cursor-pointer overflow-hidden rounded-lg border text-left transition-colors ${
                        isSelected
                          ? 'border-accent ring-2 ring-accent'
                          : 'border-border hover:border-border-strong'
                      }`}
                    >
                      <div className="relative flex aspect-4/3 items-center justify-center bg-surface-sunken">
                        {asset.mimeType.startsWith('image/') ? (
                          /* Decorative: the filename below is this option's accessible name, and
                             repeating it as alt would have a screen reader announce it twice. */
                          <img
                            src={asset.url}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="px-2 text-center text-xs text-content-subtle">
                            {asset.mimeType}
                          </span>
                        )}
                        {isSelected && (
                          /*
                            A tick, not just the ring. Selection has to survive being seen without
                            colour (WCAG 1.4.1), and the number carries the order for multi-select
                            — which is the whole reason order is preserved on confirm.
                          */
                          <span className="absolute right-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold text-accent-content">
                            {multiple ? position : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                          </span>
                        )}
                      </div>
                      <div className="px-2.5 py-2">
                        <p className="truncate text-xs font-medium" title={asset.filename}>
                          {asset.filename}
                        </p>
                        {asset.mimeType.startsWith('image/') && !asset.altText && (
                          <p className="mt-0.5 text-xs text-warning">Missing alt text</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {total !== null && total > visible.length && (
              <p className="mt-4 text-center text-xs text-content-subtle">
                Showing {visible.length} of {total} matches. Narrow the search to see the rest.
              </p>
            )}
          </div>

          {/* Footer --------------------------------------------------------- */}
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
            <p className="text-xs text-content-subtle">
              {chosenCount === 0
                ? 'Nothing selected.'
                : multiple
                  ? `${chosenCount} selected.`
                  : `1 selected.`}
            </p>
            <div className="flex gap-2">
              <Dialog.Close className="rounded-md border border-border-strong px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-sunken">
                Cancel
              </Dialog.Close>
              <button
                type="button"
                onClick={() => confirm()}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:opacity-60"
              >
                {chosenCount === 0
                  ? 'Clear selection'
                  : multiple
                    ? `Choose ${chosenCount}`
                    : 'Choose'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Upload without leaving the dialog.
 *
 * Alt text sits here rather than only on the library screen because this is the moment someone
 * knows what the image is for. An upload path that never asks is how a library fills with images
 * nobody can describe later, and alt text is what the Phase 4 checker reads.
 */
function UploadPanel({
  id,
  accept,
  onUploaded,
  onError,
}: {
  id: string;
  accept?: string[];
  onUploaded: (asset: MediaOption) => void;
  onError: (message: string | null) => void;
}) {
  const fieldId = useId();
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [alt, setAlt] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      onError('Choose a file to upload.');
      return;
    }

    setBusy(true);
    onError(null);
    try {
      const body = new FormData();
      body.set('file', file);
      body.set('alt', alt);

      // `accept: application/json` matters: the endpoint redirects browsers back to the library
      // instead of returning the row, which is right for its plain HTML form and wrong here.
      const response = await fetch('/api/taproot/media', {
        method: 'POST',
        body,
        headers: { accept: 'application/json' },
      });
      const payload = (await response.json()) as { media?: unknown; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Upload failed (${response.status})`);

      onUploaded(fromApi(payload.media as ApiMedia));
      setAlt('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      id={id}
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3 border-b border-border bg-surface-sunken px-5 py-3"
    >
      <div className="min-w-48 flex-1">
        <label htmlFor={`${fieldId}-file`} className="block text-xs font-medium">
          File
        </label>
        <input
          id={`${fieldId}-file`}
          ref={fileRef}
          type="file"
          accept={(accept ?? []).map((prefix) => (prefix.endsWith('/') ? `${prefix}*` : prefix)).join(',') || undefined}
          className="mt-1 w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm"
        />
      </div>
      <div className="min-w-48 flex-1">
        <label htmlFor={`${fieldId}-alt`} className="block text-xs font-medium">
          Alt text
        </label>
        <input
          id={`${fieldId}-alt`}
          value={alt}
          onChange={(event) => setAlt(event.target.value)}
          aria-describedby={`${fieldId}-alt-hint`}
          placeholder="What the image conveys"
          className="mt-1 w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm"
        />
        <p id={`${fieldId}-alt-hint`} className="mt-0.5 text-xs text-content-subtle">
          Leave blank only if it is purely decorative.
        </p>
      </div>
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:opacity-60"
      >
        {busy ? 'Uploading…' : 'Upload'}
      </button>
    </form>
  );
}

// --- helpers ----------------------------------------------------------------

interface ApiMedia {
  id: string;
  filename: string;
  url: string;
  alt_text: string | null;
  mime_type: string;
  width: number | null;
  height: number | null;
}

/** The REST shape is the database row; the islands use camelCase. */
function fromApi(row: ApiMedia | MediaOption): MediaOption {
  if ('mimeType' in row) return row;
  return {
    id: row.id,
    filename: row.filename,
    url: row.url,
    altText: row.alt_text,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
  };
}

function optionElements(container: HTMLElement | null): HTMLElement[] {
  return container ? Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')) : [];
}

/**
 * How many cards sit on a row, measured rather than assumed.
 *
 * The grid is responsive, so the number belongs to a breakpoint; hardcoding it here would drift
 * the moment the CSS changed. Returns 1 when it cannot be measured — no layout, as under jsdom,
 * or genuinely one row — and the arrow keys then walk the list linearly. That is a degradation
 * rather than a break: every card stays reachable and no key does nothing.
 */
function columnCount(items: HTMLElement[]): number {
  if (items.length < 2) return 1;
  const firstTop = items[0].offsetTop;
  const nextRow = items.findIndex((item) => item.offsetTop !== firstTop);
  return nextRow > 0 ? nextRow : 1;
}

function startsWithVowel(word: string): boolean {
  return /^[aeiou]/i.test(word);
}

export default MediaPicker;
