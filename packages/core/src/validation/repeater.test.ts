import { describe, expect, it } from 'vitest';

import type { FieldRow } from '../db/schema.js';
import {
  REPEATER_SUB_FIELD_TYPES,
  parseFieldConfig,
  repeaterRowFields,
  validateItemData,
} from './fields.js';

/**
 * The repeater: the last field type to get an editing control.
 *
 * Its sub-fields live in the parent field's own config rather than as rows in the `fields` table,
 * and `repeaterRowFields` turns them into ordinary `FieldRow`s on demand. That indirection is the
 * whole design — it means a repeater gets the same controls, the same validation, and the same
 * richtext sanitising as a top-level field without anything knowing repeaters exist.
 */

function repeater(config: Record<string, unknown>): FieldRow {
  return {
    id: 'f-hours',
    content_type_id: 'ct',
    api_id: 'hours',
    label: 'Opening hours',
    type: 'repeater',
    help_text: null,
    position: 0,
    required: 0,
    localized: 0,
    config: JSON.stringify(config),
    created_at: '',
    updated_at: '',
  } as FieldRow;
}

const dayAndTime = {
  fields: [
    { api_id: 'day', label: 'Day', type: 'text', required: true, config: {} },
    { api_id: 'opens', label: 'Opens', type: 'text', required: false, config: {} },
  ],
};

const row = (data: Record<string, unknown>, id = 'r1') => ({ id, data });

describe('sub-field definitions', () => {
  it('become field rows the rest of the system already understands', () => {
    const fields = repeaterRowFields(repeater(dayAndTime));

    expect(fields.map((field) => field.api_id)).toEqual(['day', 'opens']);
    expect(fields[0]!.required).toBe(1);
    expect(fields[0]!.position).toBe(0);
  });

  it('derives stable ids from the parent', () => {
    // Regenerating these per render would remount every input on every keystroke, which loses
    // focus mid-word.
    const first = repeaterRowFields(repeater(dayAndTime));
    const second = repeaterRowFields(repeater(dayAndTime));

    expect(first.map((field) => field.id)).toEqual(second.map((field) => field.id));
  });

  it('drops a malformed definition rather than the whole repeater', () => {
    // Same tolerance `parseJson` applies everywhere a stored blob is read back: one bad entry
    // costs that entry, not the field.
    const fields = repeaterRowFields(
      repeater({ fields: [{ nonsense: true }, dayAndTime.fields[0]] }),
    );

    expect(fields.map((field) => field.api_id)).toEqual(['day']);
  });

  it('returns nothing for a repeater with no shape yet', () => {
    expect(repeaterRowFields(repeater({}))).toEqual([]);
  });
});

describe('the config schema', () => {
  it('accepts every sub-field type on the allowlist', () => {
    for (const type of REPEATER_SUB_FIELD_TYPES) {
      const result = parseFieldConfig('repeater', {
        fields: [{ api_id: 'x', label: 'X', type }],
      });
      expect(result.success).toBe(true);
    }
  });

  it('refuses a repeater inside a repeater', () => {
    /**
     * A table of tables is a data model, not a field — the person reaching for it wants a content
     * type and a relation. It is also what makes the config form's one-level recursion terminate,
     * which is why the rule is an allowlist in core rather than a filter in the UI.
     */
    const result = parseFieldConfig('repeater', {
      fields: [{ api_id: 'x', label: 'X', type: 'repeater' }],
    });

    expect(result.success).toBe(false);
  });

  it('refuses a block inside a repeater', () => {
    // Blocks compose a page; a repeater holds several of one thing. Nesting confuses two jobs.
    const result = parseFieldConfig('repeater', {
      fields: [{ api_id: 'x', label: 'X', type: 'block' }],
    });

    expect(result.success).toBe(false);
  });
});

describe('validating values', () => {
  it('validates each row against the sub-fields', () => {
    const result = validateItemData(
      [repeater(dayAndTime)],
      { hours: [row({ day: 'Monday', opens: '09:00' })] },
    );

    expect(result.success).toBe(true);
    expect(result.data?.hours).toEqual([{ id: 'r1', data: { day: 'Monday', opens: '09:00' } }]);
  });

  it('reports a missing required sub-field with its position', () => {
    // The editor renders rows under one label and has nowhere to put a per-row error map, so the
    // message has to say which entry — the same reason block errors carry their index.
    const result = validateItemData(
      [repeater(dayAndTime)],
      { hours: [row({ day: 'Monday' }, 'r1'), row({ opens: '09:00' }, 'r2')] },
    );

    expect(result.success).toBe(false);
    expect(result.errors.hours?.join(' ')).toMatch(/Entry 2.*day/);
  });

  it('drops keys no sub-field declares', () => {
    // Consistent with top-level validation: a removed field should not make existing content
    // unsavable, and keeping stale keys would let it resurface.
    const result = validateItemData(
      [repeater(dayAndTime)],
      { hours: [row({ day: 'Monday', gone: 'stale' })] },
    );

    expect(result.data?.hours).toEqual([{ id: 'r1', data: { day: 'Monday' } }]);
  });

  it('enforces minimum and maximum entries', () => {
    const bounded = repeater({ ...dayAndTime, minItems: 2, maxItems: 3 });

    expect(validateItemData([bounded], { hours: [row({ day: 'Mon' })] }).errors.hours?.join(' '))
      .toMatch(/At least 2/);

    const tooMany = validateItemData([bounded], {
      hours: [1, 2, 3, 4].map((n) => row({ day: `Day ${n}` }, `r${n}`)),
    });
    expect(tooMany.errors.hours?.join(' ')).toMatch(/At most 3/);
  });

  it('requires a row envelope, so a bare object cannot pose as an entry', () => {
    const result = validateItemData([repeater(dayAndTime)], { hours: [{ day: 'Monday' }] });
    expect(result.success).toBe(false);
  });

  it('sanitises richtext inside a row exactly as at the top level', () => {
    /**
     * The recursion is the point: a row's fields go through the same validation, so nothing is
     * safe outside a repeater and hostile inside one.
     */
    const withRichtext = repeater({
      fields: [{ api_id: 'note', label: 'Note', type: 'richtext', config: {} }],
    });

    const result = validateItemData([withRichtext], {
      hours: [row({ note: '<p>hi</p><script>alert(1)</script>' })],
    });

    expect(result.success).toBe(true);
    expect((result.data?.hours as { data: { note: string } }[])[0]!.data.note).toBe('<p>hi</p>');
  });

  it('leaves rows alone when no shape is defined', () => {
    /**
     * A repeater whose sub-fields have not been designed yet is half-built, not invalid. Emptying
     * whatever an API client stored would be destroying content to enforce a schema that does not
     * exist.
     */
    const result = validateItemData([repeater({})], { hours: [row({ anything: 'kept' })] });

    expect(result.success).toBe(true);
    expect(result.data?.hours).toEqual([row({ anything: 'kept' })]);
  });

  it('accepts an absent value for an optional repeater', () => {
    expect(validateItemData([repeater(dayAndTime)], {}).success).toBe(true);
  });
});
