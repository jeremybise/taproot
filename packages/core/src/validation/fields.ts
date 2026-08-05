import { z } from 'zod';

import { htmlToText, safeUrl, sanitizeHtml } from '../content/sanitizeHtml.js';
import type { FieldRow, FieldType } from '../db/schema.js';
import { parseJson, stringifyJson } from '../db/values.js';
import { ITEM_SORTS } from '../content/itemSort.js';
import { isFieldVisible, visibilityCondition } from './visibility.js';

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

/**
 * Field types a repeater row may contain.
 *
 * Everything that describes *a value*, and nothing that composes a page. `block` is excluded
 * because blocks are how a page is assembled and a repeater is how one field holds several of
 * something — nesting the first inside the second confuses two different jobs. `repeater` is
 * excluded because a table of tables is a data model, not a field, and the person reaching for it
 * wants a content type with a relation.
 *
 * Stated as an allowlist so a field type added later is excluded until somebody decides otherwise,
 * rather than silently becoming nestable.
 */
export const REPEATER_SUB_FIELD_TYPES = [
  'text',
  'richtext',
  'number',
  'boolean',
  'date',
  'select',
  'media',
  'taxonomy',
  'relation',
  // A row of buttons is the case this whole field type was added for, and a repeater is how a row
  // of anything is spelled here.
  'link',
] as const satisfies readonly FieldType[];

export type RepeaterSubFieldType = (typeof REPEATER_SUB_FIELD_TYPES)[number];

/**
 * One sub-field definition.
 *
 * Shaped like the parts of `FieldRow` that describe a field rather than locate it — no id, no
 * position, no content type. `repeaterRowFields` turns these into rows on demand so the same
 * `FieldControl` and the same validation serve them as serve a top-level field.
 */
export const repeaterSubField = z.object({
  api_id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  type: z.enum(REPEATER_SUB_FIELD_TYPES),
  required: z.boolean().default(false),
  help_text: z.string().max(500).nullish(),
  config: z.record(z.string(), z.unknown()).default({}),
  /**
   * The same conditional visibility a top-level field gets, scoped to the row.
   *
   * Stored as the condition object rather than a JSON string, because this definition already lives
   * inside JSON — `repeaterRowFields` stringifies it onto the synthesised row, exactly as it already
   * does for `config`. A row's sub-field sees that row's values and nothing wider, which is what
   * makes "show the closing time unless we are closed that day" work per row.
   */
  visible_when: visibilityCondition.nullish(),
});

export type RepeaterSubField = z.infer<typeof repeaterSubField>;

/**
 * What one link points at.
 *
 * Three kinds rather than one `href`, because the three are stored differently and only one of them
 * is a URL. An item or a file is a **reference** — an id, resolved through the delivery response's
 * `references` and `media` maps exactly as `relation` and `media` fields are — so a page that moves
 * keeps every link aimed at it and nobody edits content to fix a URL. That is the same rule menu
 * items follow, and the reason rich text stores `taproot:item:{id}` instead of a path.
 *
 * Storing the `taproot:` marker here instead was the near miss. It would have made the editor
 * control almost free, since `LinkDialog` already speaks that vocabulary — but it puts a string a
 * consumer has to parse where an id and a lookup belong, and every consumer that forgot would ship
 * `taproot:item:…` to a visitor. Rich text accepts that trade because `set:html` cannot perform a
 * lookup; a structured field has no such excuse.
 */
/**
 * What the *editor* chooses on one placement of a query field.
 *
 * The counterpart to `fieldConfigSchemas.query`: config says what may be asked, this is what was
 * asked. Every key has a default, so a block placed and never touched still resolves — the
 * alternative is a freshly added "Events" block rendering an error until somebody opens it.
 *
 * `termIds` is a list rather than one id for the reason `ItemFilters.termIds` is: an item carrying
 * any of them matches, and a term filter always means the whole branch, which `resolveItemQueries`
 * expands through `termIdsForBranch`. An **empty list means no term filter**, which is the opposite
 * of `ItemFilters`' own convention — deliberately, and the reason is which mistake is recoverable.
 * There, an empty array arrives from a caller that asked for a term with no members and matching
 * everything would silently widen a filter. Here it arrives from an editor who has not picked a
 * term yet, and matching nothing would make a newly placed block render as broken.
 */
