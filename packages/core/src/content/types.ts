import type { Kysely } from 'kysely';

import type { BatchStatement } from '../db/batch.js';
import type { ContentTypeRow, Database, FieldRow } from '../db/schema.js';
import { fromBool, now, stringifyJson } from '../db/values.js';
import { newId } from '../ids.js';
import { parseFieldConfig, type ContentTypeInput, type FieldInput } from '../validation/fields.js';

/**
 * Content types and their fields.
 *
 * A content type is a user-defined schema; Phase 1's visual builder is a UI over exactly these
 * operations, which is why fields live in a real table rather than a JSON blob from the start.
 */

export interface ContentTypeWithFields extends ContentTypeRow {
  fields: FieldRow[];
}

export class ContentTypeError extends Error {
  override name = 'ContentTypeError';
  constructor(
    message: string,
    readonly code:
      | 'duplicate_api_id'
      | 'not_found'
      | 'invalid_config'
      | 'immutable'
      | 'in_use' = 'invalid_config',
  ) {
    super(message);
  }
}

/**
 * Every content type, in sidebar order.
 *
 * `position` then `name`: a site that has never reordered has all-zero positions and so keeps an
 * alphabetical list, which is what this returned before ordering existed.
 */
export async function listContentTypes(db: Kysely<Database>): Promise<ContentTypeRow[]> {
  return db.selectFrom('content_types').selectAll().orderBy('position').orderBy('name').execute();
}

/** Persist a new sidebar order. Positions are rewritten to match array order. */
export async function reorderContentTypes(
  handle: { db: Kysely<Database>; batch(statements: BatchStatement[]): Promise<void> },
  orderedIds: string[],
): Promise<void> {
  const timestamp = now();
  await handle.batch(
    orderedIds.map((id, index) =>
      handle.db
        .updateTable('content_types')
        .set({ position: index, updated_at: timestamp })
        .where('id', '=', id),
    ),
  );
}

export async function getContentType(
  db: Kysely<Database>,
  id: string,
): Promise<ContentTypeWithFields | undefined> {
  const type = await db
    .selectFrom('content_types')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!type) return undefined;

  return { ...type, fields: await listFields(db, type.id) };
}

export async function getContentTypeByApiId(
  db: Kysely<Database>,
  apiId: string,
): Promise<ContentTypeWithFields | undefined> {
  const type = await db
    .selectFrom('content_types')
    .selectAll()
    .where('api_id', '=', apiId)
    .executeTakeFirst();
  if (!type) return undefined;

  return { ...type, fields: await listFields(db, type.id) };
}

export async function listFields(db: Kysely<Database>, contentTypeId: string): Promise<FieldRow[]> {
  return db
    .selectFrom('fields')
    .selectAll()
    .where('content_type_id', '=', contentTypeId)
    .orderBy('position')
    .orderBy('created_at')
    .execute();
}

