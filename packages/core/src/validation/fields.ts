import { z } from 'zod';

import { htmlToText, sanitizeHtml } from '../content/sanitizeHtml.js';
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
      const max = config.maxLength as number | undefined;
      const allowedTags = Array.isArray(config.allowedFormats)
        ? (config.allowedFormats as string[])
        : undefined;

      /**
       * Sanitising happens here, inside validation, so every write path is covered by the one
       * function that already runs on every write. The editor cannot be the boundary — the REST
       * API takes a richtext value from any client with a session.
       *
       * The transform runs before the checks below, so length is measured on what will actually be
       * stored rather than on markup that is about to be thrown away.
       */
      schema = z
        .string()
        .transform((html) => sanitizeHtml(html, { allowedTags }))
        .superRefine((html, ctx) => {
          /**
           * Length and emptiness are measured on the visible text, not the markup.
           *
           * Two reasons. An editor asked for "300 characters" means words, not tags — counting
           * `<strong>` against their budget is inexplicable from the outside. And an empty
           * richtext editor emits `<p></p>`, which is 7 characters that a naive `.min(1)` on the
           * HTML would happily accept as content, letting a required field be satisfied by
           * nothing at all.
           */
          const text = htmlToText(html);

          if (required && text.length === 0) {
            ctx.addIssue({ code: 'custom', message: 'This field is required.' });
          }
          if (typeof max === 'number' && text.length > max) {
            ctx.addIssue({
              code: 'custom',
              message: `Must be ${max} characters or fewer (currently ${text.length}).`,
            });
          }
        });
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
      /**
       * Only the envelope is checked here; each block's own fields are validated separately.
       *
       * The contents depend on the block type's schema, which this function has no access to —
       * `validateItemData` resolves them against the registry it is given. Splitting it that way
       * keeps `buildValueSchema` a pure function of one field definition, which is what lets it be
       * called from the content-type builder's preview with nothing else loaded.
       */
      schema = z.array(
        z.object({
          id: z.string().min(1),
          type: z.string().min(1),
          data: z.record(z.string(), z.unknown()).default({}),
        }),
      );
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

/** One block placed into a `block` field. */
export interface BlockInstance {
  /** Stable across saves, so reordering does not remount every editor and lose focus. */
  id: string;
  /** The block type's `api_id`. */
  type: string;
  data: Record<string, unknown>;
}

export interface ValidateItemOptions {
  /**
   * Block type schemas keyed by `api_id`, from `blockTypeRegistry`.
   *
   * Omitted, block contents pass through unvalidated — which is right for the content-type
   * builder's preview, where no blocks exist, and wrong for a write. `createItem` and `updateItem`
   * always pass it.
   */
  blockTypes?: Map<string, { fields: FieldRow[] }>;
}

/**
 * Validate a content item's field values against its content type's fields.
 *
 * Unknown keys are dropped rather than rejected: a field removed from the content type should not
 * make every existing item unsavable, and keeping stale keys would let deleted fields resurface.
 */
export function validateItemData(
  fields: FieldRow[],
  data: unknown,
  options: ValidateItemOptions = {},
): ItemValidationResult {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { success: false, errors: { _: ['Field data must be an object.'] } };
  }

  const input = data as Record<string, unknown>;
  const parsed: Record<string, unknown> = {};
  const errors: Record<string, string[]> = {};

  for (const field of fields) {
    const schema = buildValueSchema(field);
    const result = schema.safeParse(input[field.api_id]);

    if (!result.success) {
      errors[field.api_id] = result.error.issues.map(formatIssue);
      continue;
    }

    if (result.data === undefined) continue;

    if (field.type === 'block' && options.blockTypes) {
      const blocks = validateBlocks(
        field,
        result.data as BlockInstance[],
        options.blockTypes,
        options,
      );
      if (blocks.errors.length > 0) errors[field.api_id] = blocks.errors;
      else parsed[field.api_id] = blocks.value;
      continue;
    }

    parsed[field.api_id] = result.data;
  }

  return Object.keys(errors).length > 0
    ? { success: false, errors }
    : { success: true, data: parsed, errors: {} };
}

/**
 * Validate each block against its own type's fields.
 *
 * Errors are flattened onto the parent field rather than returned per block, because the editor
 * shows blocks as a list under one label and has nowhere to put a per-block error map. The message
 * carries the position and the block type so it still says which one to fix.
 *
 * A block whose type no longer exists is an error rather than a silent drop: deleting a block type
 * that is still in use should be visible, not something that quietly empties pages. The block type
 * delete path refuses while blocks reference it, so reaching this means something unusual happened.
 */
function validateBlocks(
  field: FieldRow,
  blocks: BlockInstance[],
  registry: Map<string, { fields: FieldRow[] }>,
  options: ValidateItemOptions,
): { value: BlockInstance[]; errors: string[] } {
  const config = parseJson<Record<string, unknown>>(field.config, {});
  const allowed = Array.isArray(config.allowedBlocks) ? (config.allowedBlocks as string[]) : [];
  const max = typeof config.maxBlocks === 'number' ? config.maxBlocks : undefined;

  const errors: string[] = [];
  const value: BlockInstance[] = [];

  if (max !== undefined && blocks.length > max) {
    errors.push(`At most ${max} block${max === 1 ? '' : 's'} allowed (found ${blocks.length}).`);
  }

  blocks.forEach((block, index) => {
    const position = `Block ${index + 1}`;
    const blockType = registry.get(block.type);

    if (!blockType) {
      errors.push(`${position}: unknown block type "${block.type}".`);
      return;
    }

    // An empty allow-list means "any block type", matching the field config's documented default.
    if (allowed.length > 0 && !allowed.includes(block.type)) {
      errors.push(`${position}: "${block.type}" is not allowed in this field.`);
      return;
    }

    // Recursive, so a block containing a block field is validated all the way down. The registry is
    // passed through unchanged; depth is bounded in practice by the editor, which does not offer a
    // block field inside a block type.
    const nested = validateItemData(blockType.fields, block.data, options);

    if (nested.success) {
      value.push({ id: block.id, type: block.type, data: nested.data ?? {} });
    } else {
      for (const [apiId, messages] of Object.entries(nested.errors)) {
        errors.push(`${position} (${block.type}) — ${apiId}: ${messages.join(' ')}`);
      }
    }
  });

  return { value, errors };
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
  kind: z.enum(['page', 'collection', 'singleton', 'block']),
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
