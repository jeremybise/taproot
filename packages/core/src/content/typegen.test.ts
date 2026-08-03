import { describe, expect, it } from 'vitest';

import { generateTypes, typeName } from './typegen.js';
import type { DeliveryField, DeliverySchema } from './delivery.js';

/**
 * Type generation from the live content model.
 *
 * SCOPE calls this "the point of the split rather than a nicety": a consumer wants types for *their*
 * content types, not for Taproot's table rows. What is worth testing is the handful of places the
 * generated text can be subtly wrong in a way that still looks plausible.
 */

function field(partial: Partial<DeliveryField> & Pick<DeliveryField, 'apiId' | 'type'>): DeliveryField {
  return {
    label: partial.apiId,
    required: false,
    helpText: null,
    position: 0,
    config: {},
    ...partial,
  };
}

function schema(partial: Partial<DeliverySchema>): DeliverySchema {
  return { contentTypes: [], blockTypes: [], ...partial };
}

describe('field types', () => {
  it('makes a required field non-optional and an optional one optional', () => {
    const out = generateTypes(
      schema({
        contentTypes: [
          {
            apiId: 'page',
            name: 'Page',
            namePlural: 'Pages',
            kind: 'page',
            urlPrefix: null,
            fields: [
              field({ apiId: 'title', type: 'text', required: true }),
              field({ apiId: 'body', type: 'text' }),
            ],
          },
        ],
      }),
    );

    expect(out).toContain('title: string;');
    expect(out).toContain('body?: string;');
  });

  /**
   * `media` and `relation` store a bare id when single and an array when multiple, following their
   * own config. Getting this wrong is exactly the class of bug generated types exist to prevent.
   */
  it('follows a media field’s own config for whether it is an array', () => {
    const out = generateTypes(
      schema({
        contentTypes: [
          {
            apiId: 'page',
            name: 'Page',
            namePlural: 'Pages',
            kind: 'page',
            urlPrefix: null,
            fields: [
              field({ apiId: 'cover', type: 'media' }),
              field({ apiId: 'gallery', type: 'media', config: { multiple: true } }),
            ],
          },
        ],
      }),
    );

    expect(out).toContain('cover?: MediaId;');
    expect(out).toContain('gallery?: MediaId[];');
  });

  it('turns select options into a union, and falls back to string without them', () => {
    const out = generateTypes(
      schema({
        contentTypes: [
          {
            apiId: 'page',
            name: 'Page',
            namePlural: 'Pages',
            kind: 'page',
            urlPrefix: null,
            fields: [
              field({ apiId: 'tone', type: 'select', config: { options: ['calm', 'urgent'] } }),
              field({ apiId: 'freeform', type: 'select' }),
            ],
          },
        ],
      }),
    );

    expect(out).toContain('tone?: "calm" | "urgent";');
    // A wrong narrow type would be worse than a wide one.
    expect(out).toContain('freeform?: string;');
  });

  /**
   * The bug this caught in practice: a repeater's sub-fields are stored in the `FieldRow` shape
   * (`api_id`), never having been rows in the `fields` table. Reading them as delivery fields
   * generated a row of properties literally named `undefined` — which type-checks and is nonsense.
   */
  it('reads a repeater’s sub-fields in their stored shape', () => {
    const out = generateTypes(
      schema({
        contentTypes: [
          {
            apiId: 'event',
            name: 'Event',
            namePlural: 'Events',
            kind: 'collection',
            urlPrefix: 'events',
            fields: [
              field({
                apiId: 'schedule',
                type: 'repeater',
                config: {
                  fields: [
                    { api_id: 'time', label: 'Time', type: 'text', required: true, config: {} },
                    { api_id: 'room', label: 'Room', type: 'text', required: false, config: {} },
                  ],
                },
              }),
            ],
          },
        ],
      }),
    );

    expect(out).toContain('time: string;');
    expect(out).toContain('room?: string;');
    expect(out).not.toContain('undefined:');
  });

  /**
   * The row is an envelope, and this emitted the inside of it.
   *
   * A repeater stores `{ id, data: { …sub-fields } }` — `buildValueSchema` validates that, the
   * editor writes it, and `resolveDelivery` sends it. Emitting the sub-fields flat let a consumer
   * write `row.headline` against a payload that only ever carries `row.data.headline`: it compiled,
   * rendered nothing, and reported no error anywhere. Asserting the sub-field *names* appear was
   * what let it pass — they appear either way, which is why the test above did not catch this.
   */
  it('wraps a repeater’s rows in their stored envelope', () => {
    const out = generateTypes(
      schema({
        contentTypes: [
          {
            apiId: 'event',
            name: 'Event',
            namePlural: 'Events',
            kind: 'collection',
            urlPrefix: 'events',
            fields: [
              field({
                apiId: 'schedule',
                type: 'repeater',
                config: {
                  fields: [
                    { api_id: 'time', label: 'Time', type: 'text', required: true, config: {} },
                  ],
                },
              }),
            ],
          },
        ],
      }),
    );

    expect(out).toContain('schedule?: {\n    id: string;\n    data: {\n      time: string;\n    };\n  }[];');
  });

  /** No describable sub-fields still means a row, because the envelope does not depend on them. */
  it('keeps the envelope when a repeater declares no sub-fields', () => {
    const out = generateTypes(
      schema({
        contentTypes: [
          {
            apiId: 'event',
            name: 'Event',
            namePlural: 'Events',
            kind: 'collection',
            urlPrefix: 'events',
            fields: [field({ apiId: 'rows', type: 'repeater', config: {} })],
          },
        ],
      }),
    );

    expect(out).toContain('rows?: { id: string; data: Record<string, unknown> }[];');
  });
});

