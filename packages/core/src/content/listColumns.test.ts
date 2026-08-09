import { describe, expect, it } from 'vitest';

import { columnCandidates, resolveListColumns, resolveListSort } from './listColumns.js';
import type { ContentTypeRow, FieldRow } from '../db/schema.js';

/**
 * How a stored list preference survives the fields it names being changed elsewhere.
 *
 * That is the whole risk in this feature. The columns are chosen on one screen and the fields are
 * edited on another, so the two go out of step as a matter of course rather than as a mistake — and
 * every failure mode here is silent on the screen where it shows up.
 */

function field(overrides: Partial<FieldRow>): FieldRow {
  return {
    id: 'f',
    content_type_id: 'ct',
    api_id: 'starts_at',
    label: 'Starts',
    type: 'date',
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

const starts = field({ api_id: 'starts_at', label: 'Starts', type: 'date' });
const photo = field({ id: 'f2', api_id: 'photo', label: 'Photo', type: 'media' });
const body = field({ id: 'f3', api_id: 'body', label: 'Body', type: 'richtext' });
const sections = field({ id: 'f4', api_id: 'sections', label: 'Sections', type: 'block' });

function type(overrides: Partial<ContentTypeRow>): ContentTypeRow {
  return {
    list_columns: null,
    list_sort: null,
    list_sort_field: null,
    ...overrides,
  } as ContentTypeRow;
}

describe('resolveListColumns', () => {
  it('falls back to what every list showed before this existed', () => {
    const columns = resolveListColumns(type({}), [starts]);
    expect(columns.map((c) => c.key)).toEqual(['title', 'path', 'status', 'updated', 'created']);
  });

  it('renders the configured columns in the configured order', () => {
    const columns = resolveListColumns(
      type({ list_columns: JSON.stringify(['title', 'starts_at', 'status']) }),
      [starts],
    );
    expect(columns.map((c) => c.key)).toEqual(['title', 'starts_at', 'status']);
    expect(columns[1]!.label).toBe('Starts');
  });

  it('drops a column naming a field that no longer exists', () => {
    /*
     * The failure this prevents is an empty column with a heading — which reads as data that is
     * missing rather than as a setting that is stale, and sends somebody looking at the content.
     */
    const columns = resolveListColumns(
      type({ list_columns: JSON.stringify(['title', 'deleted_field', 'status']) }),
      [starts],
    );
    expect(columns.map((c) => c.key)).toEqual(['title', 'status']);
  });

  it('drops a field whose type cannot be a column', () => {
    // A block holds a structure with no single reading and a richtext value is a paragraph; a
    // column of either is a table nobody can scan.
    const columns = resolveListColumns(
      type({ list_columns: JSON.stringify(['title', 'body', 'sections']) }),
      [starts, body, sections],
    );
    expect(columns.map((c) => c.key)).toEqual(['title']);
  });

  it('always keeps title, and puts it first when it was left out', () => {
    // Title carries the link to the editor, so a list without it is a table nobody can click out
    // of — a configuration an admin could otherwise save without noticing.
    const columns = resolveListColumns(
      type({ list_columns: JSON.stringify(['starts_at', 'status']) }),
      [starts],
    );
    expect(columns.map((c) => c.key)).toEqual(['title', 'starts_at', 'status']);
  });

  it('marks a media column as a thumbnail', () => {
    const columns = resolveListColumns(type({ list_columns: JSON.stringify(['photo']) }), [photo]);
    expect(columns.find((c) => c.key === 'photo')?.thumbnail).toBe(true);
  });

  it('falls back rather than throwing on unparseable stored JSON', () => {
    const columns = resolveListColumns(type({ list_columns: 'not json' }), [starts]);
    expect(columns.map((c) => c.key)).toEqual(['title', 'path', 'status', 'updated', 'created']);
  });
});

describe('resolveListSort', () => {
  it('defaults to path', () => {
    expect(resolveListSort(type({}), [starts])).toEqual({ sort: 'path' });
  });

  it('passes a plain order straight through', () => {
    expect(resolveListSort(type({ list_sort: 'title' }), [starts])).toEqual({ sort: 'title' });
  });

  it('resolves a field order to what listItemSummaries takes', () => {
    expect(
      resolveListSort(type({ list_sort: 'field_asc', list_sort_field: 'starts_at' }), [starts]),
    ).toEqual({ sort: 'field_asc', sortField: { apiId: 'starts_at', kind: 'date' } });
  });

  it('falls back to path when the sort field has been deleted', () => {
    /*
     * The rule a query field's `dateFieldApiId` already follows: a live screen must not break for a
     * configuration change made weeks earlier on another screen. Erroring here would take the whole
     * list down because somebody renamed a field.
     */
    expect(
      resolveListSort(type({ list_sort: 'field_asc', list_sort_field: 'gone' }), [starts]),
    ).toEqual({ sort: 'path' });
  });

  it('falls back when the named field is a type the value index does not carry', () => {
    // `media` is not in `content_item_values`, so there is nothing to order by — and ordering by a
    // column that does not exist is a SQL error rather than a wrong answer.
    expect(
      resolveListSort(type({ list_sort: 'field_asc', list_sort_field: 'photo' }), [photo]),
    ).toEqual({ sort: 'path' });
  });

  it('ignores an order that is not in the vocabulary', () => {
    expect(resolveListSort(type({ list_sort: 'id' }), [starts])).toEqual({ sort: 'path' });
  });
});

describe('columnCandidates', () => {
  it('offers the field types that can be a column, and no others', () => {
    expect(columnCandidates([starts, photo, body, sections]).map((f) => f.api_id)).toEqual([
      'starts_at',
      'photo',
    ]);
  });
});
