import { z } from 'zod';

import type { FieldRow, FieldType } from '../db/schema.js';
import { parseJson } from '../db/values.js';

/**
 * The field-type registry.
 *
 * Two distinct schemas exist per field type and it is worth keeping them straight:
 *
 * - **config schema** — validates the field *definition* an author creates in the content-type
 *   builder ("this select has these three options"). Phase 1's visual builder renders its form
 *   from this.
 * - **value schema** — validates a content item's *value* for that field ("this item's status is
 *   one of those three options"). Built per field, because it depends on that field's config.
 *
 * Adding a field type means adding one entry here; nothing else in the system enumerates types.
 */

// ---------------------------------------------------------------------------
// Field configuration schemas
// ---------------------------------------------------------------------------

const selectOption = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
});

export const fieldConfigSchemas = {
  text: z.object({
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    multiline: z.boolean().default(false),
    placeholder: z.string().optional(),
    pattern: z.string().optional(),
  }),
  richtext: z.object({
    /** Restricting the toolbar is also what keeps heading order sane for the a11y checker. */
    allowedFormats: z.array(z.string()).optional(),
    maxLength: z.number().int().positive().optional(),
  }),
  number: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
    integer: z.boolean().default(false),
    step: z.number().positive().optional(),
  }),
  boolean: z.object({
    defaultValue: z.boolean().default(false),
  }),
  date: z.object({
    includeTime: z.boolean().default(false),
    min: z.string().optional(),
    max: z.string().optional(),
  }),
  select: z.object({
    options: z.array(selectOption).min(1),
    multiple: z.boolean().default(false),
  }),
  media: z.object({
    multiple: z.boolean().default(false),
    /** MIME prefixes, e.g. `image/`. Empty means anything. */
    accept: z.array(z.string()).default([]),
  }),
  taxonomy: z.object({
    /**
     * Nullable so a field can be added before its taxonomy exists — the content type builder lets
     * you design a type first and point the field at a taxonomy later. The editor renders an
     * explicit "not pointed at a taxonomy yet" notice rather than an empty picker.
     */
    taxonomyId: z.string().nullable().default(null),
    multiple: z.boolean().default(true),
  }),
  relation: z.object({
    /** The content type this field points at. */
    targetContentTypeId: z.string().nullable().default(null),
    multiple: z.boolean().default(false),
    /** Label shown on the reverse side of the relation in the target type's editor. */
    reverseLabel: z.string().optional(),
  }),
  block: z.object({
    /** Block presets allowed in this region. Empty means all. Phase 2. */
    allowedBlocks: z.array(z.string()).default([]),
    maxBlocks: z.number().int().positive().optional(),
  }),
  repeater: z.object({
    minItems: z.number().int().nonnegative().default(0),
    maxItems: z.number().int().positive().optional(),
    /** Sub-field definitions. Phase 2. */
    fields: z.array(z.unknown()).default([]),
  }),
} as const satisfies Record<FieldType, z.ZodType>;

export type FieldConfig<T extends FieldType> = z.infer<(typeof fieldConfigSchemas)[T]>;

export const FIELD_TYPES = Object.keys(fieldConfigSchemas) as FieldType[];

/** Field types whose editing UI is not implemented yet, surfaced so the builder can label them. */
export const DEFERRED_FIELD_TYPES: FieldType[] = ['block', 'repeater'];

export interface FieldTypeMeta {
  type: FieldType;
  label: string;
  description: string;
  /** Phase in which the editing UI becomes available. */
  availableIn: 0 | 1 | 2;
}

export const FIELD_TYPE_META: Record<FieldType, FieldTypeMeta> = {
  text: { type: 'text', label: 'Text', description: 'A single line or paragraph of plain text.', availableIn: 0 },
  richtext: { type: 'richtext', label: 'Rich text', description: 'Formatted text with headings and links.', availableIn: 1 },
  number: { type: 'number', label: 'Number', description: 'A numeric value.', availableIn: 0 },
  boolean: { type: 'boolean', label: 'Toggle', description: 'A true/false switch.', availableIn: 0 },
  date: { type: 'date', label: 'Date', description: 'A date, optionally with a time.', availableIn: 0 },
  select: { type: 'select', label: 'Select', description: 'One or more choices from a fixed list.', availableIn: 0 },
  media: { type: 'media', label: 'Media', description: 'An image or file from the media library.', availableIn: 1 },
  taxonomy: { type: 'taxonomy', label: 'Taxonomy', description: 'Terms from a taxonomy tree.', availableIn: 1 },
  relation: { type: 'relation', label: 'Relation', description: 'A reference to other content items.', availableIn: 1 },
  block: { type: 'block', label: 'Blocks', description: 'Composable blocks placed into a region.', availableIn: 2 },
  repeater: { type: 'repeater', label: 'Repeater', description: 'A repeating group of sub-fields.', availableIn: 2 },
};

/**
 * Validate and normalise a field's stored config, filling in defaults.
 *
 * Returns the parsed config on success and the issues on failure rather than throwing, so the
 * content-type builder can show errors next to the offending input.
 */
