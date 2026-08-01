import { useEffect, useMemo, useRef, useState } from 'react';
import {
  checkItemAccessibility,
  countBySeverity,
  referencedMediaIds,
  type A11yIssue,
  type A11yMediaInfo,
  type FieldRow,
} from '@taprootcms/core';

import type { BlockTypeOption, ReusableBlockOption } from './fields/BlockListEditor.js';
import type { MediaOption } from '../mediaOptions.js';

/**
 * The accessibility issues in what the editor currently holds.
 *
 * **Live rather than on save**, which is the whole reason this is an island: a skipped heading and
 * a link reading "click here" are things somebody is typing right now, and a checker that only
 * speaks after a round trip is one they find out about at the end of writing, when the fix costs
 * more than the mistake did.
 *
 * **It never blocks anything.** There is no gate here on Save and none on the publish buttons
 * above it, deliberately — see `checkItemAccessibility`.
 *
 * The rules live in core so this panel and the site-wide report cannot drift; what belongs here is
 * only how they are shown.
 */

interface Props {
  fields: FieldRow[];
  /** The editor's live field values — the same object it will save. */
  data: Record<string, unknown>;
  /**
   * Media the item already references, resolved server-side.
   *
   * Not the library's first page: an item can point at an asset uploaded a year ago, and reading
   * alt text from the page on hand would report every one of those as undescribed. Assets chosen
   * during this session arrive through `library`, and anything still unresolved is fetched.
   */
  referencedMedia?: MediaOption[];
  /** The picker's current page, so an asset chosen just now is already known. */
  library?: MediaOption[];
  blockTypes?: BlockTypeOption[];
  reusableBlocks?: ReusableBlockOption[];
}

export default function AccessibilityPanel({
  fields,
  data,
  referencedMedia = [],
  library = [],
  blockTypes = [],
  reusableBlocks = [],
}: Props) {
  /**
   * Maps are rebuilt from arrays rather than passed in.
   *
   * Astro serialises island props as JSON, and a `Map` does not survive that — it arrives as `{}`,
   * which is an empty lookup rather than an error, so every image would quietly report as
   * undescribed.
   */
  const registry = useMemo(
    () => ({
      blockTypes: new Map(blockTypes.map((type) => [type.api_id, { name: type.name, fields: type.fields }])),
      reusableBlocks: new Map(
        reusableBlocks.map((entry) => [
          entry.id,
          { id: entry.id, name: entry.name, type: entry.block_type, data: entry.data },
        ]),
      ),
    }),
    [blockTypes, reusableBlocks],
  );

  const [fetched, setFetched] = useState<Record<string, A11yMediaInfo>>({});

  const altById = useMemo(() => {
    const map = new Map<string, A11yMediaInfo>();
    for (const asset of [...referencedMedia, ...library]) map.set(asset.id, toInfo(asset));
    for (const [id, info] of Object.entries(fetched)) map.set(id, info);
    return map;
  }, [referencedMedia, library, fetched]);

  const wanted = useMemo(
    () => referencedMediaIds(fields, data, registry),
    [fields, data, registry],
  );

  /**
   * Assets picked during this session that neither list covers — searched for past the first page
   * of the library, so the picker resolved them and this panel never saw them.
   *
   * `attempted` is a ref rather than state because an id the server does not return must not be
   * asked for again: a deleted asset would otherwise be re-fetched on every keystroke, forever.
   */
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    const missing = wanted.filter((id) => !altById.has(id) && !attempted.current.has(id));
    if (missing.length === 0) return;

    for (const id of missing) attempted.current.add(id);

    let cancelled = false;
    fetch(`/api/taproot/media?ids=${missing.map(encodeURIComponent).join(',')}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { media?: ApiMedia[] } | null) => {
        if (cancelled || !body?.media) return;
        setFetched((current) => {
          const next = { ...current };
          for (const row of body.media!) {
            next[row.id] = { filename: row.filename, mimeType: row.mime_type, altText: row.alt_text };
          }
          return next;
        });
      })
      // A failed lookup leaves those ids unresolved, and an unresolved id is simply not reported.
      // Better a rule that says nothing than one that accuses an image because the network blipped.
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [wanted, altById]);

  const issues = useMemo(
    () => checkItemAccessibility(fields, data, { ...registry, altById }),
    [fields, data, registry, altById],
  );

  const { errors, warnings } = countBySeverity(issues);

  return (
    <section
      aria-labelledby="a11y-panel-heading"
      className="rounded-lg border border-border bg-surface-raised p-4"
    >
      <h2 id="a11y-panel-heading" className="text-sm font-semibold">
        Accessibility
      </h2>

      {/*
        Polite, not assertive. This changes on almost every keystroke, and an assertive region
        interrupts whatever a screen reader is reading — including the sentence being typed.
      */}
      <p className="mt-1 text-sm text-content-muted" aria-live="polite">
        {summary(errors, warnings)}
      </p>

      {issues.length > 0 && (
        <ul className="mt-3 space-y-3">
          {issues.map((issue, index) => (
            <li key={`${issue.rule}-${issue.location}-${index}`} className="text-sm">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span
                  className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${
                    issue.severity === 'error'
                      ? 'border-danger bg-danger-subtle'
                      : 'border-warning bg-warning-subtle'
                  }`}
                >
                  {/*
                    The word as well as the colour. A bare colour swatch is a WCAG 1.4.1 failure,
                    which is a poor thing for an accessibility panel to be.
                  */}
                  {issue.severity === 'error' ? 'Error' : 'Warning'}
                </span>
                <FieldLink issue={issue} fields={fields} />
              </p>
              <p className="mt-0.5 text-content-muted">{issue.message}</p>
              {issue.inheritedFrom && (
                <p className="mt-0.5 text-xs text-content-subtle">
                  This content belongs to the reusable block{' '}
                  <a href={`/admin/blocks/${issue.inheritedFrom.id}`} className="underline">
                    {issue.inheritedFrom.name}
                  </a>
                  , so it is fixed there and every page using it changes.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {issues.length > 0 && (
        <p className="mt-3 text-xs text-content-subtle">
          Nothing here stops you saving or publishing. It is what a visitor using a screen reader
          would run into.
        </p>
      )}
    </section>
  );
}

/**
 * The location, linked to the field it came from where there is one to link to.
 *
 * `field.id` is what `FieldControl` builds its DOM ids from, and the label carries `-label` in
 * every branch — the control's own id does not exist for the group-shaped types. The link is
 * therefore aimed at the label, which is the part that is always rendered.
 */
function FieldLink({ issue, fields }: { issue: A11yIssue; fields: FieldRow[] }) {
  const field = fields.find((candidate) => candidate.api_id === issue.fieldApiId);

  if (!field) return <span className="font-medium">{issue.location}</span>;

  return (
    <a href={`#field-${field.id}-label`} className="font-medium underline">
      {issue.location}
    </a>
  );
}

function summary(errors: number, warnings: number): string {
  if (errors === 0 && warnings === 0) return 'No issues found.';

  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
  if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);

  return `${parts.join(' and ')} to look at.`;
}

interface ApiMedia {
  id: string;
  filename: string;
  alt_text: string | null;
  mime_type: string;
}

function toInfo(asset: MediaOption): A11yMediaInfo {
  return { filename: asset.filename, mimeType: asset.mimeType, altText: asset.altText };
}
