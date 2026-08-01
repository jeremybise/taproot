import type { ContentStatus, ReleaseStatus } from '@taproot/core';

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
  },
  in_review: {
    label: 'In review',
    badgeClass: 'border-status-review bg-status-review-subtle',
  },
  scheduled: {
    label: 'Scheduled',
    badgeClass: 'border-status-scheduled bg-status-scheduled-subtle',
  },
  published: {
    label: 'Published',
    badgeClass: 'border-status-published bg-status-published-subtle',
  },
  archived: {
    label: 'Archived',
    badgeClass: 'border-status-archived bg-status-archived-subtle',
  },
};

export const RELEASE_STATUS_ORDER = [
  'open',
  'scheduled',
  'blocked',
  'published',
] as const satisfies readonly ReleaseStatus[];

/**
 * How a release's own status presents.
 *
 * Here rather than on the releases screen for the reason the whole module exists: a badge that is
 * amber in the list and grey on the detail page teaches editors that the colour means nothing.
 *
 * Deliberately built from tokens that already exist. `open` borrows the draft pair because it means
 * the same thing — being worked on, not yet anybody else's problem — and `blocked` borrows the
 * danger pair. A new colour token is not done until it has a pair in `a11y-contrast.mjs`, and both
 * of these are already checked there; inventing `status-release-blocked` would have added an
 * unchecked colour for no gain in meaning.
 *
 * As with content statuses, the colour is always redundant with the text label. A badge that became
 * a bare swatch would fail WCAG 1.4.1.
 */
export const RELEASE_STATUS_META: Record<ReleaseStatus, StatusMeta> = {
  open: {
    label: 'Open',
    badgeClass: 'border-status-draft bg-status-draft-subtle',
  },
  scheduled: {
    label: 'Scheduled',
    badgeClass: 'border-status-scheduled bg-status-scheduled-subtle',
  },
  blocked: {
    label: 'Blocked',
    badgeClass: 'border-danger bg-danger-subtle',
  },
  published: {
    label: 'Published',
    badgeClass: 'border-status-published bg-status-published-subtle',
  },
};

export function releaseStatusMeta(status: string): StatusMeta {
  return (
    RELEASE_STATUS_META[status as ReleaseStatus] ?? {
      label: status.replace(/_/g, ' '),
      badgeClass: 'border-border bg-surface-sunken',
    }
  );
}

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
 * All of them, always, in workflow order — so the filter reads as a complete picture of the
 * pipeline rather than shifting as content moves through it, and a count of zero is information
 * rather than an absence.
 *
 * This used to take a `settable` flag per status, which existed solely to hide `scheduled` while
 * nothing could produce one. The scheduler produces them now, the flag was true for every status,
 * and a field that is the same for every row is not a field.
 */
export function statusFilterOptions(
  counts: Record<ContentStatus, number>,
  _selected?: ContentStatus | undefined,
): { status: ContentStatus; label: string; count: number }[] {
  return STATUS_ORDER.map((status) => ({
    status,
    label: STATUS_META[status].label,
    count: counts[status] ?? 0,
  }));
}
