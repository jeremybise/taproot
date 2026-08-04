import { describe, expect, it } from 'vitest';

import type { FieldRow } from '../db/schema.js';
import { validateItemData } from './fields.js';
import { evaluateVisibility, isFieldVisible, parseVisibility } from './visibility.js';

/**
 * Conditional field visibility.
 *
 * Two things are being defended here and they pull in opposite directions. A field the editor is
 * not showing must not be *required*, or somebody is blocked by an input they cannot see. And a
 * field the editor is not showing must not be *emptied*, or adding a condition to a content type
 * silently wipes content across every item on its next save.
 *
 * The third property, easy to lose and impossible to notice: sanitising is untouched. A hidden
 * richtext value is still stored and still rendered by a consumer with `set:html`, so the relaxation
 * must not reach it.
 */

function field(overrides: Partial<FieldRow> & Pick<FieldRow, 'api_id' | 'type'>): FieldRow {
  return {
    id: `f-${overrides.api_id}`,
    content_type_id: 'ct',
    label: overrides.api_id,
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

/** `visible_when` is stored as JSON on the row, so conditions are written the way the DB holds them. */
function when(field: string, operator: string, value?: string): string {
  return JSON.stringify(value === undefined ? { field, operator } : { field, operator, value });
}

const HOSTILE = '<p>hello</p><script>alert(1)</script>';

describe('the evaluator', () => {
  const known = new Set(['flag', 'status', 'tags', 'note']);

  it('reads a checkbox', () => {
    expect(evaluateVisibility({ field: 'flag', operator: 'is_checked' }, { flag: true }, known)).toBe(true);
    expect(evaluateVisibility({ field: 'flag', operator: 'is_checked' }, { flag: false }, known)).toBe(false);
    // Never ticked is not ticked. That is data being absent on a field that exists, which is a
    // different thing from the condition naming a field that does not.
    expect(evaluateVisibility({ field: 'flag', operator: 'is_checked' }, {}, known)).toBe(false);
    expect(evaluateVisibility({ field: 'flag', operator: 'is_not_checked' }, {}, known)).toBe(true);
  });

  it('compares as a string, so one text input serves every field type', () => {
    const condition = { field: 'status', operator: 'equals' as const, value: 'published' };
    expect(evaluateVisibility(condition, { status: 'published' }, known)).toBe(true);
    expect(evaluateVisibility(condition, { status: 'draft' }, known)).toBe(false);
    expect(evaluateVisibility({ ...condition, operator: 'not_equals' }, { status: 'draft' }, known)).toBe(true);
  });

  it('matches any member of a multi-value field', () => {
    // A multiple `select` or `taxonomy` stores a list, and "is Arts" plainly means "is one of these".
    const condition = { field: 'tags', operator: 'equals' as const, value: 'arts' };
    expect(evaluateVisibility(condition, { tags: ['science', 'arts'] }, known)).toBe(true);
    expect(evaluateVisibility(condition, { tags: ['science'] }, known)).toBe(false);
  });

  it('treats an empty array and a blank string as unset, but false as set', () => {
    const isSet = { field: 'note', operator: 'is_set' as const };
    expect(evaluateVisibility(isSet, { note: 'something' }, known)).toBe(true);
    expect(evaluateVisibility(isSet, { note: '   ' }, known)).toBe(false);
    // `media` and `relation` store `[]` for "none chosen"; counting that as an answer would make
    // `is_set` true for every multi-value field the moment it rendered.
    expect(evaluateVisibility(isSet, { note: [] }, known)).toBe(false);
    // An unticked checkbox has an answer, which is why `is_checked` is a separate operator.
    expect(evaluateVisibility(isSet, { note: false }, known)).toBe(true);
    expect(evaluateVisibility({ field: 'note', operator: 'is_empty' }, { note: [] }, known)).toBe(true);
  });

  it('fails open when the condition names a field that no longer exists', () => {
    /**
     * The whole reason `known` is passed. Reading a deleted field's value gives `undefined`,
     * `is_checked` answers false, and the dependent field would be hidden permanently — a
     * content-type edit quietly making an input unreachable with nothing able to explain why.
     */
    const condition = { field: 'deleted_field', operator: 'is_checked' as const };
    expect(evaluateVisibility(condition, {}, known)).toBe(true);
    // Without the schema in hand there is nothing to fail open against, and it evaluates normally.
    expect(evaluateVisibility(condition, {})).toBe(false);
  });
});

describe('reading a stored condition', () => {
  it('treats anything unparseable as unconditional', () => {
    // Same tolerance `parseJson` applies to every other stored blob: a malformed condition costs
    // the condition, not the field.
    expect(parseVisibility('not json at all')).toBeNull();
    expect(parseVisibility(JSON.stringify({ field: 'x', operator: 'nonsense' }))).toBeNull();
    expect(parseVisibility(null)).toBeNull();
    expect(parseVisibility('')).toBeNull();
  });

  it('leaves a field with no condition visible', () => {
    const banner = field({ api_id: 'banner', type: 'text' });
    expect(isFieldVisible(banner, [banner], {})).toBe(true);
  });
});

describe('what a hidden field does to validation', () => {
  const fields = [
    field({ api_id: 'show_banner', type: 'boolean' }),
    field({
      api_id: 'banner_text',
      type: 'text',
      required: 1,
      visible_when: when('show_banner', 'is_checked'),
    }),
  ];

  it('does not require a field whose condition is unmet', () => {
    expect(validateItemData(fields, { show_banner: false }).success).toBe(true);
  });

  it('still requires it once the condition is met', () => {
    const result = validateItemData(fields, { show_banner: true });
    expect(result.success).toBe(false);
    expect(result.errors.banner_text).toBeTruthy();
  });

  it('keeps a hidden field’s stored value rather than dropping it', () => {
    /**
     * The property that stops this being a destructive transform. Dropping would mean adding a
     * condition on the content-type screen silently wiped that field across every item the next
     * time anybody saved one — with no revision showing an author doing it, because no author did.
     * It is also what makes unticking and reticking a box bring the text back.
     */
    const result = validateItemData(fields, { show_banner: false, banner_text: 'Closed today' });
    expect(result.success).toBe(true);
    expect(result.data.banner_text).toBe('Closed today');
  });

  it('is decided by the raw input, not by fields validated so far', () => {
    /**
     * The loop fills `parsed` in field order. Evaluating against it would mean a controlling
     * checkbox positioned *after* its dependent was not yet there, so the dependent would come out
     * hidden and stop being required — an ordering-dependent rule, and one that would look correct
     * on every content type where somebody happened to put the checkbox first.
     */
    const reversed = [fields[1]!, fields[0]!];
    const result = validateItemData(reversed, { show_banner: true });
    expect(result.success).toBe(false);
    expect(result.errors.banner_text).toBeTruthy();
  });

  it('still sanitises a hidden richtext value', () => {
    /**
     * The relaxation is `required`, `minLength` and `minItems` — never sanitising. A hidden value is
     * still stored and still rendered with `set:html` by any consumer that reads the controlling
     * boolean differently from the editor, so this is a write path like every other one.
     */
    const withBody = [
      fields[0]!,
      field({
        api_id: 'body',
        type: 'richtext',
        required: 1,
        visible_when: when('show_banner', 'is_checked'),
      }),
    ];

    const result = validateItemData(withBody, { show_banner: false, body: HOSTILE });
    expect(result.success).toBe(true);
    expect(result.data.body).not.toContain('<script>');
    expect(result.data.body).toContain('hello');
  });

  it('relaxes a hidden repeater’s minItems, and still enforces its maxItems', () => {
    // The relaxation has to reach the block and repeater walks, not just the value schema —
    // otherwise a hidden region's own minimums still refuse a save nobody can act on.
    const withRepeater = [
      fields[0]!,
      field({
        api_id: 'hours',
        type: 'repeater',
        visible_when: when('show_banner', 'is_checked'),
        config: JSON.stringify({
          minItems: 2,
          maxItems: 2,
          fields: [{ api_id: 'day', label: 'Day', type: 'text', required: false, config: {} }],
        }),
      }),
    ];

    const one = { show_banner: false, hours: [{ id: 'r1', data: { day: 'Monday' } }] };
    expect(validateItemData(withRepeater, one).success).toBe(true);

    // A maximum is a bound on what the system will carry, not a claim about completeness.
    const three = {
      show_banner: false,
      hours: [{ id: 'r1', data: {} }, { id: 'r2', data: {} }, { id: 'r3', data: {} }],
    };
    expect(validateItemData(withRepeater, three).success).toBe(false);
  });
});

describe('the scope of "sibling"', () => {
  it('reads a block’s own data, not the item around it', () => {
    /**
     * A condition names a field at the same level and nothing wider. The item here has no
     * `show_caption` at all — only the block does — so if the scope leaked upward the condition
     * would read `undefined`, the caption would be hidden, and its required rule would vanish.
     */
    const blockTypes = new Map([
      [
        'figure',
        {
          fields: [
            field({ api_id: 'show_caption', type: 'boolean', content_type_id: 'figure' }),
            field({
              api_id: 'caption',
              type: 'text',
              required: 1,
              content_type_id: 'figure',
              visible_when: when('show_caption', 'is_checked'),
            }),
          ],
        },
      ],
    ]);

    const fields = [field({ api_id: 'sections', type: 'block' })];

    const shown = {
      sections: [{ id: 'b1', type: 'figure', data: { show_caption: true } }],
    };
    expect(validateItemData(fields, shown, { blockTypes }).success).toBe(false);

    const hidden = {
      sections: [{ id: 'b1', type: 'figure', data: { show_caption: false } }],
    };
    expect(validateItemData(fields, hidden, { blockTypes }).success).toBe(true);
  });

  it('reads a repeater row’s own data, so one row can hide what another shows', () => {
    const fields = [
      field({
        api_id: 'hours',
        type: 'repeater',
        config: JSON.stringify({
          fields: [
            { api_id: 'closed', label: 'Closed', type: 'boolean', required: false, config: {} },
            {
              api_id: 'opens',
              label: 'Opens',
              type: 'text',
              required: true,
              config: {},
              visible_when: { field: 'closed', operator: 'is_not_checked' },
            },
          ],
        }),
      }),
    ];

    // Sunday is closed and needs no opening time; Monday is open and has one. Per row, not per item.
    const ok = {
      hours: [
        { id: 'r1', data: { closed: true } },
        { id: 'r2', data: { closed: false, opens: '09:00' } },
      ],
    };
    expect(validateItemData(fields, ok).success).toBe(true);

    const missing = {
      hours: [
        { id: 'r1', data: { closed: true } },
        { id: 'r2', data: { closed: false } },
      ],
    };
    expect(validateItemData(fields, missing).success).toBe(false);
  });
});