const queryValueSchema = z.strictObject({
  termIds: z.array(z.string()).default([]),
  sort: z.enum(ITEM_SORTS).default('path'),
  limit: z.number().int().positive().default(6),
  /**
   * Whether the listing is bounded by the configured date field, and which way.
   *
   * Stored as an *intent* — "upcoming" — never as a resolved timestamp. A stored bound would be
   * frozen at whatever moment somebody last pressed save, so a page would quietly stop listing
   * anything the day after it was edited. That is the same trap a stale `publish_at` is, and the
   * same answer: the moment is computed when the query runs.
   */
  dateFilter: z.enum(['any', 'upcoming', 'past']).default('any'),
});

export type QueryValue = z.infer<typeof queryValueSchema>;

export const LINK_KINDS = ['item', 'media', 'url'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

const linkOptions = {
  /**
   * The link's own text. Optional because plenty of links take their text from elsewhere — the
   * target's title, or a separate field the site already has.
   */
  label: z.string().max(300).optional(),
  newTab: z.boolean().default(false),
  noFollow: z.boolean().default(false),
};

/**
 * A link value, narrowed to the kinds a field offers.
 *
 * The `url` variant goes through `safeUrl`, which is the sanitiser's own answer about `javascript:`
 * and friends — this is a write path whose value ends up in an `href`, so it is exactly as exposed
 * as rich text is and must not grow a second opinion. `taproot:` is *excluded* here even though
 * `safeUrl` admits it: an internal target is the `item` or `media` kind, and letting one arrive
 * spelled as a URL would be a second way to store the same thing, unresolvable through the lookup
 * maps and invisible to `collectReferences`.
 */
const itemLink = z.strictObject({
  kind: z.literal('item'),
  id: z.string().min(1),
  ...linkOptions,
});

const mediaLink = z.strictObject({
  kind: z.literal('media'),
  id: z.string().min(1),
  ...linkOptions,
});

const urlLink = z.strictObject({
  kind: z.literal('url'),
  href: z
    .string()
    .min(1)
    .refine(
      (value) => {
        const safe = safeUrl(value);
        // `safeUrl` admits `taproot:`; here it must not — see the note on this function.
        return safe !== null && !safe.toLowerCase().startsWith('taproot:');
      },
      { error: 'Must be a valid http(s), mailto:, tel: or site-relative address.' },
    ),
  ...linkOptions,
});

const LINK_VARIANTS = { item: itemLink, media: mediaLink, url: urlLink };

export function linkValueSchema(allowedKinds: LinkKind[] = []): z.ZodType {
  const allowed = allowedKinds.length > 0 ? allowedKinds : [...LINK_KINDS];
  const chosen = allowed.map((kind) => LINK_VARIANTS[kind]);

  // A single permitted kind still carries `kind`, so the stored shape never depends on the config —
  // unlike `media` and `relation`, where it deliberately does.
  if (chosen.length === 1) return chosen[0]!;

  /**
   * The cast is Zod's typing, not a shortcut: `discriminatedUnion` wants a literal tuple and this
   * array is built from a runtime list. The members are the same three objects either way.
   */
  return z.discriminatedUnion(
    'kind',
    chosen as unknown as [typeof itemLink, typeof mediaLink, ...(typeof urlLink)[]],
  );
}

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
  link: z.object({
    /**
     * Which of page, file and address the dialog offers. Empty means all three, matching `media`'s
     * `accept`.
     */
    allowedKinds: z.array(z.enum(LINK_KINDS)).default([]),
    /**
     * Deliberately no `multiple`.
     *
     * `media` and `relation` carry one because a gallery and a list of related pages are single
     * fields holding several of one thing. Several *links* is a row of buttons, which is a repeater
     * of a link field — and that composes, because each row can then carry its own heading or
     * variant. A `multiple` here would be a second way to spell the same thing, with a stored shape
     * that follows the config for no gain.
     */
  }),
  block: z.object({
    /** Block types allowed in this field. Empty means all. */
    allowedBlocks: z.array(z.string()).default([]),
    maxBlocks: z.number().int().positive().optional(),
  }),
  /**
   * What the *admin* fixes about a query, in the field builder.
   *
   * The split between this and the stored value is the feature. Config bounds what may be asked —
   * which content type, which taxonomy an editor may narrow by, how many results they may ask for —
   * and the block instance holds what *was* asked. That is what lets one "Faculty" block type serve
   * twenty department pages: same field definition, each page's editor picks their own term.
   *
   * Fixing the whole query here instead would mean a block type per department, and letting the
   * editor choose everything would mean a picker over every content type on a page where only one
   * makes sense.
   */
  query: z.object({
    /**
     * Nullable and defaulted, matching `taxonomy` and `relation`: a field can be added before its
     * target exists, and the editor renders an explicit notice rather than an empty picker.
     */
    targetContentTypeId: z.string().nullable().default(null),
    /** Which taxonomy the editor may narrow by. Null offers no term filter at all. */
    taxonomyId: z.string().nullable().default(null),
    /**
     * The `api_id` of a `date` field on the target type — what "upcoming" means and what "soonest
     * first" orders by.
     *
     * One key serving both, because for the case this exists for they are the same field: an
     * event's start date is what you filter on *and* what you sort by, and offering two pickers
     * would invite them to disagree. Null hides the date filter and both field orders.
     *
     * An `api_id` rather than a field id, so it survives the field being deleted and recreated —
     * and if it does not resolve, the filter is dropped and the sort falls back to `path` rather
     * than the listing erroring.
     */
    dateFieldApiId: z.string().nullable().default(null),
    /**
     * The ceiling on `limit`, not the limit itself.
     *
     * A bound on what the system will carry rather than a claim about completeness — so
     * `requireComplete: false` leaves it alone, and a consumer cannot be handed a thousand
     * fully-resolved items because somebody typed a big number into a block.
     */
    maxResults: z.number().int().positive().max(100).default(24),
    /** What a freshly placed block asks for before anybody touches it. */
    defaultLimit: z.number().int().positive().default(6),
  }),
  repeater: z.object({
    minItems: z.number().int().nonnegative().default(0),
    maxItems: z.number().int().positive().optional(),
    /**
     * The shape of one row.
     *
     * Stored inside this field's own config rather than as rows in the `fields` table, because a
     * sub-field is part of *this* field's definition — it has no independent existence, no content
     * item refers to it, and giving it a row would mean every query that loads a content type's
     * fields learning to exclude the ones that are really parts of another. Same reasoning that
     * keeps block instances inside `content_items.data`.
     */
    fields: z.array(repeaterSubField).default([]),
  }),
} as const satisfies Record<FieldType, z.ZodType>;