export async function createContentType(
  db: Kysely<Database>,
  input: ContentTypeInput,
): Promise<ContentTypeRow> {
  const existing = await db
    .selectFrom('content_types')
    .select('id')
    .where('api_id', '=', input.api_id)
    .executeTakeFirst();

  if (existing) {
    throw new ContentTypeError(
      `A content type with the API id "${input.api_id}" already exists.`,
      'duplicate_api_id',
    );
  }

  const timestamp = now();
  const row: ContentTypeRow = {
    id: newId(),
    api_id: input.api_id,
    name: input.name,
    name_plural: input.name_plural,
    description: input.description ?? null,
    kind: input.kind,
    icon: input.icon ?? null,
    // Only collection types are type-prefixed; page and singleton types have no prefix.
    url_prefix: input.kind === 'collection' ? (input.url_prefix ?? input.api_id) : null,
    title_field: input.title_field ?? null,
    default_og_image_id: input.default_og_image_id ?? null,
    // Appended to the end of the sidebar rather than dropped at 0, so creating a type does not
    // silently reshuffle an order someone already arranged.
    position: await nextContentTypePosition(db),
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('content_types').values(row).execute();
  return row;
}

async function nextContentTypePosition(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('content_types')
    .select((eb) => eb.fn.max<number>('position').as('max'))
    .executeTakeFirst();

  return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1;
}

/**
 * Update a content type.
 *
 * `api_id` is deliberately not updatable: it is the stable machine name that API consumers and
 * code reference. Renaming it would silently break every integration, so the display `name` is
 * what authors edit instead.
 */
export async function updateContentType(
  db: Kysely<Database>,
  id: string,
  input: Partial<Omit<ContentTypeInput, 'api_id'>>,
): Promise<ContentTypeRow> {
  const existing = await db
    .selectFrom('content_types')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  if (!existing) throw new ContentTypeError(`Content type ${id} not found.`, 'not_found');

  const kind = input.kind ?? existing.kind;
  const patch = {
    name: input.name ?? existing.name,
    name_plural: input.name_plural ?? existing.name_plural,
    description: input.description === undefined ? existing.description : (input.description ?? null),
    kind,
    icon: input.icon === undefined ? existing.icon : (input.icon ?? null),
    url_prefix:
      kind === 'collection'
        ? (input.url_prefix ?? existing.url_prefix ?? existing.api_id)
        : null,
    title_field: input.title_field === undefined ? existing.title_field : (input.title_field ?? null),
    default_og_image_id:
      input.default_og_image_id === undefined
        ? existing.default_og_image_id
        : (input.default_og_image_id ?? null),
    updated_at: now(),
  };

  await db.updateTable('content_types').set(patch).where('id', '=', id).execute();
  return { ...existing, ...patch };
}

/**
 * Delete a content type.
 *
 * Refuses while items still exist rather than cascading: dropping a department's entire content
 * because someone deleted a type is not a recoverable mistake, and the FK cascade would do exactly
 * that. The caller must delete or move the items first.
 */
export async function deleteContentType(db: Kysely<Database>, id: string): Promise<void> {
  const itemCount = await db
    .selectFrom('content_items')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('content_type_id', '=', id)
    .executeTakeFirst();

  if (Number(itemCount?.count ?? 0) > 0) {
    throw new ContentTypeError(
      `Cannot delete this content type while ${itemCount?.count} content item(s) still use it. ` +
        `Delete or move those items first.`,
      'in_use',
    );
  }

  await db.deleteFrom('content_types').where('id', '=', id).execute();
}

export async function createField(
  db: Kysely<Database>,
  contentTypeId: string,
  input: FieldInput,
): Promise<FieldRow> {
  const parsed = parseFieldConfig(input.type, input.config);
  if (!parsed.success) {
    throw new ContentTypeError(
      `Invalid configuration for a ${input.type} field: ${parsed.issues.join('; ')}`,
      'invalid_config',
    );
  }

  const duplicate = await db
    .selectFrom('fields')
    .select('id')
    .where('content_type_id', '=', contentTypeId)
    .where('api_id', '=', input.api_id)
    .executeTakeFirst();

  if (duplicate) {
    throw new ContentTypeError(
      `This content type already has a field with the API id "${input.api_id}".`,
      'duplicate_api_id',
    );
  }

  const timestamp = now();
  const row: FieldRow = {
    id: newId(),
    content_type_id: contentTypeId,
    api_id: input.api_id,
    label: input.label,
    type: input.type,
    help_text: input.help_text ?? null,
    position: input.position ?? (await nextFieldPosition(db, contentTypeId)),
    required: fromBool(input.required),
    localized: fromBool(input.localized),
    config: stringifyJson(parsed.config),
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('fields').values(row).execute();
  return row;
}

export async function updateField(
  db: Kysely<Database>,
  fieldId: string,
  input: Partial<FieldInput>,
): Promise<FieldRow> {
  const existing = await db
    .selectFrom('fields')
    .selectAll()
    .where('id', '=', fieldId)
    .executeTakeFirst();

  if (!existing) throw new ContentTypeError(`Field ${fieldId} not found.`, 'not_found');

  // Changing a field's type would reinterpret every stored value for it. Phase 1 can add a guided
  // migration; until then, refusing is safer than silently corrupting content.
  if (input.type && input.type !== existing.type) {
    throw new ContentTypeError(
      `A field's type cannot be changed after creation (${existing.type} → ${input.type}). ` +
        `Delete the field and add a new one, or keep the existing type.`,
      'immutable',
    );
  }

  const config = input.config ?? JSON.parse(existing.config);
  const parsed = parseFieldConfig(existing.type, config);
  if (!parsed.success) {
    throw new ContentTypeError(
      `Invalid configuration for a ${existing.type} field: ${parsed.issues.join('; ')}`,
      'invalid_config',
    );
  }

  const patch = {
    label: input.label ?? existing.label,
    help_text: input.help_text === undefined ? existing.help_text : (input.help_text ?? null),
    position: input.position ?? existing.position,
    required: input.required === undefined ? existing.required : fromBool(input.required),
    localized: input.localized === undefined ? existing.localized : fromBool(input.localized),
    config: stringifyJson(parsed.config),
    updated_at: now(),
  };

  await db.updateTable('fields').set(patch).where('id', '=', fieldId).execute();
  return { ...existing, ...patch };
}

export async function deleteField(db: Kysely<Database>, fieldId: string): Promise<void> {
  await db.deleteFrom('fields').where('id', '=', fieldId).execute();
}

/** Persist a new field order. Positions are rewritten to match array order. */
export async function reorderFields(
  db: Kysely<Database>,
  contentTypeId: string,
  orderedFieldIds: string[],
): Promise<void> {
  const timestamp = now();
  for (const [index, fieldId] of orderedFieldIds.entries()) {
    await db
      .updateTable('fields')
      .set({ position: index, updated_at: timestamp })
      .where('id', '=', fieldId)
      .where('content_type_id', '=', contentTypeId)
      .execute();
  }
}

async function nextFieldPosition(db: Kysely<Database>, contentTypeId: string): Promise<number> {
  const row = await db
    .selectFrom('fields')
    .select((eb) => eb.fn.max<number>('position').as('max'))
    .where('content_type_id', '=', contentTypeId)
    .executeTakeFirst();

  return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1;
}
