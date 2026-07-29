import type { Kysely } from 'kysely';
import type { Database } from '@taproot/core';
import { blockTypeRegistry, listReusableBlocks } from '@taproot/core';

import type {
  BlockTypeOption,
  ReusableBlockOption,
} from './islands/fields/BlockListEditor.js';

/**
 * Block types with their fields, shaped for the editor island.
 *
 * Loaded whenever a content type has a `block` field, for the same reason taxonomy terms are: the
 * editor page already reads the content type, so resolving the block schemas in the same pass
 * avoids a request per block field on every page load — and means the editor can render a block's
 * inputs immediately rather than after a round trip.
 *
 * Returns an empty list when the type has no block fields, so a site that never uses blocks pays
 * one boolean check rather than a query.
 */
export async function blockTypeOptionsForFields(
  db: Kysely<Database>,
  fields: { type: string }[],
): Promise<BlockTypeOption[]> {
  if (!fields.some((field) => field.type === 'block')) return [];

  const registry = await blockTypeRegistry(db);
  return [...registry.values()];
}

/**
 * Library entries placeable into this type's block fields.
 *
 * The whole library rather than a filtered slice: `FieldControl` narrows it per field by the block
 * types that field allows, and a site's library is small enough that one query beats one per field.
 */
export async function reusableBlockOptionsForFields(
  db: Kysely<Database>,
  fields: { type: string }[],
): Promise<ReusableBlockOption[]> {
  if (!fields.some((field) => field.type === 'block')) return [];

  return (await listReusableBlocks(db)).map((entry) => ({
    id: entry.id,
    name: entry.name,
    block_type: entry.block_type,
    data: entry.data,
  }));
}
