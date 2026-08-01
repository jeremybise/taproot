/**
 * Timestamp formatting for admin lists.
 *
 * Two constraints shape this. Lists are scanned, not read, so a column of identical
 * "Jul 29, 2026" values on a site edited today tells an editor nothing — the format tightens to a
 * time when the date is obvious and widens to a year when it is not. And the admin renders on the
 * server, so the timezone here is the *server's*, not the viewer's; shifting to the viewer's would
 * mean client-side JavaScript on every list row, which is not worth it for a column that answers
 * "roughly when". The `datetime` attribute carries the exact instant either way, so nothing is
 * lost — a locale-aware `<time>` enhancement could read it later without changing any caller.
 */

// Fixed locale rather than the server's, so a machine's regional settings cannot change what the
// admin renders. Matches RevisionHistory.astro.
const LOCALE = 'en-US';

const TIME_ONLY = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' });
const THIS_YEAR = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric' });
const WITH_YEAR = new Intl.DateTimeFormat(LOCALE, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const FULL = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

export interface FormattedTimestamp {
  /** Short form for the cell. Empty-ish input renders an em dash rather than "Invalid Date". */
  text: string;
  /** Unabbreviated date and time, for a `title` on the element. */
  full: string;
  /** The original ISO string for a `datetime` attribute, or `undefined` if it was unparseable. */
  machine: string | undefined;
}

export function formatTimestamp(
  iso: string | null | undefined,
  reference: Date = new Date(),
): FormattedTimestamp {
  if (!iso) return { text: '—', full: '', machine: undefined };

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { text: '—', full: '', machine: undefined };

  const sameDay =
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate();

  const text = sameDay
    ? TIME_ONLY.format(date)
    : date.getFullYear() === reference.getFullYear()
      ? THIS_YEAR.format(date)
      : WITH_YEAR.format(date);

  return { text, full: FULL.format(date), machine: iso };
}

/**
 * ISO 8601 → the `YYYY-MM-DDTHH:mm` a `datetime-local` input speaks.
 *
 * Here rather than duplicated in a screen because two callers already want it — the release
 * scheduler and, in its own React copy, the item editor. This one is deliberately the *server's*
 * zone, which is the caveat: an Astro page has no access to the viewer's, and pre-filling an input
 * with a time that is already stored is better than pre-filling it with nothing. The hint beside
 * the field says "your local time" because that is what an empty input and a fresh entry mean, and
 * anything already scheduled is displayed by `<Timestamp>` alongside it.
 */
export function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