export function parseFieldConfig(
  type: FieldType,
  raw: unknown,
): { success: true; config: Record<string, unknown> } | { success: false; issues: string[] } {
  const schema = fieldConfigSchemas[type];
  if (!schema) return { success: false, issues: [`Unknown field type "${type}".`] };

  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    return { success: false, issues: result.error.issues.map(formatIssue) };
  }
  return { success: true, config: result.data as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Value schemas
// ---------------------------------------------------------------------------

/**
 * Build the Zod schema for a single field's *value*, from that field's stored definition.
 *
 * Optional fields accept `null` and `undefined` rather than only being absent, because an editor
 * clearing an input sends an explicit null.
 */
export function buildValueSchema(field: FieldRow): z.ZodType {
  const config = parseJson<Record<string, unknown>>(field.config, {});
  const required = field.required === 1;

  let schema: z.ZodType;

  switch (field.type) {
    case 'text': {
      let text = z.string();
      const min = config.minLength as number | undefined;
      const max = config.maxLength as number | undefined;
      if (typeof min === 'number') text = text.min(min);
      if (typeof max === 'number') text = text.max(max);
      if (typeof config.pattern === 'string' && config.pattern) {
        try {
          text = text.regex(new RegExp(config.pattern));
        } catch {
          // An invalid stored pattern must not break editing; the constraint is simply skipped.
        }
      }
      // A required text field should reject the empty string, not just a missing key.
      schema = required ? text.min(Math.max(1, (min as number) ?? 1)) : text;
      break;
    }

    case 'richtext': {
      let rich = z.string();
      const max = config.maxLength as number | undefined;
      if (typeof max === 'number') rich = rich.max(max);
      schema = required ? rich.min(1) : rich;
      break;
    }

    case 'number': {
      let num = z.number();
      if (config.integer === true) num = num.int();
      if (typeof config.min === 'number') num = num.min(config.min);
      if (typeof config.max === 'number') num = num.max(config.max);
      schema = num;
      break;
    }

    case 'boolean':
      schema = z.boolean();
      break;

    case 'date':
      // ISO-8601, matching how dates are stored everywhere else.
      schema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
        message: 'Must be a valid ISO-8601 date.',
      });
      break;

    case 'select': {
      const values = ((config.options as { value: string }[] | undefined) ?? []).map((o) => o.value);
      const single: z.ZodType =
        values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string();
      schema = config.multiple === true ? z.array(single) : single;
      break;
    }

    case 'media': {
      const single = z.string();
      schema = config.multiple === true ? z.array(single) : single;
      break;
    }

    case 'taxonomy':
      schema = config.multiple === false ? z.string() : z.array(z.string());
      break;

    case 'relation':
      schema = config.multiple === true ? z.array(z.string()) : z.string();
      break;

    case 'block':
      // Block payloads are validated by the block registry in Phase 2.
      schema = z.array(z.record(z.string(), z.unknown()));
      break;

    case 'repeater':
      schema = z.array(z.record(z.string(), z.unknown()));
      break;

    default: {
      const exhaustive: never = field.type;
      throw new Error(`Unhandled field type: ${String(exhaustive)}`);
    }
  }

  return required ? schema : schema.nullish();
}

export interface ItemValidationResult {
  success: boolean;
  /** Parsed values, present only on success. */
  data?: Record<string, unknown>;
  /** Issues keyed by field `api_id`, so the editor can show each next to its input. */
  errors: Record<string, string[]>;
}

/**
 * Validate a content item's field values against its content type's fields.
 *
 * Unknown keys are dropped rather than rejected: a field removed from the content type should not
 * make every existing item unsavable, and keeping stale keys would let deleted fields resurface.
 */
export function validateItemData(fields: FieldRow[], data: unknown): ItemValidationResult {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { success: false, errors: { _: ['Field data must be an object.'] } };
  }

  const input = data as Record<string, unknown>;
  const parsed: Record<string, unknown> = {};
  const errors: Record<string, string[]> = {};

  for (const field of fields) {
    const schema = buildValueSchema(field);
    const result = schema.safeParse(input[field.api_id]);

    if (result.success) {
      if (result.data !== undefined) parsed[field.api_id] = result.data;
    } else {
      errors[field.api_id] = result.error.issues.map(formatIssue);
    }
  }

  return Object.keys(errors).length > 0
    ? { success: false, errors }
    : { success: true, data: parsed, errors: {} };
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

// ---------------------------------------------------------------------------
// Content type / field definition schemas (used by the admin API)
// ---------------------------------------------------------------------------

/** Machine names must be safe as both an object key and a URL segment. */
export const apiIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Must start with a lowercase letter and contain only lowercase letters, numbers, and underscores.',
  );

export const contentTypeInputSchema = z.object({
  api_id: apiIdSchema,
  name: z.string().min(1).max(120),
  name_plural: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  kind: z.enum(['page', 'collection', 'singleton']),
  icon: z.string().max(64).nullish(),
  url_prefix: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be a lowercase, hyphenated URL segment.')
    .nullish(),
  title_field: z.string().nullish(),
  /** Social-card image for items of this type that have not chosen one. */
  default_og_image_id: z.string().nullish(),
});

export const fieldInputSchema = z.object({
  api_id: apiIdSchema,
  label: z.string().min(1).max(120),
  type: z.enum(FIELD_TYPES as [FieldType, ...FieldType[]]),
  help_text: z.string().max(500).nullish(),
  required: z.boolean().default(false),
  localized: z.boolean().default(false),
  position: z.number().int().nonnegative().default(0),
  config: z.record(z.string(), z.unknown()).default({}),
});

export type ContentTypeInput = z.infer<typeof contentTypeInputSchema>;
export type FieldInput = z.infer<typeof fieldInputSchema>;
