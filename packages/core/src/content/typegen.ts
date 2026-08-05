import type { DeliveryField, DeliverySchema, DeliveryTypeSchema } from './delivery.js';
import type { VisibilityCondition } from '../validation/visibility.js';
import { ITEM_SORTS } from './itemSort.js';

/** How a repeater's sub-fields are stored: the `FieldRow` shape, not the delivery one. */
interface RepeaterSubFieldShape {
  api_id: string;
  label?: string;
  type: DeliveryField['type'];
  required?: boolean;
  help_text?: string | null;
  config?: Record<string, unknown>;
  /**
   * Snake case like its siblings, and the **condition object** rather than the JSON string a
   * `FieldRow` carries — a sub-field definition already lives inside JSON, so there is nothing to
   * parse. `repeaterRowFields` is what stringifies it onto the synthesised row.
   */
  visible_when?: VisibilityCondition | null;
}

/**
 * Turn a live content model into TypeScript.
 *
 * SCOPE calls this "the point of the split rather than a nicety", and the reason is worth stating
 * plainly: today's client is typed over *table rows*. `ContentItem` carries
 * `data: Record<string, unknown>`, which is a true description of every Taproot site and a useful
 * description of none. A site with an `event` type wants `Event`, with the fields it declared, so
 * that renaming a field breaks the build rather than the page.
 *
 * Emitted as source a consumer checks in, not generated at runtime. That is what makes a schema
 * change show up as a reviewable diff in a pull request — the moment somebody deletes a field, the
 * consumer's repository shows exactly which templates stop compiling.
 *
 * **Types only, no runtime.** The output is a `.d.ts`, which may declare but not implement — a
 * generated helper function in one is a syntax error rather than a convenience. Anything with a
 * body belongs in the consumer package, where it can be imported and tested.
 *
 * Pure string building on purpose: no filesystem, no network, no formatter. The CLI that writes the
 * file is a dozen lines around this, and this is testable without either.
 */

/** What a field's value looks like once it has been through the delivery API. */
function fieldType(field: DeliveryField, blockTypeNames: Map<string, string>): string {
  const multiple = isMultiple(field);
  const single = singleType(field, blockTypeNames);
  return multiple ? `${single}[]` : single;
}

/**
 * Whether a field stores an array.
 *
 * `media` and `relation` follow their own config — a bare id when single, an ordered array when
 * multiple — which is the stored shape and therefore the delivered one. Getting this wrong is the
 * mistake the generated types exist to prevent, so it reads the same config key the editor does.
 */
function isMultiple(field: DeliveryField): boolean {
  switch (field.type) {
    case 'media':
    case 'relation':
      return field.config.multiple === true;
    case 'taxonomy':
      return field.config.multiple !== false;
    case 'block':
    case 'repeater':
      return true;
    default:
      return false;
  }
}

/**
 * A repeater row whose sub-fields cannot be described — an empty or malformed `config.fields`.
 *
 * Still the envelope: the row is `{ id, data }` whatever is inside it, and widening `data` to
 * `Record<string, unknown>` is honest where dropping the envelope would not be.
 */
const ROW_WITHOUT_FIELDS = '{ id: string; data: Record<string, unknown> }';

