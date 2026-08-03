import { describe, expect, it } from 'vitest';
import type { FieldRow } from '@taprootcms/core';

import { reachableFields, walkStoredValues } from './fieldTree.js';
import type { BlockTypeOption } from './islands/fields/BlockListEditor.js';

/**
 * The walk behind the editor's field-level options.
 *
 * The bug it exists for: a relation field inside a block type or a repeater row was reachable by an
 * editor and invisible to `relationTargetsForFields`, so the control rendered "Items of the target
 * type are listed here in the item editor" — advice naming the screen it was already on. Same for
 * `taxonomy`.
 */

function field(partial: Partial<FieldRow> & { api_id: string; type: string }): FieldRow {
  return {
    id: `field-${partial.api_id}`,
    content_type_id: 'type-1',
    label: partial.api_id,
    help_text: null,
    position: 0,
    required: 0,
    localized: 0,
    config: '{}',
    ...partial,
  } as FieldRow;
}

const relation = (apiId: string, target: string) =>
  field({ api_id: apiId, type: 'relation', config: JSON.stringify({ targetContentTypeId: target }) });

const sliderType: BlockTypeOption = {
  api_id: 'slider',
  name: 'Slider',
  fields: [
    field({
      api_id: 'slides',
      type: 'repeater',
      config: JSON.stringify({
        fields: [
          { api_id: 'headline', label: 'Headline', type: 'text', required: false, config: {} },
          {
            api_id: 'button_link',
            label: 'Button link',
            type: 'relation',
            required: false,
            config: { targetContentTypeId: 'page-type' },
          },
        ],
      }),
    }),
  ],
} as unknown as BlockTypeOption;

describe('reachableFields', () => {
  it('finds a relation nested in a repeater inside a block type', () => {
    const found = reachableFields([field({ api_id: 'sections', type: 'block' })], [sliderType]);

    const targets = found.filter((f) => f.type === 'relation').map((f) => f.api_id);
    expect(targets).toContain('button_link');
  });

  /**
   * The reason this walks the schema and not the item's data.
   *
   * An editor adds a Slider to an empty page *after* this screen rendered, and the relation inside it
   * has to offer candidates when they do. Resolving from stored data would leave the control dead on
   * exactly the screens where somebody is composing rather than revising.
   */
  it('finds it when no block has been placed yet', () => {
    const found = reachableFields([field({ api_id: 'sections', type: 'block' })], [sliderType]);
    expect(found.some((f) => f.api_id === 'button_link')).toBe(true);
  });

  it('finds a relation in a top-level repeater', () => {
    const found = reachableFields([
      field({
        api_id: 'links',
        type: 'repeater',
        config: JSON.stringify({
          fields: [
            {
              api_id: 'target',
              label: 'Target',
              type: 'relation',
              required: false,
              config: { targetContentTypeId: 'page-type' },
            },
          ],
        }),
      }),
    ]);

    expect(found.some((f) => f.api_id === 'target' && f.type === 'relation')).toBe(true);
  });
});

describe('walkStoredValues', () => {
  it('reaches a value inside a repeater row inside a block', () => {
    const seen: [string, unknown][] = [];

    walkStoredValues(
      [field({ api_id: 'sections', type: 'block' })],
      {
        sections: [
          {
            id: 'b1',
            type: 'slider',
            data: {
              slides: [
                { id: 'r1', data: { headline: 'One', button_link: 'item-42' } },
                { id: 'r2', data: { headline: 'Two' } },
              ],
            },
          },
        ],
      },
      { blockTypes: [sliderType] },
      (f, value) => seen.push([f.api_id, value]),
    );

    expect(seen).toContainEqual(['button_link', 'item-42']);
  });

  /** A referencing page stores no copy, so the values have to come from the library entry. */
  it('reads a reusable block’s values from the library entry', () => {
    const seen: [string, unknown][] = [];

    walkStoredValues(
      [field({ api_id: 'sections', type: 'block' })],
      { sections: [{ id: 'b1', type: 'slider', ref: 'lib-1' }] },
      {
        blockTypes: [sliderType],
        reusableBlocks: [
          {
            id: 'lib-1',
            name: 'Shared slider',
            block_type: 'slider',
            data: { slides: [{ id: 'r1', data: { button_link: 'item-99' } }] },
          },
        ],
      },
      (f, value) => seen.push([f.api_id, value]),
    );

    expect(seen).toContainEqual(['button_link', 'item-99']);
  });

  it('survives rows and blocks that are not the shape it expects', () => {
    expect(() =>
      walkStoredValues(
        [field({ api_id: 'sections', type: 'block' })],
        { sections: [null, 'nonsense', { id: 'b1', type: 'unknown_type', data: null }] },
        { blockTypes: [sliderType] },
        () => {},
      ),
    ).not.toThrow();
  });
});
