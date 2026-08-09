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
 * Content types, in sidebar order.
 *
 * `position` then `name`: a site that has never reordered has all-zero positions and so keeps an
 * alphabetical list, which is what this returned before ordering existed.
 *
 * **Block types are excluded by default.** They share this table because a block type is the same
 * thing as a content type — a user-defined schema with fields — but their instances are embedded
 * rather than addressed, so they must never appear in the sidebar, the "new content item" picker,
 * or a relation field's target list. Defaulting to exclusion means every existing caller is correct
 * without being edited, and showing blocks is the thing you have to ask for.
 */
export async function listContentTypes(
  db: Kysely<Database>,
  options: { includeBlocks?: boolean } = {},
): Promise<ContentTypeRow[]> {
  let query = db.selectFrom('content_types').selectAll();
  if (!options.includeBlocks) query = query.where('kind', '!=', 'block');

  return query.orderBy('position').orderBy('name').execute();
}

/** Block types only — the schemas that can be placed into a `block` field. */
export async function listBlockTypes(db: Kysely<Database>): Promise<ContentTypeRow[]> {
  return db
    .selectFrom('content_types')
    .selectAll()
    .where('kind', '=', 'block')
    .orderBy('position')
    .orderBy('name')
    .execute();
}

/**
 * Block types with their fields, keyed by `api_id`.
 *
 * Validation needs this: a block instance carries only its type's `api_id` and a data bag, so
 * checking it means looking up that type's field definitions. Loaded in one pass rather than per
 * block, because a page with twelve blocks of three types should cost three lookups, not twelve.
 */