function singleType(field: DeliveryField, blockTypeNames: Map<string, string>): string {
  switch (field.type) {
    case 'text':
    // Richtext is a string of sanitised HTML. Typing it as a distinct branded type was tempting and
    // would be a lie: it is a string, and the sanitising happened on write.
    case 'richtext':
    case 'date':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'select': {
      const options = Array.isArray(field.config.options) ? field.config.options : [];
      const literals = options
        .map((option) =>
          typeof option === 'object' && option !== null && 'value' in option
            ? (option as { value: unknown }).value
            : option,
        )
        .filter((value): value is string => typeof value === 'string')
        .map((value) => JSON.stringify(value));

      // A union of what the type actually offers, so a typo in a template is a compile error.
      // Falls back to `string` when the options are absent or not literals — a wrong narrow type
      // would be worse than a wide one.
      return literals.length > 0 ? literals.join(' | ') : 'string';
    }
    /**
     * Ids, not objects.
     *
     * The delivery API returns references in lookup maps rather than inlining them, so `data` keeps
     * the stored shape. Typing these as the resolved object would describe a payload Taproot does
     * not send.
     */
    case 'media':
      return 'MediaId';
    case 'relation':
      return 'ContentItemId';
    case 'taxonomy':
      return 'TermId';
    /**
     * A union discriminated by `kind`, exactly as it is stored.
     *
     * The item and media variants are ids, following the rule the two cases above state: the
     * delivery response resolves them through `references` and `media`, so typing them as anything
     * richer would describe a payload Taproot does not send. `newTab` and `noFollow` are not
     * optional because their config defaults are `false` — validation fills them in, so a stored
     * link always carries both.
     */
    case 'link': {
      const configured = Array.isArray(field.config.allowedKinds)
        ? (field.config.allowedKinds as string[])
        : [];
      const kinds = configured.length > 0 ? configured : ['item', 'media', 'url'];
      const options = 'label?: string; newTab: boolean; noFollow: boolean';

      const variants = kinds
        .map((kind) =>
          kind === 'url'
            ? `{ kind: "url"; href: string; ${options} }`
            : kind === 'media'
              ? `{ kind: "media"; id: MediaId; ${options} }`
              : `{ kind: "item"; id: ContentItemId; ${options} }`,
        )
        .join(' | ');

      // Parenthesised so a `link` inside anything array-shaped later cannot bind `[]` to the last
      // member of the union alone.
      return kinds.length > 1 ? `(${variants})` : variants;
    }
    /**
     * The address and the frame's name, which is the whole stored value.
     *
     * Neither member is optional. `url` and `title` are both required by the value schema, so a
     * stored embed always carries both — and the sizing an editor sees is not here at all because
     * it belongs to the *field's* config, not to this value. A consumer reads it from the schema or,
     * far more likely, from the `<TaprootEmbed>` props it already writes.
     */
    case 'embed':
      return '{ url: string; title: string }';
    case 'block':
      return blockTypeNames.size > 0
        ? `TaprootBlock`
        : 'Record<string, unknown>';
    /**
     * The saved rule, following the same rule `media` and `relation` follow.
     *
     * Reaching `default` here would have typed it `unknown` — which compiles, renders nothing, and
     * errors nowhere, exactly the failure the repeater envelope comment describes. The answer is in
     * the response's `queries` map and is deliberately not reachable from this type: a consumer
     * looks it up by `${containerId}:${fieldApiId}`, because the same block type placed twice on one
     * page has two answers and only the placement can tell them apart.
     */
    case 'query':
      return 'TaprootQuery';
    case 'repeater': {
      /**
       * A repeater's sub-fields live in its own config, in the stored `FieldRow` shape.
       *
       * `api_id` and `help_text`, not `apiId` and `helpText` — they were never rows in the `fields`
       * table, so nothing ever mapped them into the delivery shape. Reading them as `DeliveryField`
       * silently produced a row of properties literally named `undefined`, which is the kind of
       * bug that type-checks and generates nonsense.
       */
      const sub = Array.isArray(field.config.fields)
        ? (field.config.fields as RepeaterSubFieldShape[])
        : [];
      if (sub.length === 0) return ROW_WITHOUT_FIELDS;

      const members = sub
        .filter((child) => typeof child?.api_id === 'string')
        .map((child) => {
          const asDelivery: DeliveryField = {
            apiId: child.api_id,
            label: child.label ?? child.api_id,
            type: child.type,
            required: child.required === true,
            helpText: child.help_text ?? null,
            position: 0,
            config: child.config ?? {},
            visibleWhen: child.visible_when ?? null,
          };
          // Conditional sub-fields are optional whatever `required` says, for the same reason a
          // conditional top-level field is: validation relaxes it when the condition is unmet.
          const optional = !asDelivery.required || Boolean(asDelivery.visibleWhen);
          return `      ${propertyName(child.api_id)}${optional ? '?' : ''}: ${fieldType(asDelivery, blockTypeNames)};`;
        })
        .join('\n');

      /**
       * The row envelope, not the sub-fields alone.
       *
       * A repeater stores `{ id, data: { …sub-fields } }` per row — that is what `buildValueSchema`
       * validates, what the editor writes, and what `resolveDelivery` sends. This emitted the inner
       * shape flat, so a consumer typed `row.headline` against a payload that only ever carries
       * `row.data.headline`, compiled, and rendered nothing. Exactly the failure the `media` and
       * `relation` cases above are commented to prevent — a generated type describing a payload
       * Taproot does not send — and the same one `block` avoids by keeping its own envelope.
       *
       * Flattening delivery instead was the other way to close the gap and is the wrong one: `data`
       * has to keep the stored shape so the payload stays usable for a write, and `id` is the row's
       * stable identity rather than noise.
       */
      return members ? `{\n    id: string;\n    data: {\n${members}\n    };\n  }` : ROW_WITHOUT_FIELDS;
    }
    default:
      return 'unknown';
  }
}

/** `api_id` → a valid TypeScript property, quoted only when it has to be. */
function propertyName(apiId: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(apiId) ? apiId : JSON.stringify(apiId);
}

