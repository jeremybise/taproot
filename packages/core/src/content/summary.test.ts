import { describe, expect, it } from 'vitest';

import { fieldValueText, renderSummary, summaryLabel } from './summary.js';
import type { FieldRow } from '../db/schema.js';

/**
 * The summary template's rendering rules.
 *
 * This replaced `title_field`, a setting the content-type screen offered as "which field labels an
 * item in admin lists" and which no list ever read. The lesson recorded alongside that — a setting
 * can be stored, validated, round-tripped and enforced by nothing — is why the behaviour is pinned
 * here rather than left to the two screens that call it.
 */

function field(overrides: Partial<FieldRow>): FieldRow {
  return {
    id: 'f',
    content_type_id: 'ct',
    api_id: 'headline',
    label: 'Headline',
    type: 'text',
    help_text: null,
    position: 0,
    required: 0,
    localized: 0,
    config: '{}',
    visible_when: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  } as FieldRow;
}

const headline = field({ api_id: 'headline' });
const subtitle = field({ api_id: 'subtitle' });
const body = field({ api_id: 'body', type: 'richtext' });
const image = field({ api_id: 'image', type: 'media' });

describe('renderSummary', () => {
  it('fills a token from the item data', () => {
    expect(renderSummary('{{ headline }}', [headline], { headline: 'Apply now' })).toBe('Apply now');
  });

  it('tolerates a token written without spaces', () => {
    expect(renderSummary('{{headline}}', [headline], { headline: 'Apply now' })).toBe('Apply now');
  });

  it('joins several fields through the literal between them', () => {
    expect(
      renderSummary('{{ headline }} · {{ subtitle }}', [headline, subtitle], {
        headline: 'Apply now',
        subtitle: 'Admissions',
      }),
    ).toBe('Apply now · Admissions');
  });

  it('drops the separator along with an empty token', () => {
    /*
     * The rule this file exists for. Replacing a token with '' the obvious way leaves the literal
     * beside it, so half the rows of a list read "Apply now ·" — dangling punctuation that looks
     * like breakage, on the common case rather than the rare one, since optional fields are optional.
     */
    expect(
      renderSummary('{{ headline }} · {{ subtitle }}', [headline, subtitle], {
        headline: 'Apply now',
      }),
    ).toBe('Apply now');
  });

  it('drops a leading separator when the first token is the empty one', () => {
    expect(
      renderSummary('{{ subtitle }} — {{ headline }}', [headline, subtitle], {
        headline: 'Apply now',
      }),
    ).toBe('Apply now');
  });

  it('flattens richtext rather than emitting markup', () => {
    // The output is rendered as text by every caller; a summary must never carry tags for something
    // downstream to reach for `set:html` with.
    expect(renderSummary('{{ body }}', [body], { body: '<p>Hello <strong>there</strong></p>' })).toBe(
      'Hello there',
    );
  });

  it('contributes nothing for a field that stores an id', () => {
    // A uuid in a summary is worse than a blank: it is noise shaped like data, and resolving it
    // would need a database handle on a function the editor runs per keystroke.
    expect(renderSummary('{{ image }}', [image], { image: 'a-uuid-here' })).toBe('');
  });

  it('resolves an unknown field name to nothing rather than throwing', () => {
    // A template outlives the fields it names — somebody renames an api_id weeks later — and a live
    // screen must not break for a configuration change made elsewhere.
    expect(renderSummary('{{ nope }}', [headline], { headline: 'Apply now' })).toBe('');
  });

  it('returns nothing for an unset template', () => {
    expect(renderSummary(null, [headline], { headline: 'Apply now' })).toBe('');
    expect(renderSummary('', [headline], { headline: 'Apply now' })).toBe('');
  });

  it('joins a multi-value field rather than showing only the first', () => {
    const audience = field({ api_id: 'audience', type: 'select' });
    expect(
      renderSummary('{{ audience }}', [audience], { audience: ['Staff', 'Students'] }),
    ).toBe('Staff, Students');
  });

  it('truncates rather than letting one field fill a table cell', () => {
    const long = 'x'.repeat(400);
    const out = renderSummary('{{ headline }}', [headline], { headline: long });
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('fieldValueText', () => {
  it('reads a boolean as a word, not as true/false', () => {
    const featured = field({ api_id: 'featured', type: 'boolean' });
    expect(fieldValueText(featured, true)).toBe('Yes');
    expect(fieldValueText(featured, false)).toBe('No');
  });

  it('keeps a zero, which is a value rather than an absence', () => {
    const count = field({ api_id: 'count', type: 'number' });
    expect(fieldValueText(count, 0)).toBe('0');
  });
});

describe('summaryLabel', () => {
  it('falls back when the template renders empty', () => {
    // A block type with no template must read as its type name, not as a blank disclosure — which
    // is what makes adding this safe for every existing content type.
    expect(summaryLabel(null, [headline], {}, 'Hero')).toBe('Hero');
    expect(summaryLabel('{{ headline }}', [headline], {}, 'Hero')).toBe('Hero');
  });

  it('prefers the rendered summary when there is one', () => {
    expect(summaryLabel('{{ headline }}', [headline], { headline: 'Apply now' }, 'Hero')).toBe(
      'Apply now',
    );
  });
});

describe('date values', () => {
  const dated = field({ api_id: 'starts_at', type: 'date' });

  it('reads a date readably rather than as stored ISO', () => {
    // The raw value is what a list column and a summary line would otherwise show:
    // "2026-03-03T23:00:00.000Z" is not something to put in a table cell.
    expect(fieldValueText(dated, '2026-03-03T23:00:00.000Z')).toMatch(/Mar 3, 2026/);
  });

  it('shows a time only when the stored value carries one', () => {
    // An all-day date must not gain a misleading midnight, which is what a blanket time format does.
    expect(fieldValueText(dated, '2026-03-03')).toBe('Mar 3, 2026');
  });

  it('falls back to the raw value rather than showing "Invalid Date"', () => {
    expect(fieldValueText(dated, 'sometime in March')).toBe('sometime in March');
  });
});
