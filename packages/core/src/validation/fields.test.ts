import { describe, expect, it } from 'vitest';

import type { FieldRow } from '../db/schema.js';
import { MAX_BLOCK_DEPTH, validateItemData } from './fields.js';

/**
 * `requireComplete: false` — the one relaxation on the validation path, and the rules that keep it
 * from becoming a general-purpose "skip the checks" switch.
 *
 * It exists for `writePreviewDraft`, whose input is a form somebody is still typing into. What it
 * must relax is exactly three rules; what it must **not** relax is richtext sanitising, because the
 * snapshot it produces is rendered by a consumer with `set:html`. That is the single property this
 * file exists to defend, and it is asserted at all three walk sites — a top-level field, a field
 * inside a block, and a field inside a repeater row — because a walk that reaches one and not
 * another is how unsanitised HTML gets through.
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
    created_at: '',
    updated_at: '',
    ...overrides,
  } as FieldRow;
}

const LOOSE = { requireComplete: false } as const;

/** The one string every sanitising assertion below is looking for the absence of. */
const HOSTILE = '<p>hello</p><script>alert(1)</script>';

describe('what requireComplete: false relaxes', () => {
  it('accepts a missing required field, where the default rejects it', () => {
    const fields = [field({ api_id: 'summary', type: 'text', required: 1 })];

    expect(validateItemData(fields, {}).success).toBe(false);
    expect(validateItemData(fields, {}, LOOSE).success).toBe(true);
  });

  it('accepts a required text field left empty', () => {
    // The strict path rejects `''` as well as absence — a required field satisfied by nothing is
    // the bug that rule exists for. Half-typed, it is simply not finished.
    const fields = [field({ api_id: 'summary', type: 'text', required: 1 })];

    expect(validateItemData(fields, { summary: '' }).success).toBe(false);
    expect(validateItemData(fields, { summary: '' }, LOOSE).success).toBe(true);
  });

  it('accepts a text field under its minLength', () => {
    const fields = [
      field({ api_id: 'code', type: 'text', config: JSON.stringify({ minLength: 5 }) }),
    ];

    expect(validateItemData(fields, { code: 'ab' }).success).toBe(false);
    expect(validateItemData(fields, { code: 'ab' }, LOOSE).success).toBe(true);
  });

  it('accepts a repeater under its minItems', () => {
    const fields = [
      field({
        api_id: 'hours',
        type: 'repeater',
        config: JSON.stringify({
          minItems: 2,
          fields: [{ api_id: 'day', label: 'Day', type: 'text', required: false, config: {} }],
        }),
      }),
    ];
    const data = { hours: [{ id: 'r1', data: { day: 'Monday' } }] };

    expect(validateItemData(fields, data).success).toBe(false);
    expect(validateItemData(fields, data, LOOSE).success).toBe(true);
  });
});

describe('what it does not relax', () => {
  /**
   * A minimum is a statement about completeness; a maximum is a bound on what the system will
   * carry. Only the first kind is a question a half-typed form is allowed to fail.
   */
  it('still enforces maxLength', () => {
    const fields = [
      field({ api_id: 'code', type: 'text', config: JSON.stringify({ maxLength: 3 }) }),
    ];

    expect(validateItemData(fields, { code: 'far too long' }, LOOSE).success).toBe(false);
  });

  it('still enforces a repeater maxItems', () => {
    const fields = [
      field({
        api_id: 'hours',
        type: 'repeater',
        config: JSON.stringify({
          maxItems: 1,
          fields: [{ api_id: 'day', label: 'Day', type: 'text', required: false, config: {} }],
        }),
      }),
    ];
    const data = { hours: [{ id: 'r1', data: {} }, { id: 'r2', data: {} }] };

    expect(validateItemData(fields, data, LOOSE).success).toBe(false);
  });

  it('still enforces select options', () => {
    const fields = [
      field({
        api_id: 'audience',
        type: 'select',
        config: JSON.stringify({ options: [{ value: 'staff', label: 'Staff' }] }),
      }),
    ];

    expect(validateItemData(fields, { audience: 'nobody' }, LOOSE).success).toBe(false);
  });

  it('still enforces the type of a value', () => {
    const fields = [field({ api_id: 'capacity', type: 'number' })];

    expect(validateItemData(fields, { capacity: 'not a number' }, LOOSE).success).toBe(false);
  });

  it('still enforces allowedBlocks and maxBlocks', () => {
    const registry = new Map([['hero', { fields: [] }]]);
    const fields = [
      field({
        api_id: 'sections',
        type: 'block',
        config: JSON.stringify({ allowedBlocks: ['quote'] }),
      }),
    ];
    const data = { sections: [{ id: 'b1', type: 'hero', data: {} }] };

    expect(
      validateItemData(fields, data, { ...LOOSE, blockTypes: registry }).success,
    ).toBe(false);
  });

  it('still enforces MAX_BLOCK_DEPTH', () => {
    // A block type holding a block field, pointed at itself: the editor never offers this (it
    // excludes ancestors), which is exactly why the boundary has to refuse it.
    const nested = field({ api_id: 'inner', type: 'block' });
    const registry = new Map([['section', { fields: [nested] }]]);

    let data: unknown = { id: 'leaf', type: 'section', data: {} };
    for (let depth = 0; depth <= MAX_BLOCK_DEPTH + 1; depth += 1) {
      data = { id: `b${depth}`, type: 'section', data: { inner: [data] } };
    }

    const result = validateItemData(
      [field({ api_id: 'sections', type: 'block' })],
      { sections: [data] },
      { ...LOOSE, blockTypes: registry },
    );

    expect(result.success).toBe(false);
  });
});