describe('blocks', () => {
  /**
   * The fields live under `data`, always.
   *
   * An earlier version emitted two members per block type — inline with fields at the top level,
   * referencing with them under `data`. Plausible and wrong: `BlockInstance` always has `data`, and
   * `ref` only says the library owns the content. Templates written against the guessed shape would
   * have compiled and read `undefined` from every field, which is the worst way for a generated
   * type to be wrong.
   */
  it('puts a block’s fields under data, with ref optional', () => {
    const out = generateTypes(
      schema({
        blockTypes: [
          {
            apiId: 'hero',
            name: 'Hero',
            namePlural: 'Heroes',
            kind: 'block',
            urlPrefix: null,
            fields: [field({ apiId: 'heading', type: 'text', required: true })],
          },
        ],
      }),
    );

    expect(out).toContain('| { id: string; type: "hero"; data: HeroData; ref?: string }');
    // The shape that was guessed and is wrong — asserted absent so it cannot come back.
    expect(out).not.toContain('reusable?: false');
  });
});

describe('the emitted file', () => {
  /** A `.d.ts` may declare but not implement. A generated function body is a syntax error there. */
  it('contains no runtime code', () => {
    const out = generateTypes(
      schema({
        contentTypes: [
          {
            apiId: 'page',
            name: 'Page',
            namePlural: 'Pages',
            kind: 'page',
            urlPrefix: null,
            fields: [field({ apiId: 'body', type: 'text' })],
          },
        ],
      }),
    );

    expect(out).not.toContain('export function');
    expect(out).not.toContain('export const');
  });

  it('quotes an api_id that is not a valid identifier', () => {
    const out = generateTypes(
      schema({
        contentTypes: [
          {
            apiId: 'page',
            name: 'Page',
            namePlural: 'Pages',
            kind: 'page',
            urlPrefix: null,
            fields: [field({ apiId: 'not-an-identifier', type: 'text' })],
          },
        ],
      }),
    );

    expect(out).toContain('"not-an-identifier"?: string;');
  });

  it('says it is generated, and how to regenerate it', () => {
    const out = generateTypes(schema({}), { source: 'https://cms.example.edu/…' });
    expect(out).toContain('Do not edit by hand');
    expect(out).toContain('npm run taproot:types');
    expect(out).toContain('https://cms.example.edu/…');
  });
});

describe('naming', () => {
  it('turns an api_id into a pascal-case type name', () => {
    expect(typeName('staff_profile')).toBe('StaffProfile');
    expect(typeName('event')).toBe('Event');
    expect(typeName('call-to-action')).toBe('CallToAction');
  });
});

describe('link fields', () => {
  const linkType = (config: Record<string, unknown> = {}) =>
    generateTypes(
      schema({
        contentTypes: [
          {
            apiId: 'page',
            name: 'Page',
            namePlural: 'Pages',
            kind: 'page',
            urlPrefix: null,
            fields: [field({ apiId: 'cta', type: 'link', config })],
          },
        ],
      }),
    );

  /**
   * Ids, not resolved objects — the same rule `media` and `relation` follow. Typing the target as
   * the page it points at would describe a payload Taproot does not send.
   */
  it('emits a union discriminated by kind, with ids for the references', () => {
    const out = linkType();

    expect(out).toContain('kind: "item"; id: ContentItemId');
    expect(out).toContain('kind: "media"; id: MediaId');
    expect(out).toContain('kind: "url"; href: string');
  });

  /** `newTab` and `noFollow` default to false in the config schema, so a stored link always has them. */
  it('does not mark the options optional, because validation fills them in', () => {
    expect(linkType()).toContain('newTab: boolean; noFollow: boolean');
  });

  it('narrows to the kinds the field allows', () => {
    const out = linkType({ allowedKinds: ['item'] });

    expect(out).toContain('kind: "item"');
    expect(out).not.toContain('kind: "url"');
    expect(out).not.toContain('kind: "media"');
  });
});
