import type { Kysely } from 'kysely';
import type { Database } from '@taproot/core';
import { blockTypeRegistry } from '@taproot/core';

import type { BlockTypeOption } from './islands/fields/BlockListEditor.js';

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
