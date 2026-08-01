import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ImagePlus, Trash2 } from 'lucide-react';

import type { MediaOption } from '../../mediaOptions.js';
import { MediaPicker } from './MediaPicker.js';

/**
 * The control that shows what is chosen and opens the picker.
 *
 * Split from the picker itself because three call sites need this half and only one dialog:
 * a `media` field, the SEO panel's social image, and a content type's default social card. They
 * differ in wording and in whether an empty value inherits something, not in behaviour.
 *
 * There is no drag-and-drop reordering. The house rule is that dragging is added *alongside*
 * keyboard controls, never instead of them, and for a list that is almost always one or two items
 * the buttons are the whole feature rather than the fallback.
 */

export interface MediaFieldProps {
  /** Placed on the group, so the field's `<label for>` has a target that exists. */
  id?: string;
  /** The field label's id. A group cannot be named by `<label for>`, so it is named by this. */
  labelledBy?: string;
  describedBy?: string;
  /** Ordered asset ids. Single-value fields use a one-element array. */
  value: string[];
  onChange: (ids: string[]) => void;
  /** The library's first page, resolved server-side. */
  library: MediaOption[];
  accept?: string[];
  multiple?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  canUpload?: boolean;
  /** What is being chosen, lowercase: "image", "file", "social image". */
  noun?: string;
  /**
   * Shown when nothing is chosen — a content type's default social card, say. Rendering the
   * inherited value rather than an empty box is what makes inheritance visible; an editor who
   * cannot see what they would get by leaving a field alone sets it unnecessarily.
   */
  inherited?: { asset: MediaOption | null; note: string } | null;
}

