import { useEffect, useRef, useState } from 'react';
import { FIELD_SORTS, ITEM_SORTS, ITEM_SORT_LABELS, type ItemSort } from '@taprootcms/core';

import type { TermOption } from './FieldControl.js';

/**
 * The editing control for a `query` field: a rule, and a live look at what it currently answers.
 *
 * **The preview is the feature, not decoration.** Every other field shows an editor what they typed;
 * this one shows them what somebody else's content does in response to a rule they cannot see the
 * effect of otherwise. Without it, "six soonest Arts events" is a form that could equally be
 * returning nothing, and the first anyone finds out is on the published page.
 *
 * It deliberately shows the **count** as well as the first few titles: the count is what tells an
 * editor whether their filter is too narrow, and it is the number that changes when somebody
 * publishes something new.
 */

export interface QueryValue {
  termIds: string[];
  sort: ItemSort;
  limit: number;
  dateFilter: 'any' | 'upcoming' | 'past';
}

const DATE_FILTER_LABELS: Record<QueryValue['dateFilter'], string> = {
  any: 'Any date',
  upcoming: 'Still to come',
  past: 'Already happened',
};

interface Match {
  id: string;
  title: string;
  path: string;
}

export function QueryField({
  id,
  labelledBy,
  describedBy,
  value,
  onChange,
  targetContentTypeId,
  terms,
  maxResults,
  dateFieldApiId = null,
  disabled = false,
  invalid = false,
}: {
  id?: string;
  labelledBy?: string;
  describedBy?: string;
  value: QueryValue;
  onChange: (next: QueryValue) => void;
  /** Null when the field has not been pointed at a content type yet. */
  targetContentTypeId: string | null;
  /** Terms of the taxonomy the admin allowed, already flattened with depth. Empty offers no filter. */
  terms: TermOption[];
  maxResults: number;
  /**
   * The date field the admin nominated, if any. Null hides the date window *and* both field orders,
   * because "soonest first" with nothing to sort by is an option that silently does nothing.
   */
  dateFieldApiId?: string | null;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  /** Drops a stale response that arrives after a newer one, the pattern `RelationField` uses. */
  const ticket = useRef(0);

  useEffect(() => {
    if (!targetContentTypeId) return;

    const mine = ++ticket.current;
    const params = new URLSearchParams({
      contentTypeId: targetContentTypeId,
      sort: value.sort,
      limit: String(Math.min(value.limit, maxResults)),
      // The preview has to answer the question delivery will answer, and delivery never shows a
      // visitor a draft — so a listing tuned against drafts would promise results that vanish on
      // publish.
      visibleOnly: '1',
    });
    if (value.termIds.length) params.set('termIds', value.termIds.join(','));
    if (dateFieldApiId) {
      params.set('dateField', dateFieldApiId);
      if (value.dateFilter !== 'any') params.set('dateFilter', value.dateFilter);
    }

    let cancelled = false;
    fetch(`/api/taproot/items?${params}`, { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('failed'))))
      .then((body: { items: Match[]; total: number }) => {
        if (cancelled || mine !== ticket.current) return;
        setMatches(body.items);
        setTotal(body.total);
        setFailed(false);
      })
      .catch(() => {
        if (cancelled || mine !== ticket.current) return;
        setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [
    targetContentTypeId,
    value.termIds.join(','),
    value.sort,
    value.limit,
    value.dateFilter,
    dateFieldApiId,
    maxResults,
  ]);

  if (!targetContentTypeId) {
    return (
      <p
        id={id}
        className="mt-1.5 rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-content-subtle"
      >
        This listing has not been pointed at a content type yet. Choose one in its configuration
        under Settings → Content types, and the filters appear here.
      </p>
    );
  }

  const toggleTerm = (termId: string, checked: boolean) =>
    onChange({
      ...value,
      termIds: checked
        ? [...value.termIds, termId]
        : value.termIds.filter((entry) => entry !== termId),
    });

  return (
    <div
      id={id}
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`mt-1.5 space-y-4 rounded-md border px-3 py-3 ${
        invalid ? 'border-danger' : 'border-border-strong'
      }`}
    >
      {terms.length > 0 && (
        <fieldset disabled={disabled}>
          {/*
            Named generically rather than by the taxonomy's own plural. Carrying the name here
            would mean threading a second lookup map through the item editor, the block editor and
            the repeater purely for a legend — and the terms listed underneath already say what
            kind of thing they are.
          */}
          <legend className="text-xs font-medium text-content-subtle">Filter by term</legend>
          <p className="mt-0.5 text-xs text-content-subtle">
            Choosing none lists everything. Choosing a term also includes everything filed beneath
            it.
          </p>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
            {terms.map((term) => (
              <label key={term.id} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={value.termIds.includes(term.id)}
                  onChange={(event) => toggleTerm(term.id, event.target.checked)}
                />
                <span style={{ paddingInlineStart: `${term.depth * 0.75}rem` }}>{term.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="flex flex-wrap items-end gap-3">
        {dateFieldApiId && (
          <div className="min-w-40 flex-1">
            <label htmlFor={`${id}-date`} className="block text-xs font-medium">
              Date
            </label>
            <select
              id={`${id}-date`}
              disabled={disabled}
              value={value.dateFilter}
              onChange={(event) =>
                onChange({ ...value, dateFilter: event.target.value as QueryValue['dateFilter'] })
              }
              className="mt-1 w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm"
            >
              {(Object.keys(DATE_FILTER_LABELS) as QueryValue['dateFilter'][]).map((option) => (
                <option key={option} value={option}>
                  {DATE_FILTER_LABELS[option]}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="min-w-40 flex-1">
          <label htmlFor={`${id}-sort`} className="block text-xs font-medium">
            Order
          </label>
          <select
            id={`${id}-sort`}
            disabled={disabled}
            value={value.sort}
            onChange={(event) => onChange({ ...value, sort: event.target.value as ItemSort })}
            className="mt-1 w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm"
          >
            {/*
              The two field orders are offered only when there is a field to order by. Listing them
              regardless would mean "Soonest first" quietly falling back to site order — an option
              that appears to work and does nothing.
            */}
            {ITEM_SORTS.filter((sort) => dateFieldApiId || !FIELD_SORTS.includes(sort)).map(
              (sort) => (
                <option key={sort} value={sort}>
                  {ITEM_SORT_LABELS[sort]}
                </option>
              ),
            )}
          </select>
        </div>

        <div className="min-w-28">
          <label htmlFor={`${id}-limit`} className="block text-xs font-medium">
            How many
          </label>
          <input
            id={`${id}-limit`}
            type="number"
            min={1}
            max={maxResults}
            disabled={disabled}
            value={value.limit}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next) || next < 1) return;
              onChange({ ...value, limit: Math.min(next, maxResults) });
            }}
            className="mt-1 w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      {/*
        `aria-live` because this changes in response to the controls above without anything moving
        focus — the same reason the block and repeater editors announce a reorder.
      */}
      <div aria-live="polite" className="rounded-md border border-border bg-surface-sunken p-3">
        {failed ? (
          <p className="text-xs text-content-subtle">
            Could not reach the server to preview this listing. The rule is still saved.
          </p>
        ) : total === null ? (
          <p className="text-xs text-content-subtle">Checking what this matches…</p>
        ) : total === 0 ? (
          <p className="text-xs text-content-subtle">
            Nothing matches this yet. Published items appear here as they are added — a listing that
            is empty today fills itself in without anyone editing this page.
          </p>
        ) : (
          <>
            <p className="text-xs font-medium">
              {total} {total === 1 ? 'match' : 'matches'}
              {total > (matches?.length ?? 0) && `, showing the first ${matches?.length ?? 0}`}
            </p>
            <ol className="mt-1.5 space-y-0.5">
              {(matches ?? []).map((match) => (
                <li key={match.id} className="truncate text-xs text-content-muted">
                  {match.title}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}

export default QueryField;