export type FieldConfig<T extends FieldType> = z.infer<(typeof fieldConfigSchemas)[T]>;

export const FIELD_TYPES = Object.keys(fieldConfigSchemas) as FieldType[];

/**
 * Field types with no editing control yet.
 *
 * **Empty**, and that is the point of keeping it: every field type the builder offers can now be
 * authored. It was a `availableIn` phase number on every type once, which the picker rendered as a
 * "Phase 1" / "Phase 2" badge — so rich text, media, taxonomy, and blocks announced themselves as
 * forthcoming to a campus editor long after they shipped, and `relation` claimed to be arriving in
 * a phase that had already been declared complete without it.
 *
 * `fieldControls.test.tsx` asserts this list matches what `FieldControl` actually renders, which is
 * what keeps it from drifting again — in either direction. A new field type added without a control
 * fails that test until it is either built or listed here.
 */
export const DEFERRED_FIELD_TYPES: FieldType[] = [];

export function fieldTypeIsDeferred(type: FieldType): boolean {
  return DEFERRED_FIELD_TYPES.includes(type);
}

export interface FieldTypeMeta {
  type: FieldType;
  label: string;
  description: string;
}

export const FIELD_TYPE_META: Record<FieldType, FieldTypeMeta> = {
  text: { type: 'text', label: 'Text', description: 'A single line or paragraph of plain text.' },
  richtext: { type: 'richtext', label: 'Rich text', description: 'Formatted text with headings and links.' },
  number: { type: 'number', label: 'Number', description: 'A numeric value.' },
  boolean: { type: 'boolean', label: 'Toggle', description: 'A true/false switch.' },
  date: { type: 'date', label: 'Date', description: 'A date, optionally with a time.' },
  select: { type: 'select', label: 'Select', description: 'One or more choices from a fixed list.' },
  media: { type: 'media', label: 'Media', description: 'An image or file from the media library.' },
  taxonomy: { type: 'taxonomy', label: 'Taxonomy', description: 'Terms from a taxonomy tree.' },
  relation: { type: 'relation', label: 'Relation', description: 'A reference to other content items.' },
  link: { type: 'link', label: 'Link', description: 'A page, a file, or a web address — with optional label.' },
  block: { type: 'block', label: 'Blocks', description: 'Composable blocks placed into a region.' },
  repeater: { type: 'repeater', label: 'Repeater', description: 'A repeating group of sub-fields.' },
  query: {
    type: 'query',
    label: 'Query',
    description: 'A live list of content, chosen by a rule rather than by hand.',
  },
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
export function buildValueSchema(
  field: FieldRow,
  options: { requireComplete?: boolean } = {},
): z.ZodType {
  const config = parseJson<Record<string, unknown>>(field.config, {});

  // Two questions kept apart deliberately. The first is a fact about the content type and never
  // changes; the second is whether *this call* is asking it. See `ValidateItemOptions`.
  const requireComplete = options.requireComplete ?? true;
  const required = field.required === 1 && requireComplete;

  let schema: z.ZodType;

  switch (field.type) {
    case 'text': {
      let text = z.string();
      // `minLength` travels with `required`, for the same reason: it is a floor on a *finished*
      // value, and a half-typed one has not reached it yet. `maxLength` below does not move.
      const min = requireComplete ? (config.minLength as number | undefined) : undefined;
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

    case 'link':
      /**
       * Narrowed to the kinds this field offers, so the boundary refuses what the dialog never
       * showed. An empty `allowedKinds` means all three — the same "empty means anything" the
       * `media` field's `accept` list uses.
       */
      schema = linkValueSchema(
        Array.isArray(config.allowedKinds) ? (config.allowedKinds as LinkKind[]) : [],
      );
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
          ref: z.string().min(1).optional(),
        }),
      );
      break;

    case 'repeater':
      /**
       * Only the envelope, like `block`.
       *
       * Each row's values depend on this field's own sub-field definitions, which
       * `validateItemData` applies afterwards — keeping `buildValueSchema` a pure function of one
       * field definition is what lets the content-type builder call it with nothing else loaded.
       */
      schema = z.array(
        z.object({
          id: z.string().min(1),
          data: z.record(z.string(), z.unknown()).default({}),
        }),
      );
      break;

    case 'query': {
      /**
       * The saved question, not its answer.
       *
       * Results are never stored: they are resolved at delivery, and writing them here would freeze
       * "the six soonest events" to whichever six were soonest on the day somebody last saved the
       * page — which is the entire thing a query exists not to do. It is also why a revision
       * restoring this value restores the *rule*, and the rule then answers with today's content.
       *
       * `limit` is clamped to the field's own `maxResults` rather than refused. An editor typing 50
       * into a field capped at 24 has asked for more than the site will carry, and the useful answer
       * is 24 — refusing the save would block them on a number they cannot see the ceiling for.
       */
      const config = parseJson<Record<string, unknown>>(field.config, {});
      const maxResults =
        typeof config.maxResults === 'number' && config.maxResults > 0 ? config.maxResults : 24;

      schema = queryValueSchema.transform((value) => ({
        ...value,
        limit: Math.min(value.limit, maxResults),
      }));
      break;
    }

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
  /**
   * A reusable block's id, when this placement is a reference rather than content of its own.
   *
   * Set means the library owns the content: `data` is empty here and filled in at read time by
   * `resolveBlockReferences`. Storing a copy alongside the reference would make "which is
   * authoritative" a question, and the answer would be wrong on whichever page nobody reopened.
   */
  ref?: string;
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
  /**
   * How many levels of block nesting remain. Internal — callers leave it unset.
   *
   * A block type may hold a `block` field, so validation recurses. This used to be bounded only by
   * a claim that the editor never offered such a field, which was never true: the field builder
   * renders every field type for a block type just as it does for a content type. That left the
   * real bound at "however deep the request nests", and a hand-written payload nesting thousands
   * of levels would recurse until the stack gave out.
   */
  blockDepth?: number;
  /**
   * Whether "you have not finished" counts as invalid. Defaults to true.
   *
   * There is exactly one caller that passes `false`: `writePreviewDraft`, whose input is a picture
   * of a form somebody is still typing into. A check that refused it would refuse every draft before
   * its last keystroke, which is the whole of what a live preview is for.
   *
   * It relaxes exactly three rules — `required`, a text field's `minLength`, and a repeater's
   * `minItems` — because those are the three that say "this is not finished yet". The distinction
   * worth holding onto: **a minimum is a statement about completeness, a maximum is a bound on what
   * the system will carry.** So `maxLength`, `maxItems`, `maxBlocks`, `allowedBlocks`,
   * `MAX_BLOCK_DEPTH`, select options, number ranges, and date parsing are all untouched.
   *
   * **Sanitising is not one of the three and cannot be.** The richtext transform runs before any
   * refinement and sits outside every `required` branch, so no value reaches a caller unsanitised
   * through this option. That is the property the whole live-preview design rests on, and
   * `fields.test.ts` asserts it at all three walk sites — top level, inside a block, inside a
   * repeater row — along with the write paths still refusing an incomplete item.
   */
  requireComplete?: boolean;
}

