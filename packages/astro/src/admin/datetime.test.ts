import { describe, expect, it } from 'vitest';

import { formatTimestamp } from './datetime.js';

/**
 * The reference instant is passed explicitly rather than mocked, which is the whole reason
 * `formatTimestamp` takes one — "is this today?" is the only interesting branch and a test that
 * depended on the wall clock would answer differently at midnight.
 *
 * Timestamps are built from local-time components, because that is what the formatter compares
 * against. Constructing them as UTC would make the same-day assertions flip depending on the
 * machine's timezone.
 */
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
const iso = (...args: Parameters<typeof at>) => at(...args).toISOString();

describe('formatTimestamp', () => {
  const reference = at(2026, 7, 29, 15, 30);

  it('shows only the time for something edited today', () => {
    // A list of items all edited today would otherwise be a column of identical dates.
    expect(formatTimestamp(iso(2026, 7, 29, 14, 5), reference).text).toBe('2:05 PM');
  });

  it('shows month and day within the same year', () => {
    expect(formatTimestamp(iso(2026, 3, 4, 9, 0), reference).text).toBe('Mar 4');
  });

  it('adds the year once it is a different one', () => {
    expect(formatTimestamp(iso(2025, 11, 2, 9, 0), reference).text).toBe('Nov 2, 2025');
  });

  it('treats a future date in another year the same way', () => {
    expect(formatTimestamp(iso(2027, 1, 3, 9, 0), reference).text).toBe('Jan 3, 2027');
  });

  it('does not call yesterday "today" just because it is within 24 hours', () => {
    // Calendar-day comparison, not an elapsed-time one.
    const result = formatTimestamp(iso(2026, 7, 28, 23, 55), reference);

    expect(result.text).toBe('Jul 28');
  });

  it('keeps the exact instant for the datetime attribute', () => {
    const value = iso(2026, 3, 4, 9, 0);
    const result = formatTimestamp(value, reference);

    expect(result.machine).toBe(value);
    expect(result.full).toContain('2026');
  });

  it('renders an em dash rather than "Invalid Date"', () => {
    // A single bad timestamp must not be more visible than the row it belongs to.
    for (const bad of [null, undefined, '', 'not a date']) {
      const result = formatTimestamp(bad, reference);
      expect(result.text).toBe('—');
      expect(result.machine).toBeUndefined();
    }
  });
});
