import type { ContentStatus } from '@taproot/core';

/**
 * How each content status presents in the admin.
 *
 * One module rather than a constant per screen, because a status that is amber in a list and grey
 * in the editor teaches editors that the colour means nothing. The item editor imports the same
 * labels it renders in its status select.
 */
/**
 * Presentation only. Which statuses a role may *set* is a permission question and lives in
 * `runtime/guards.ts`.
 *
 * This module used to carry a `needsPublish` flag as well. The editor's status select honoured it,
 * but the three API routes that enforce publishing each hardcoded `status === 'published'` instead
 * — so the one place naming the rule was the one place not enforcing it, and `scheduled` and
 * `archived` were gated in the dropdown and open at the boundary.
 */
export interface StatusMeta {
  label: string;
  /**
   * Tailwind classes for the badge, written out in full on purpose.
   *
   * Tailwind 4 finds classes by scanning source text, so a class assembled at runtime
   * (`bg-status-${status}-subtle`) is never generated and the badge renders unstyled. These have
   * to stay literal strings.
   */
  badgeClass: string;
  /**
   * Whether the editor offers this status.
   *
   * `scheduled` is storable and the API accepts it, but nothing yet flips a scheduled item live,
   * so offering it in the editor would promise a behaviour that does not exist. It still gets a
   * colour and a filter option so items created through the API are visible rather than invisible.
   */
  settable: boolean;
}

export const STATUS_ORDER = [
  'draft',
  'in_review',
  'scheduled',
  'published',
  'archived',
] as const satisfies readonly ContentStatus[];

export const STATUS_META: Record<ContentStatus, StatusMeta> = {
  draft: {
    label: 'Draft',
    badgeClass: 'border-status-draft bg-status-draft-subtle',
    settable: true,
  },
  in_review: {
    label: 'In review',
    badgeClass: 'border-status-review bg-status-review-subtle',
    settable: true,
  },
  scheduled: {
    label: 'Scheduled',
    badgeClass: 'border-status-scheduled bg-status-scheduled-subtle',
    settable: false,
  },
  published: {
    label: 'Published',
    badgeClass: 'border-status-published bg-status-published-subtle',
    settable: true,
  },
  archived: {
    label: 'Archived',
    badgeClass: 'border-status-archived bg-status-archived-subtle',
    settable: true,
  },
};

/**
 * Presentation for a status that has no entry above.
 *
 * Reachable if a database holds a status this build does not know — an older row, or a newer one
 * after a downgrade. Following the `parseJson` precedent, an unknown value degrades to a neutral
 * badge rather than throwing and taking the whole list view down.
 */
export function statusMeta(status: string): StatusMeta {
  return (
    STATUS_META[status as ContentStatus] ?? {
      label: status.replace(/_/g, ' '),
      badgeClass: 'border-border bg-surface-sunken',
      settable: false,
    }
  );
}

/**
 * Read a `?status=` query parameter, returning `undefined` for anything unrecognised.
 *
 * Membership is tested against the list rather than with `in`, which would answer true for
 * `toString` and every other inherited key and let junk through to the query.
 */
export function parseStatusFilter(value: string | null | undefined): ContentStatus | undefined {
  if (!value) return undefined;
  return (STATUS_ORDER as readonly string[]).includes(value)
    ? (value as ContentStatus)
    : undefined;
}

/**
 * Which statuses to offer in a filter, given how many items each currently matches.
 *
 * Statuses the editor can set are always listed, so the filter reads as a complete picture of the
 * workflow rather than shifting as content moves through it. The rest appear only when they have
 * something to show — or when one is already selected, since dropping the selected option would
 * silently reset the filter the page is currently applying.
 */
export function statusFilterOptions(
  counts: Record<ContentStatus, number>,
  selected: ContentStatus | undefined,
): { status: ContentStatus; label: string; count: number }[] {
  return STATUS_ORDER.filter(
    (status) => STATUS_META[status].settable || counts[status] > 0 || status === selected,
  ).map((status) => ({
    status,
    label: STATUS_META[status].label,
    count: counts[status] ?? 0,
  }));
}
