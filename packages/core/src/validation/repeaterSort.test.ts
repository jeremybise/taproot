import { describe, expect, it } from 'vitest';

import { validateItemData } from './fields.js';
import type { FieldRow } from '../db/schema.js';

/**
 * A repeater keeping its own rows in order.
 *
 * The case is 507 courses across 72 subject items, 5–40 rows each, whose reading order is by code and
 * always was. What makes this worth a test file of its own is that the wrong implementations all
 * *look* right: a plain string comparison is correct on every example anybody checks by hand and
 * wrong on `RAD 1096`, and sorting by default would silently destroy the meaning of a program plan
 * whose blank rows inherit the term above them.
 */

function field(overrides: Partial<FieldRow>): FieldRow {
  return {
    id: 'f1',
    content_type_id: 'ct',
    api_id: 'courses',
    label: 'Courses',
    type: 'repeater',
    help_text: null,
    position: 0,
    required: 0,
    localized: 0,
    visible_when: null,
    config: '{}',
    created_at: '',
    updated_at: '',
    ...overrides,
  } as FieldRow;
}

const subFields = [
  { api_id: 'code', label: 'Code', type: 'text', required: false, config: {} },
  { api_id: 'title', label: 'Title', type: 'text', required: false, config: {} },
];

const repeater = (config: Record<string, unknown>) =>
  field({ config: JSON.stringify({ fields: subFields, ...config }) });

const rows = (...codes: (string | undefined)[]) =>
  codes.map((code, index) => ({
    id: `r${index}`,
    data: code === undefined ? { title: `Row ${index}` } : { code, title: `Row ${index}` },
  }));

function codesAfterSave(config: Record<string, unknown>, input: ReturnType<typeof rows>) {
  const result = validateItemData([repeater(config)], { courses: input });
  if (!result.success) throw new Error(JSON.stringify(result.errors));
  return (result.data!.courses as { data: { code?: string } }[]).map((row) => row.data.code);
}

describe('repeater sortBy', () => {
  it('leaves the entered order alone when nothing is configured', () => {
    expect(codesAfterSave({}, rows('RAD 196', 'ART 101', 'MTH 161'))).toEqual([
      'RAD 196',
      'ART 101',
      'MTH 161',
    ]);
  });

  it('sorts rows by the named sub-field on save', () => {
    expect(codesAfterSave({ sortBy: 'code' }, rows('RAD 196', 'ART 101', 'MTH 161'))).toEqual([
      'ART 101',
      'MTH 161',
      'RAD 196',
    ]);
  });

  /**
   * The failure that looks plausible on every example anybody checks by hand. As text `RAD 1096`
   * sorts before `RAD 196`, which is wrong on exactly the catalogs large enough to matter.
   */
  it('compares numbers inside the string numerically', () => {
    expect(codesAfterSave({ sortBy: 'code' }, rows('RAD 1096', 'RAD 196', 'RAD 20'))).toEqual([
      'RAD 20',
      'RAD 196',
      'RAD 1096',
    ]);
  });

  it('reverses on request', () => {
    expect(
      codesAfterSave({ sortBy: 'code', sortDirection: 'desc' }, rows('ART 101', 'RAD 196')),
    ).toEqual(['RAD 196', 'ART 101']);
  });

  /**
   * A half-typed row belongs where its author left it, not at the top of a finished list — and this
   * holds in *both* directions, or reversing the sort would float every blank new row to the front.
   */
  it('puts rows with no value last, ascending and descending alike', () => {
    expect(codesAfterSave({ sortBy: 'code' }, rows('RAD 196', undefined, 'ART 101'))).toEqual([
      'ART 101',
      'RAD 196',
      undefined,
    ]);

    expect(
      codesAfterSave({ sortBy: 'code', sortDirection: 'desc' }, rows('RAD 196', undefined, 'ART 101')),
    ).toEqual(['RAD 196', 'ART 101', undefined]);
  });

  it('treats an empty string as no value rather than as one sorting first', () => {
    expect(codesAfterSave({ sortBy: 'code' }, rows('RAD 196', '   ', 'ART 101'))).toEqual([
      'ART 101',
      'RAD 196',
      '   ',
    ]);
  });

  /** Stable, so rows sharing a key stay in the order they were entered in. */
  it('keeps equal keys in their entered order', () => {
    const input = [
      { id: 'a', data: { code: 'RAD 196', title: 'First' } },
      { id: 'b', data: { code: 'RAD 196', title: 'Second' } },
      { id: 'c', data: { code: 'ART 101', title: 'Third' } },
    ];
    const result = validateItemData([repeater({ sortBy: 'code' })], { courses: input });
    const titles = (result.data!.courses as { data: { title: string } }[]).map(
      (row) => row.data.title,
    );

    expect(titles).toEqual(['Third', 'First', 'Second']);
  });

  /**
   * The configuration outlives the fields it names. A live save must not break for a sub-field
   * somebody renamed weeks earlier on another screen — the rule a query field's `dateFieldApiId`
   * already follows.
   */
  it('does nothing when the named sub-field no longer exists', () => {
    expect(codesAfterSave({ sortBy: 'gone' }, rows('RAD 196', 'ART 101'))).toEqual([
      'RAD 196',
      'ART 101',
    ]);
  });

  it('ignores a non-string sortBy rather than throwing', () => {
    expect(codesAfterSave({ sortBy: 42 }, rows('RAD 196', 'ART 101'))).toEqual([
      'RAD 196',
      'ART 101',
    ]);
  });

  /**
   * The stored order becomes the sorted order, so a second save is a no-op and delivery pays
   * nothing. That is the property that keeps `data` round-trippable for a write, which the generated
   * types depend on.
   */
  it('is idempotent', () => {
    const once = validateItemData([repeater({ sortBy: 'code' })], {
      courses: rows('RAD 196', 'ART 101'),
    });
    const twice = validateItemData([repeater({ sortBy: 'code' })], {
      courses: once.data!.courses,
    });

    expect(twice.data!.courses).toEqual(once.data!.courses);
  });

  /** Ids and every other sub-field value travel with the row, not just the sort key. */
  it('moves whole rows rather than reordering one column', () => {
    const result = validateItemData([repeater({ sortBy: 'code' })], {
      courses: [
        { id: 'r0', data: { code: 'RAD 196', title: 'Radiography' } },
        { id: 'r1', data: { code: 'ART 101', title: 'Drawing' } },
      ],
    });

    expect(result.data!.courses).toEqual([
      { id: 'r1', data: { code: 'ART 101', title: 'Drawing' } },
      { id: 'r0', data: { code: 'RAD 196', title: 'Radiography' } },
    ]);
  });
});
