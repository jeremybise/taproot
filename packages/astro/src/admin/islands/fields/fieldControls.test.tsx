// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FIELD_TYPES, DEFERRED_FIELD_TYPES, type FieldRow, type FieldType } from '@taproot/core';

import { FieldControl } from './FieldControl.js';

/**
 * Every field type has an editing control, or is honestly declared as not having one.
 *
 * `fieldConfigForms.test.ts` has always asserted the other half — that every type has a *config*
 * form — and the absence of this counterpart is why `relation` went two phases with a config form,
 * server-side validation, and no way for an editor to fill it in. The builder happily offered the
 * field; the item editor rendered a placeholder promising a phase that had already shipped.
 *
 * The point is the pairing: a new field type cannot be added without either building its control
 * or saying out loud that it has none.
 */

const CONFIG: Partial<Record<FieldType, Record<string, unknown>>> = {
  select: { options: [{ label: 'One', value: 'one' }], multiple: false },
  taxonomy: { taxonomyId: 'tax-1', multiple: false },
  relation: { targetContentTypeId: 'ct-1', multiple: false },
};

function field(type: FieldType): FieldRow {
  return {
    id: `f-${type}`,
    content_type_id: 'ct',
    api_id: type,
    label: `A ${type}`,
    type,
    help_text: null,
    position: 0,
    required: 0,
    localized: 0,
    config: JSON.stringify(CONFIG[type] ?? {}),
    created_at: '',
    updated_at: '',
  } as FieldRow;
}

function renderType(type: FieldType) {
  return render(
    <FieldControl
      field={field(type)}
      value={undefined}
      onChange={() => {}}
      termsByTaxonomy={{ 'tax-1': [{ id: 't1', name: 'Term', depth: 0 }] }}
      relationTargets={{
        'ct-1': {
          contentTypeId: 'ct-1',
          name: 'Event',
          namePlural: 'Events',
          items: [],
          total: 0,
        },
      }}
      blockTypes={[]}
    />,
  );
}

afterEach(cleanup);

describe('editing controls', () => {
  it('only defers types that exist', () => {
    // A typo here would silently exempt nothing and quietly leave a real type unasserted below,
    // since the loops are generated from this list.
    for (const type of DEFERRED_FIELD_TYPES) {
      expect(FIELD_TYPES).toContain(type);
    }
  });

  for (const type of FIELD_TYPES.filter((t) => !DEFERRED_FIELD_TYPES.includes(t))) {
    it(`renders a real control for ${type}`, () => {
      renderType(type);

      // The placeholder is the exact thing this test exists to catch. A type that claims to be
      // built and renders "not built yet" is the bug relation shipped with.
      expect(screen.queryByText(/editor is not built yet/)).toBeNull();
    });
  }

  for (const type of DEFERRED_FIELD_TYPES) {
    it(`says plainly that ${type} has no editor`, () => {
      renderType(type);

      // The other direction: a deferred type must not silently render nothing, which would look
      // like a control that does not work rather than one that does not exist.
      expect(screen.getByText(/editor is not built yet/)).toBeTruthy();
    });
  }

  it('does not mention a phase number to the person using the CMS', () => {
    /**
     * The picker used to badge every field type with the phase its editor was planned for, so a
     * campus editor was told rich text, media, taxonomy, and blocks were forthcoming years after
     * they shipped. Plan vocabulary belongs in SCOPE.md, not in the product.
     */
    for (const type of FIELD_TYPES) {
      const { container } = renderType(type);
      expect(container.textContent).not.toMatch(/Phase \d/);
      cleanup();
    }
  });
});