export async function blockTypeRegistry(
  db: Kysely<Database>,
): Promise<Map<string, ContentTypeWithFields>> {
  const types = await listBlockTypes(db);
  if (types.length === 0) return new Map();

  const fields = await db
    .selectFrom('fields')
    .selectAll()
    .where(
      'content_type_id',
      'in',
      types.map((type) => type.id),
    )
    .orderBy('position')
    .orderBy('created_at')
    .execute();

  const byType = new Map<string, FieldRow[]>();
  for (const field of fields) {
    const list = byType.get(field.content_type_id);
    if (list) list.push(field);
    else byType.set(field.content_type_id, [field]);
  }

  return new Map(
    types.map((type) => [type.api_id, { ...type, fields: byType.get(type.id) ?? [] }]),
  );
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
    // Only a singleton can have one — every other kind derives its address from the item, and
    // `previewPathFor` never reads the column for them. Nulled here rather than trusted from the
    // input, matching `url_prefix`, so the column means one thing whatever the API was sent.
    preview_path: input.kind === 'singleton' ? (input.preview_path ?? null) : null,
    /**
     * Only a collection can turn item pages off; every other kind is forced on.
     *
     * A `page` is a node in the site tree and its identity *is* its address, and a singleton has no
     * item URL to withhold. Forced here rather than trusted from the input, matching `url_prefix`
     * and `preview_path`, so changing a type's kind cannot leave the column saying something
     * `typeHasItemPages` will not read.
     */
    item_pages: input.kind === 'collection' && input.item_pages === false ? 0 : 1,
    summary_template: input.summary_template ?? null,
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

  /**
   * Absent keeps what is stored; a boolean sets it. Only a collection may turn item pages off.
   *
   * Forced on for every other kind, so a collection switched to a page cannot leave a 0 behind for
   * whoever switches it back — the same reason `url_prefix` is nulled rather than kept.
   */
  const itemPages =
    kind === 'collection' ? (input.item_pages ?? existing.item_pages === 1) : true;

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
    /**
     * `undefined` keeps it, `null` clears it — the distinction `publish_at` already turns on.
     *
     * `??` would collapse the two and silently ignore an editor turning preview back off, which is
     * the shape of bug a `.partial()` PATCH schema keeps producing. Nulled outright for any kind
     * that is not a singleton, so changing a type's kind cannot strand a path nothing reads.
     */
    preview_path:
      kind === 'singleton'
        ? input.preview_path === undefined
          ? existing.preview_path
          : (input.preview_path ?? null)
        : null,
    item_pages: itemPages ? 1 : 0,
    summary_template:
      input.summary_template === undefined
        ? existing.summary_template
        : (input.summary_template ?? null),
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
 * Every reason this type cannot be deleted right now, worst first.
 *
 * Exported because the admin's delete affordance must not disagree with the guard. A screen that
 * decided for itself whether a delete would succeed drifts the moment a blocker is added here, and
 * the failure mode is a button that is offered and then refused — so the admin renders this list
 * and `deleteContentType` throws its first entry. Each reason is a standalone clause so it reads
 * correctly both bulleted on screen and after the "Cannot delete X:" prefix in the error.
 */
export async function contentTypeDeleteBlockers(
  db: Kysely<Database>,
  contentType: ContentTypeRow,
): Promise<string[]> {
  const blockers: string[] = [];

  if (contentType.kind === 'block') {
    const usage = await countBlockUsage(db, contentType.api_id);
    if (usage > 0) {
      blockers.push(`${usage} content item(s) still place it. Remove those blocks first.`);
    }

    /**
     * A library entry counts as usage even when nothing places it yet.
     *
     * `countBlockUsage` only sees blocks written into a content item, and a reusable block that no
     * page references is invisible to it — deleting the type would leave an entry in the library
     * whose schema no longer exists.
     */
    const library = await db
      .selectFrom('reusable_blocks')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('block_type', '=', contentType.api_id)
      .executeTakeFirst();

    const libraryCount = Number(library?.count ?? 0);
    if (libraryCount > 0) {
      blockers.push(
        `${libraryCount} reusable block(s) of that type exist. Delete those from the library first.`,
      );
    }
  } else {
    const itemCount = await db
      .selectFrom('content_items')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('content_type_id', '=', contentType.id)
      .executeTakeFirst();

    const items = Number(itemCount?.count ?? 0);
    if (items > 0) {
      blockers.push(`${items} content item(s) still use it. Delete or move those items first.`);
    }
  }

  /**
   * A relation field on another type still pointing here.
   *
   * The FK cascade reaches this type's own rows and nothing else. A relation field's target is a
   * `targetContentTypeId` inside another type's JSON `config`, which no constraint can see and no
   * cascade cleans up — deleting anyway leaves that field pointing at a type that no longer exists,
   * so its picker offers nothing and every id already stored against it resolves to no type. This
   * is the same reason `deleteTaxonomy` refuses, and it is checked the same way.
   *
   * Fields belonging to the type being deleted are excluded. A self-referencing relation — "related
   * pages" on Page, targeting Page — cascades away with its own type, so counting it would make an
   * otherwise-empty type permanently undeletable by a reference that is about to stop existing.
   *
   * Checked for block types too. Nothing in the admin offers a block as a relation target, because
   * every target picker is fed by `listContentTypes`, which excludes them — but the REST API takes
   * `targetContentTypeId` as an arbitrary string, and the API is the boundary, not the editor.
   */
  const relationFields = await db
    .selectFrom('fields')
    .selectAll()
    .where('type', '=', 'relation')
    .where('content_type_id', '!=', contentType.id)
    .execute();

  const referencing = relationFields.filter((field) => {
    try {
      const config = JSON.parse(field.config) as { targetContentTypeId?: string | null };
      return config.targetContentTypeId === contentType.id;
    } catch {
      return false;
    }
  });

  if (referencing.length > 0) {
    // Named, not just counted: the fields live on *other* types, so a count alone leaves someone
    // opening every type in the site to find which one is holding the delete.
    const owners = await db
      .selectFrom('content_types')
      .select('name')
      .where(
        'id',
        'in',
        referencing.map((field) => field.content_type_id),
      )
      .orderBy('name')
      .execute();

    blockers.push(
      `${referencing.length} relation field(s) still target it, on: ` +
        `${owners.map((owner) => owner.name).join(', ')}. Remove or repoint those fields first.`,
    );
  }

  return blockers;
}

/**
 * Delete a content type.
 *
 * Refuses while anything still depends on it rather than cascading: dropping a department's entire
 * content because someone deleted a type is not a recoverable mistake, and the FK cascade would do
 * exactly that. The caller must clear the blockers first.
 */
export async function deleteContentType(db: Kysely<Database>, id: string): Promise<void> {
  const existing = await db
    .selectFrom('content_types')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  if (!existing) throw new ContentTypeError(`Content type ${id} not found.`, 'not_found');

  const blockers = await contentTypeDeleteBlockers(db, existing);
  if (blockers.length > 0) {
    throw new ContentTypeError(
      `Cannot delete the "${existing.name}" type: ${blockers[0]}`,
      'in_use',
    );
  }

  await db.deleteFrom('content_types').where('id', '=', id).execute();
}

/**
 * How many content items place a block of this type.
 *
 * A `LIKE` over the stored `data` blob rather than a join, because block instances live inside a
 * content item's JSON and have no rows of their own. That is a deliberate part of the model —
 * blocks are content, versioned by the item's revisions, not separate records that could drift out
 * of sync with the item that contains them.
 *
 * The consequence is that this cannot be an indexed lookup. It is only ever run when deleting a
 * block type, which is rare and deserves to be correct rather than fast. The pattern matches the
 * exact JSON shape `"type":"<api_id>"` that the block envelope schema guarantees, so a block type
 * named `hero` cannot be confused with one named `hero_wide`.
 */
export async function countBlockUsage(db: Kysely<Database>, blockApiId: string): Promise<number> {
  const needle = `%"type":"${blockApiId}"%`;

  const row = await db
    .selectFrom('content_items')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('data', 'like', needle)
    .executeTakeFirst();

  return Number(row?.count ?? 0);
}

/** Which content items place a block of this type, for the "still in use" list in the admin. */
export async function itemsUsingBlock(
  db: Kysely<Database>,
  blockApiId: string,
  limit = 20,
): Promise<{ id: string; title: string; path: string }[]> {
  return db
    .selectFrom('content_items')
    .select(['id', 'title', 'path'])
    .where('data', 'like', `%"type":"${blockApiId}"%`)
    .orderBy('path')
    .limit(limit)
    .execute();
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
    visible_when: input.visible_when ? stringifyJson(input.visible_when) : null,
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
    /**
     * `undefined` keeps the stored condition, `null` clears it — the two cannot be collapsed with
     * `??`, which is exactly how a request to remove `publish_at` was silently ignored. There is no
     * other way to make a conditional field unconditional again.
     */
    visible_when:
      input.visible_when === undefined
        ? existing.visible_when
        : input.visible_when
          ? stringifyJson(input.visible_when)
          : null,
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