/** `staff_profile` → `StaffProfile`. */
export function typeName(apiId: string): string {
  return apiId
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function renderType(type: DeliveryTypeSchema, blockTypeNames: Map<string, string>): string {
  const name = typeName(type.apiId);
  const lines = [`/** ${type.name} — \`${type.apiId}\` (${type.kind}). */`, `export interface ${name}Data {`];

  if (type.fields.length === 0) {
    lines.push('  // This type has no fields yet.');
  }

  for (const field of type.fields) {
    if (field.helpText) lines.push(`  /** ${field.helpText.replace(/\*\//g, '*\\/')} */`);

    /**
     * Optional unless required — and a conditional field is optional whatever `required` says.
     *
     * "Required" on a conditional field means "required *when shown*": `validateItemData` relaxes
     * it exactly as `requireComplete: false` does the moment its condition is unmet, so the value
     * genuinely can be absent. Emitting it non-optional would be the CMS promising something it
     * does not enforce, and the consumer would dereference `undefined` on a build that type-checks
     * clean — the same shape of quiet failure as the repeater envelope.
     */
    const optional = !field.required || Boolean(field.visibleWhen);
    if (field.visibleWhen) {
      lines.push(
        `  /** Shown when \`${field.visibleWhen.field}\` ${field.visibleWhen.operator.replace(/_/g, ' ')}${
          field.visibleWhen.value === undefined ? '' : ` \`${field.visibleWhen.value}\``
        } — so it may be absent. */`,
      );
    }

    lines.push(
      `  ${propertyName(field.apiId)}${optional ? '?' : ''}: ${fieldType(field, blockTypeNames)};`,
    );
  }

  lines.push('}');
  return lines.join('\n');
}

export interface GenerateOptions {
  /** Written into the banner so the file says where it came from. */
  source?: string;
}

export function generateTypes(schema: DeliverySchema, options: GenerateOptions = {}): string {
  const blockTypeNames = new Map(
    schema.blockTypes.map((type) => [type.apiId, `${typeName(type.apiId)}Data`]),
  );

  const parts: string[] = [
    '// Generated by Taproot. Do not edit by hand.',
    '//',
    '// Run `npm run taproot:types` to regenerate after changing the content model. This file is',
    '// checked in on purpose: a schema change should show up as a reviewable diff, and the moment',
    '// a field is renamed the templates that used it stop compiling.',
    options.source ? `//\n// Source: ${options.source}` : '',
    '',
    '/** An id referring to a media asset. Look it up in a delivery response’s `media` map. */',
    'export type MediaId = string;',
    '/** An id referring to another content item. Look it up in `references`. */',
    'export type ContentItemId = string;',
    '/** An id referring to a taxonomy term. Look it up in `terms`. */',
    'export type TermId = string;',
    '',
    /**
     * The rule, not the answer — matching what is actually stored in `data`.
     *
     * A query field's results are never in `data`; they arrive in the response's `queries` map,
     * keyed by `${containerId}:${fieldApiId}`. Typing this as the results would be the same class
     * of mistake the repeater envelope was: a generated type describing a payload Taproot does not
     * send, which compiles and renders nothing.
     */
    '/** A saved query. Its results are in a delivery response’s `queries` map, not here. */',
    'export interface TaprootQuery {',
    '  termIds: TermId[];',
    `  sort: ${ITEM_SORTS.map((sort) => JSON.stringify(sort)).join(' | ')};`,
    '  limit: number;',
    '}',
    '',
  ];

  if (schema.blockTypes.length > 0) {
    for (const type of schema.blockTypes) {
      parts.push(renderType(type, blockTypeNames), '');
    }

    /**
     * A discriminated union over `type`, which is how a block instance names its own schema.
     *
     * Narrowing on `block.type` in a renderer is the ergonomics a site wants, and it is also what
     * makes an unhandled block type a compile error rather than a blank space on a page.
     *
     * **One member per block type, with the fields under `data`.** An earlier version emitted two —
     * an inline block with its fields at the top level, and a referencing one with them under
     * `data` — which was a plausible guess and wrong. `BlockInstance` in core always has `data`;
     * `ref` only says the library owns it, and `resolveBlockReferences` fills the same `data` in at
     * read time. Templates written against the guessed shape would have compiled and then read
     * `undefined` from every field.
     */
    parts.push(
      '/** Any block instance, discriminated by `type`. */',
      'export type TaprootBlock =',
      ...schema.blockTypes.map((type) => {
        const literal = JSON.stringify(type.apiId);
        // `ref` is present when the content belongs to the reusable-block library. The fields are
        // in `data` either way, which is what lets a renderer ignore the distinction entirely.
        return `  | { id: string; type: ${literal}; data: ${typeName(type.apiId)}Data; ref?: string }`;
      }),
      '',
    );
  }

  for (const type of schema.contentTypes) {
    parts.push(renderType(type, blockTypeNames), '');
  }

  /** A lookup from `api_id` to its data type, so a generic client can be typed by api id. */
  if (schema.contentTypes.length > 0) {
    parts.push(
      '/** Every content type, keyed by `api_id`. */',
      'export interface TaprootContentTypes {',
      ...schema.contentTypes.map(
        (type) => `  ${propertyName(type.apiId)}: ${typeName(type.apiId)}Data;`,
      ),
      '}',
      '',
      'export type TaprootContentTypeId = keyof TaprootContentTypes;',
      '',
    );
  }

  return parts.filter((part) => part !== '').join('\n') + '\n';
}
