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
});

describe('blocks', () => {
  it('emits a union with both shapes a block instance can arrive in', () => {
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

    // Inline: fields at the top level. Referenced: `{ ref }` with the content filled in at read
    // time. Collapsing them would type-check code that crashes on the other shape.
    expect(out).toContain('| ({ id: string; type: "hero"; reusable?: false } & HeroData)');
    expect(out).toContain(
      '| { id: string; type: "hero"; reusable: true; ref: string; data: HeroData }',
    );
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