/**
 * How deep blocks may nest.
 *
 * Generous enough that no plausible page hits it — a section holding cards holding a rich text is
 * three — and small enough that the recursion cannot exhaust anything. The editor stops offering
 * nested block types before this, by excluding ancestors; this is the boundary's own guarantee,
 * which has to hold for a request the editor never made.
 */
export const MAX_BLOCK_DEPTH = 5;

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
    /**
     * Evaluated against `input`, never the accumulating `parsed`.
     *
     * The loop fills `parsed` in field order, so a controlling checkbox positioned *after* the field
     * it governs would not be there yet — and the dependent would evaluate against `undefined`,
     * come out hidden, and stop being required for no reason an author could see. Reading the raw
     * input makes the answer independent of the order fields happen to sit in.
     */
    const visible = isFieldVisible(field, fields, input);

    /**
     * A hidden field is relaxed by the mechanism that already exists rather than a second one.
     *
     * "You have not finished this" is exactly what `requireComplete` describes, and a field the
     * editor is not showing cannot be finished — so the same three rules come off (`required`, text
     * `minLength`, repeater `minItems`) and every bound stays on. Sanitising is untouched, because
     * the richtext transform sits outside every `required` branch; a hidden richtext value still
     * goes through it, which matters because it is still stored and still rendered with `set:html`
     * by any consumer that reads the boolean differently than the editor does.
     *
     * Threaded into the block and repeater walks too, not just the value schema, so a hidden
     * region's contents relax with it.
     */
    const fieldOptions = visible ? options : { ...options, requireComplete: false };

    const schema = buildValueSchema(field, { requireComplete: fieldOptions.requireComplete });
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
        fieldOptions,
      );
      if (blocks.errors.length > 0) errors[field.api_id] = blocks.errors;
      else parsed[field.api_id] = blocks.value;
      continue;
    }

    if (field.type === 'repeater') {
      const rows = validateRepeater(field, result.data as RepeaterRow[], fieldOptions);
      if (rows.errors.length > 0) errors[field.api_id] = rows.errors;
      else parsed[field.api_id] = rows.value;
      continue;
    }

    /**
     * A hidden field's value is **kept**, here and in delivery.
     *
     * Dropping it would make this function a destructive transform driven by a rule an admin can
     * edit on a different screen: adding a condition to a content type would silently wipe that
     * field on every item's next save, with no revision showing an author doing it. Keeping it also
     * means unticking a box and reticking it brings the text back, which is what anyone expects of
     * a checkbox. The consumer reads the controlling value and decides what to render — Taproot
     * ships no templates and does not get to make that call.
     */
    parsed[field.api_id] = result.data;
  }

  return Object.keys(errors).length > 0
    ? { success: false, errors }
    : { success: true, data: parsed, errors: {} };
}

