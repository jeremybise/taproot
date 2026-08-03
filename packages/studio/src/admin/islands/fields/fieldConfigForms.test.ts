import { describe, expect, it } from 'vitest';
import {
  FIELD_TYPES,
  FIELD_TYPE_META,
  fieldConfigSchemas,
  parseFieldConfig,
  type FieldType,
} from '@taprootcms/core';

import { fieldConfigForms } from './FieldConfigForm.js';

/**
 * Keeps the builder's UI honest against core's schemas.
 *
 * The failure this prevents is quiet: add a field type to core, forget the config form, and the
 * builder renders an empty options panel with no error anywhere. These assertions turn that into
 * a failing test instead.
 */

describe('field config form registry', () => {
  it('has a form for every field type core defines', () => {
    const missing = FIELD_TYPES.filter((type) => !fieldConfigForms[type]);
    expect(missing).toEqual([]);
  });

  it('has no forms for types core does not define', () => {
    const known = new Set<string>(FIELD_TYPES);
    const extra = Object.keys(fieldConfigForms).filter((type) => !known.has(type));
    expect(extra).toEqual([]);
  });

  it('has display metadata for every field type', () => {
    for (const type of FIELD_TYPES) {
      const meta = FIELD_TYPE_META[type];
      expect(meta, `missing metadata for ${type}`).toBeDefined();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it('has a config schema for every field type', () => {
    for (const type of FIELD_TYPES) {
      expect(fieldConfigSchemas[type], `missing schema for ${type}`).toBeDefined();
    }
  });
});

describe('config round-trips through core validation', () => {
  // What the builder's forms actually emit for each type, so a form producing a shape the server
  // rejects fails here rather than at save time in the browser.
  const emitted: Record<FieldType, Record<string, unknown>> = {
    text: { multiline: true, minLength: 2, maxLength: 200, placeholder: 'Hi', pattern: '^a+$' },
    richtext: { maxLength: 5000 },
    number: { min: 0, max: 10, integer: true, step: 1 },
    boolean: { defaultValue: true },
    date: { includeTime: true, min: '2026-01-01', max: '2027-01-01' },
    select: { options: [{ label: 'A', value: 'a' }], multiple: true },
    media: { multiple: true, accept: ['image/'] },
    taxonomy: { taxonomyId: 'tax1', multiple: true },
    relation: { targetContentTypeId: 'abc', multiple: false, reverseLabel: 'Referenced by' },
    link: { allowedKinds: ['item', 'url'] },
    block: { allowedBlocks: [], maxBlocks: 4 },
    repeater: { minItems: 0, maxItems: 5, fields: [] },
  };

  for (const type of FIELD_TYPES) {
    it(`accepts what the ${type} form emits`, () => {
      const result = parseFieldConfig(type, emitted[type]);
      expect(result.success, `${type}: ${!result.success ? result.issues.join('; ') : ''}`).toBe(
        true,
      );
    });

    it(`accepts an empty ${type} config and fills defaults`, () => {
      // Every form starts from {} when a field type is chosen, so this must always be valid.
      const result = parseFieldConfig(type, {});
      if (type === 'select') {
        // A select with no options is genuinely invalid — the form says so and blocks saving.
        expect(result.success).toBe(false);
      } else {
        expect(result.success, `${type} rejected an empty config`).toBe(true);
      }
    });
  }
});