export function MediaField({
  id,
  labelledBy,
  describedBy,
  value,
  onChange,
  library,
  accept,
  multiple = false,
  disabled = false,
  invalid = false,
  canUpload = true,
  noun = 'image',
  inherited = null,
}: MediaFieldProps) {
  const [open, setOpen] = useState(false);
  /**
   * Assets learned beyond the server-passed page: older ones resolved by id, and anything uploaded
   * inside the dialog. Without this a field pointing at the 200th-newest asset would have no
   * thumbnail to render, since the library page only carries the most recent handful.
   */
  const [extra, setExtra] = useState<MediaOption[]>([]);

  const known = useMemo(() => {
    const map = new Map<string, MediaOption>();
    for (const asset of [...library, ...extra]) map.set(asset.id, asset);
    return map;
  }, [library, extra]);

  /**
   * Ids already looked up, successfully or not.
   *
   * Without this, an id that resolves to nothing — a deleted asset — is still missing after the
   * fetch, so the effect's own condition stays true and it refetches on every render forever.
   * A ref rather than state because learning we looked something up should not cause a render.
   */
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    const unknown = value.filter(
      (entry) => !known.has(entry) && !attempted.current.has(entry),
    );
    if (unknown.length === 0) return;
    for (const entry of unknown) attempted.current.add(entry);

    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/taproot/media?ids=${unknown.join(',')}`, {
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return;
        const body = (await response.json()) as { media: ApiMedia[] };
        if (!cancelled) setExtra((current) => [...current, ...body.media.map(fromApi)]);
      } catch {
        // A thumbnail that will not resolve is a degraded control, not a broken one: the id is
        // still stored, still saved, and still shown below as a missing asset.
      }
    })();

    return () => {
      cancelled = true;
    };
    // Keyed by the ids themselves: the parent rebuilds the array every render, so depending on
    // its identity would refire this on every keystroke elsewhere in the editor.
  }, [value.join(','), known]);

  const chosen = value.map((entry) => ({ id: entry, asset: known.get(entry) ?? null }));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  return (
    <div
      id={id}
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`mt-1.5 rounded-md border px-3 py-3 ${
        invalid ? 'border-danger' : 'border-border-strong'
      } ${disabled ? 'opacity-90' : ''}`}
    >
      {chosen.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          {inherited?.asset ? (
            <>
              <img
                src={inherited.asset.url}
                alt=""
                className="h-14 w-20 shrink-0 rounded border border-border object-cover"
              />
              <p className="min-w-40 flex-1 text-xs text-content-subtle">{inherited.note}</p>
            </>
          ) : (
            <p className="min-w-40 flex-1 text-sm text-content-subtle">
              {inherited?.note ?? `No ${noun} chosen.`}
            </p>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-sunken disabled:opacity-60"
          >
            <ImagePlus className="h-4 w-4" aria-hidden="true" />
            Choose {multiple ? `${noun}s` : `a${startsWithVowel(noun) ? 'n' : ''} ${noun}`}
          </button>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {chosen.map((entry, index) => (
              <li key={`${entry.id}-${index}`} className="flex items-center gap-3">
                {entry.asset ? (
                  entry.asset.mimeType.startsWith('image/') ? (
                    /* Decorative: the filename beside it is the accessible name for this row. */
                    <img
                      src={entry.asset.url}
                      alt=""
                      className="h-12 w-16 shrink-0 rounded border border-border object-cover"
                    />
                  ) : (
                    <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded border border-border bg-surface-sunken text-[0.625rem] text-content-subtle">
                      {entry.asset.mimeType.split('/')[1] ?? 'file'}
                    </span>
                  )
                ) : (
                  <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded border border-dashed border-border text-[0.625rem] text-content-subtle">
                    ?
                  </span>
                )}

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {entry.asset?.filename ?? 'Asset no longer in the library'}
                  </p>
                  {entry.asset?.mimeType.startsWith('image/') && !entry.asset.altText && (
                    <p className="text-xs text-warning">
                      Missing alt text — add it in Media so screen readers can describe it.
                    </p>
                  )}
                </div>

                {multiple && chosen.length > 1 && (
                  <div className="flex shrink-0 gap-1">
                    <IconButton
                      label={`Move ${entry.asset?.filename ?? 'this file'} up`}
                      disabled={disabled || index === 0}
                      onClick={() => move(index, index - 1)}
                    >
                      <ChevronUp className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={`Move ${entry.asset?.filename ?? 'this file'} down`}
                      disabled={disabled || index === chosen.length - 1}
                      onClick={() => move(index, index + 1)}
                    >
                      <ChevronDown className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                  </div>
                )}

                <IconButton
                  label={`Remove ${entry.asset?.filename ?? 'this file'}`}
                  disabled={disabled}
                  onClick={() => onChange(value.filter((_, position) => position !== index))}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setOpen(true)}
              className="rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-sunken disabled:opacity-60"
            >
              {multiple ? `Add or reorder ${noun}s` : `Replace ${noun}`}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange([])}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-content-muted transition-colors hover:bg-surface-sunken disabled:opacity-60"
            >
              {inherited ? 'Use the default' : 'Remove'}
            </button>
          </div>
        </>
      )}

      {/*
        Mounted only while open. Radix renders the dialog into a portal, and keeping a closed one
        around costs a subscription per media field on a page that can carry a dozen of them.
      */}
      {open && (
        <MediaPicker
          open={open}
          onOpenChange={setOpen}
          library={library}
          accept={accept}
          multiple={multiple}
          selected={value}
          canUpload={canUpload}
          noun={noun}
          onConfirm={(assets) => {
            setExtra((current) => [...current, ...assets.filter((asset) => !known.has(asset.id))]);
            onChange(assets.map((asset) => asset.id));
          }}
        />
      )}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded-md border border-border p-1.5 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-40"
    >
      {children}
    </button>
  );
}

interface ApiMedia {
  id: string;
  filename: string;
  url: string;
  alt_text: string | null;
  mime_type: string;
  width: number | null;
  height: number | null;
}

function fromApi(row: ApiMedia): MediaOption {
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

function startsWithVowel(word: string): boolean {
  return /^[aeiou]/i.test(word);
}

export default MediaField;