/** One row of a repeater. */
export interface RepeaterRow {
  id: string;
  data: Record<string, unknown>;
}

/**
 * Turn sub-field definitions into rows the rest of the system already understands.
 *
 * `FieldControl` renders a `FieldRow` and `validateItemData` validates against them, so
 * synthesising rows here means a repeater's sub-fields get the same controls, the same validation,
 * and the same richtext sanitising as a top-level field — for free, and unable to drift.
 *
 * The ids are derived from the parent's, deterministically. They only have to be unique within one
 * render, and deriving them keeps the DOM ids stable across re-renders where a generated id would
 * remount every input on every keystroke.
 */
export function repeaterRowFields(field: FieldRow): FieldRow[] {
  const config = parseJson<Record<string, unknown>>(field.config, {});
  const subFields = Array.isArray(config.fields) ? config.fields : [];

  return subFields.flatMap((raw, index) => {
    const parsed = repeaterSubField.safeParse(raw);
    // A malformed definition costs that sub-field, not the whole repeater — the same tolerance
    // `parseJson` applies everywhere else a stored blob is read back.
    if (!parsed.success) return [];

    const sub = parsed.data;
    return [
      {
        id: `${field.id}__${sub.api_id}`,
        content_type_id: field.content_type_id,
        api_id: sub.api_id,
        label: sub.label,
        type: sub.type,
        help_text: sub.help_text ?? null,
        position: index,
        required: sub.required ? 1 : 0,
        localized: 0,
        config: stringifyJson(sub.config),
        visible_when: sub.visible_when ? stringifyJson(sub.visible_when) : null,
        created_at: field.created_at,
        updated_at: field.updated_at,
      } as FieldRow,
    ];
  });
}