describe('sanitising is not relaxed, at any depth', () => {
  it('sanitises a top-level richtext field', () => {
    const fields = [field({ api_id: 'body', type: 'richtext' })];

    const result = validateItemData(fields, { body: HOSTILE }, LOOSE);

    expect(result.success).toBe(true);
    expect(result.data!.body).toBe('<p>hello</p>');
  });

  it('sanitises richtext inside a block', () => {
    const registry = new Map([
      ['prose', { fields: [field({ api_id: 'body', type: 'richtext' })] }],
    ]);
    const fields = [field({ api_id: 'sections', type: 'block' })];
    const data = { sections: [{ id: 'b1', type: 'prose', data: { body: HOSTILE } }] };

    const result = validateItemData(fields, data, { ...LOOSE, blockTypes: registry });

    expect(result.success).toBe(true);
    const blocks = result.data!.sections as { data: Record<string, unknown> }[];
    expect(blocks[0]!.data.body).toBe('<p>hello</p>');
  });

  it('sanitises richtext inside a repeater row', () => {
    const fields = [
      field({
        api_id: 'entries',
        type: 'repeater',
        config: JSON.stringify({
          fields: [{ api_id: 'note', label: 'Note', type: 'richtext', required: false, config: {} }],
        }),
      }),
    ];
    const data = { entries: [{ id: 'r1', data: { note: HOSTILE } }] };

    const result = validateItemData(fields, data, LOOSE);

    expect(result.success).toBe(true);
    const rows = result.data!.entries as { data: Record<string, unknown> }[];
    expect(rows[0]!.data.note).toBe('<p>hello</p>');
  });

  it('sanitises a required richtext field that is otherwise being let through empty', () => {
    // The combination is the one that matters: relaxing `required` must not skip the transform on
    // the same field, because that is precisely the field an editor is mid-sentence in.
    const fields = [field({ api_id: 'body', type: 'richtext', required: 1 })];

    const result = validateItemData(fields, { body: HOSTILE }, LOOSE);

    expect(result.data!.body).toBe('<p>hello</p>');
  });
});

describe('the default is strict', () => {
  /**
   * The guard against the option leaking onto a write path.
   *
   * `createItem`, `updateItem`, and `updateStagedItem` all reach `validateItemData` without an
   * opinion about completeness, so the default is what protects them. A regression here would not
   * fail any of their own tests — it would simply let an incomplete item be stored — which is why
   * the assertion lives next to the option rather than next to them.
   */
  it('requires a required field when nothing says otherwise', () => {
    const fields = [field({ api_id: 'summary', type: 'text', required: 1 })];

    expect(validateItemData(fields, {}).success).toBe(false);
    expect(validateItemData(fields, {}, {}).success).toBe(false);
    expect(validateItemData(fields, {}, { blockTypes: new Map() }).success).toBe(false);
    expect(validateItemData(fields, {}, { requireComplete: true }).success).toBe(false);
  });
});

/**
 * The `link` field's `url` variant, which is a write path whose value ends up in an `href`.
 *
 * It is exactly as exposed as rich text is, and the whole reason `safeUrl` was exported rather than
 * a second scheme check being written here: a rule that exists twice is a rule that disagrees with
 * itself once. Every case below is one `sanitizeHtml` already refuses inside prose.
 */
describe('a link field is not a hole in the URL allowlist', () => {
  const linkField = (config: Record<string, unknown> = {}) =>
    field({ api_id: 'cta', type: 'link', config: JSON.stringify(config) });

  const store = (value: unknown, config?: Record<string, unknown>) =>
    validateItemData([linkField(config)], { cta: value });

  for (const hostile of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
  ]) {
    it(`refuses ${JSON.stringify(hostile)}`, () => {
      expect(store({ kind: 'url', href: hostile }).success).toBe(false);
    });
  }

  it('accepts the addresses a link is actually for', () => {
    for (const href of ['https://example.edu/apply', '/admissions', 'mailto:a@b.edu', 'tel:+15550100']) {
      expect(store({ kind: 'url', href }).success, href).toBe(true);
    }
  });

  /**
   * An internal target is the `item` kind, not a URL spelled `taproot:`.
   *
   * `safeUrl` admits the scheme because rich text stores references that way; here a second spelling
   * of the same thing would be unresolvable through the lookup maps and invisible to
   * `collectReferences`, which is how a link renders as `taproot:item:…` on a live page.
   */
  it('refuses a taproot: reference spelled as an address', () => {
    expect(
      store({ kind: 'url', href: 'taproot:item:11111111-1111-1111-1111-111111111111' }).success,
    ).toBe(false);
  });

  it('stores an item reference as an id, not a string to parse', () => {
    const result = store({ kind: 'item', id: '11111111-1111-1111-1111-111111111111' });
    expect(result.success).toBe(true);
    expect(result.data?.cta).toMatchObject({
      kind: 'item',
      id: '11111111-1111-1111-1111-111111111111',
      // Defaults are filled in, which is why the generated type has them as non-optional.
      newTab: false,
      noFollow: false,
    });
  });

  it('refuses a kind the field does not allow', () => {
    expect(store({ kind: 'url', href: 'https://example.edu' }, { allowedKinds: ['item'] }).success).toBe(
      false,
    );
    expect(
      store({ kind: 'item', id: '11111111-1111-1111-1111-111111111111' }, { allowedKinds: ['item'] })
        .success,
    ).toBe(true);
  });

  /** An unknown key is a shape nobody wrote deliberately, so it is refused rather than dropped. */
  it('refuses unrecognised keys', () => {
    expect(
      store({ kind: 'url', href: 'https://example.edu', onclick: 'alert(1)' }).success,
    ).toBe(false);
  });
});
