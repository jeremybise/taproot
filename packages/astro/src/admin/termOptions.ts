import { buildTermTree, listTerms, type FieldRow, type TermNode } from '@taproot/core';
import type { Kysely } from 'kysely';

import type { TermOption } from './islands/fields/FieldControl.js';

/**
 * Resolve the selectable terms for every taxonomy field on a content type.
 *
 * Loaded server-side and handed to the editor island as a prop. The alternative — the control
 * fetching per field on mount — would mean a request per taxonomy field on every editor load, and
 * a visible pop-in before the picker could render.
 *
 * Order is depth-first, not the storage order. `listTerms` returns rows sorted by depth so that a
 * flat read groups every root together, but a picker has to show each child directly beneath its
 * own parent or the indentation describes a tree that isn't there.
 */
export async function termOptionsForFields(
  db: Kysely<any>,
  fields: FieldRow[],
): Promise<Record<string, TermOption[]>> {
  const taxonomyIds = new Set<string>();

  for (const field of fields) {
    if (field.type !== 'taxonomy') continue;
    try {
      const taxonomyId = (JSON.parse(field.config) as { taxonomyId?: string | null }).taxonomyId;
      if (taxonomyId) taxonomyIds.add(taxonomyId);
    } catch {
      // A malformed config should leave the field without options, not break the whole editor.
    }
  }

  const entries = await Promise.all(
    [...taxonomyIds].map(async (taxonomyId) => {
      const terms = await listTerms(db, taxonomyId);
      return [taxonomyId, flatten(buildTermTree(terms))] as const;
    }),
  );

  return Object.fromEntries(entries);
}

function flatten(nodes: TermNode[], depth = 0): TermOption[] {
  return nodes.flatMap((node) => [
    { id: node.id, name: node.name, depth },
    ...flatten(node.children, depth + 1),
  ]);
}