/**
 * Validate each row against the repeater's own sub-field definitions.
 *
 * Recursive through `validateItemData`, exactly like blocks — which is what makes a richtext
 * sub-field sanitised on write without this function knowing that richtext exists.
 */
function validateRepeater(
  field: FieldRow,
  rows: RepeaterRow[],
  options: ValidateItemOptions,
): { value: RepeaterRow[]; errors: string[] } {
  const config = parseJson<Record<string, unknown>>(field.config, {});
  /**
   * `minItems` is relaxed with `required` and `maxItems` is not.
   *
   * A repeater configured for two rows with one filled in is a form in progress; a repeater carrying
   * five hundred rows is a payload nobody meant to send.
   */
  const min =
    options.requireComplete === false
      ? 0
      : typeof config.minItems === 'number'
        ? config.minItems
        : 0;
  const max = typeof config.maxItems === 'number' ? config.maxItems : undefined;

  const errors: string[] = [];
  const value: RepeaterRow[] = [];

  if (rows.length < min) {
    errors.push(`At least ${min} ${min === 1 ? 'entry' : 'entries'} required (found ${rows.length}).`);
  }
  if (max !== undefined && rows.length > max) {
    errors.push(`At most ${max} ${max === 1 ? 'entry' : 'entries'} allowed (found ${rows.length}).`);
  }

  const subFields = repeaterRowFields(field);

  /**
   * With no sub-fields defined, rows pass through untouched rather than being emptied.
   *
   * A repeater whose shape has not been designed yet is half-built, not invalid — and dropping
   * whatever an API client stored in it would be destroying content to enforce a schema that does
   * not exist.
   */
  if (subFields.length === 0) return { value: rows, errors };

  rows.forEach((row, index) => {
    const nested = validateItemData(subFields, row.data, options);

    if (nested.success) {
      value.push({ id: row.id, data: nested.data ?? {} });
    } else {
      for (const [apiId, messages] of Object.entries(nested.errors)) {
        // Positioned, because the editor renders rows under one label and has nowhere to put a
        // per-row error map — the same reason block errors carry their index.
        errors.push(`Entry ${index + 1} — ${apiId}: ${messages.join(' ')}`);
      }
    }
  });

  return { value, errors };
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

    /**
     * A reference carries no content of its own, so there is nothing here to validate.
     *
     * The library row owns the data and was validated when it was written; re-checking a copy
     * would mean there were two, and the stale one would win on whichever page nobody reopened.
     * `data` is dropped rather than preserved so the stored shape cannot imply otherwise.
     */
    if (block.ref) {
      value.push({ id: block.id, type: block.type, data: {}, ref: block.ref });
      return;
    }

    /**
     * Recursive, so a block containing a block field is validated all the way down.
     *
     * The registry passes through unchanged; only the remaining depth decreases. Refusing at the
     * limit rather than truncating means an over-deep payload is rejected with its reason instead
     * of being silently stored with its tail cut off.
     */
    const depth = options.blockDepth ?? MAX_BLOCK_DEPTH;
    if (depth <= 0) {
      errors.push(`${position}: blocks are nested more than ${MAX_BLOCK_DEPTH} levels deep.`);
      return;
    }

    const nested = validateItemData(blockType.fields, block.data, {
      ...options,
      blockDepth: depth - 1,
    });

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
  /**
   * Where a singleton renders on the public site, so the admin knows what to preview.
   *
   * A root-relative path and nothing else. An absolute URL is refused rather than accepted and
   * ignored, because it would silently point the preview pane at another origin — the site URL is
   * `TAPROOT_SITE_URL`'s job, and letting a content type override it per type would make "which
   * site is this" answerable in two places. A trailing slash is refused for the same reason
   * `normalizePath` strips one: `/about/` and `/about` must not be two settings.
   */
  preview_path: z
    .string()
    .regex(
      /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/,
      'Must be a root-relative path such as / or /about, with no origin and no trailing slash.',
    )
    .max(255)
    .nullish(),
  /**
   * Whether a collection's items are served at their own URLs. Defaults to yes.
   *
   * `optional` rather than `nullish` with a default: absent means "keep what is stored" on a PATCH,
   * and there is no third state for `null` to mean. `createContentType` reads absent as on, which
   * is what every collection before this column had.
   */
  item_pages: z.boolean().optional(),
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
  /**
   * `nullish` rather than `optional`, and the difference is load-bearing on a PATCH: `undefined`
   * means "not provided, keep what is stored" and `null` means "remove the condition". Collapsing
   * them with `??` is what silently ignored a request to clear `publish_at`.
   */
  visible_when: visibilityCondition.nullish(),
});

export type ContentTypeInput = z.infer<typeof contentTypeInputSchema>;
export type FieldInput = z.infer<typeof fieldInputSchema>;
