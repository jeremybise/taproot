import { useState } from 'react';
import { FileText, Globe, Link2, Pencil } from 'lucide-react';

import { LinkDialog, linkModeFor, useResolvedTarget, type LinkOptions } from './LinkDialog.js';
import type { MediaOption } from '../../mediaOptions.js';

/**
 * The editor for a `link` field.
 *
 * **It is `LinkDialog`, unchanged.** Rich text already had to solve every part of this — find a page
 * by title, pick a file from the library, type an address, and say whether it opens in a new tab —
 * and an editor who has linked a word in a paragraph has already learned this dialog. A second
 * interface for the same act is how somebody ends up unsure which one does what.
 *
 * What lives here is only the translation. The dialog speaks `href` with the `taproot:item:{id}`
 * references rich text stores; the field stores `{ kind, id | href, … }`, because a structured field
 * has no reason to make a consumer parse a string to find an id. `toHref`/`fromApply` are that
 * conversion and nothing else — see `linkValueSchema` in core for why the stored shape is the way
 * round it is.
 */

export interface LinkValue {
  kind: 'item' | 'media' | 'url';
  /** Present for `item` and `media`. Resolved through the delivery response's lookup maps. */
  id?: string;
  /** Present for `url`. */
  href?: string;
  label?: string;
  newTab?: boolean;
  noFollow?: boolean;
}

interface Props {
  id?: string;
  labelledBy?: string;
  describedBy?: string;
  value: LinkValue | null;
  onChange: (value: LinkValue | null) => void;
  /** The library's first page, for the dialog's file panel. */
  media: MediaOption[];
  /** Which destinations this field permits. Empty means all three. */
  allowedKinds?: string[];
  disabled?: boolean;
  invalid?: boolean;
}

/** The stored value as the dialog wants it: one href string. */
function toHref(value: LinkValue | null): string | undefined {
  if (!value) return undefined;
  if (value.kind === 'item' && value.id) return `taproot:item:${value.id}`;
  if (value.kind === 'media' && value.id) return `taproot:media:${value.id}`;
  return value.href;
}

/** And back again, which is where the reference becomes an id rather than staying a string. */
function fromApply(href: string, label: string, options: LinkOptions): LinkValue {
  const reference = /^taproot:(item|media):([0-9a-f-]{36})$/i.exec(href);

  const common = {
    // The dialog always produces a label — for a typed address it is the address itself, which is
    // a sensible thing to *show* in prose and a poor button label, so an author is free to clear it.
    label: label.trim() || undefined,
    newTab: options.newTab,
    noFollow: options.noFollow,
  };

  if (reference) {
    return { kind: reference[1]!.toLowerCase() as 'item' | 'media', id: reference[2]!, ...common };
  }
  return { kind: 'url', href: href.trim(), ...common };
}

export function LinkField({
  id,
  labelledBy,
  describedBy,
  value,
  onChange,
  media,
  allowedKinds = [],
  disabled = false,
  invalid = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const href = toHref(value);
  const resolved = useResolvedTarget(href);

  /**
   * A group rather than a labelable control, so the field's label points here by `aria-labelledby`.
   * `<label for>` on a `<div>` is silently inert — the rule `scripts/a11y-audit.mjs` checks.
   */
  return (
    <div
      id={id}
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`mt-1.5 rounded-md border px-3 py-2.5 ${
        invalid ? 'border-danger' : 'border-border-strong'
      }`}
    >
      {value ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-sm font-medium">
              <KindIcon kind={value.kind} />
              {/* The author's own label wins: it is what a visitor will read. */}
              {value.label ?? resolved.label ?? 'Looking it up…'}
            </p>
            <p
              className={`truncate text-xs ${resolved.missing ? 'text-warning' : 'text-content-subtle'}`}
            >
              {resolved.missing
                ? 'This link points at something that no longer exists.'
                : (resolved.detail ?? resolved.label ?? '')}
            </p>
            {value.newTab && (
              <p className="mt-0.5 text-xs text-content-subtle">Opens in a new tab</p>
            )}
          </div>

          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={disabled}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-surface-sunken disabled:opacity-60"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Edit
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-sm font-medium transition-colors hover:bg-surface-sunken disabled:opacity-60"
        >
          <Link2 className="h-4 w-4" aria-hidden="true" />
          Choose a link
        </button>
      )}

      <LinkDialog
        open={open}
        onOpenChange={setOpen}
        current={href ? { href, target: value?.newTab ? '_blank' : null, rel: value?.noFollow ? 'nofollow' : null } : null}
        initialMode={initialMode(href, allowedKinds)}
        media={allowedKinds.length > 0 && !allowedKinds.includes('media') ? [] : media}
        onApply={(nextHref, label, options) => {
          onChange(fromApply(nextHref, label, options));
          setOpen(false);
        }}
        onRemove={() => {
          // Clearing the field, not clearing a mark: there is no surrounding text to keep.
          onChange(null);
          setOpen(false);
        }}
      />
    </div>
  );
}

/**
 * Which panel opens.
 *
 * An existing link opens on its own kind; a new one opens on the first kind this field allows, so a
 * field restricted to pages does not open on an address box it will refuse.
 */
function initialMode(href: string | undefined, allowedKinds: string[]) {
  if (href) return linkModeFor(href);
  if (allowedKinds.includes('item')) return 'page' as const;
  if (allowedKinds.includes('media')) return 'file' as const;
  if (allowedKinds.includes('url')) return 'url' as const;
  return 'page' as const;
}

function KindIcon({ kind }: { kind: LinkValue['kind'] }) {
  const Icon = kind === 'media' ? FileText : kind === 'url' ? Globe : Link2;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-content-muted" aria-hidden="true" />;
}

export default LinkField;
