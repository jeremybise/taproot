import {
  buildTermTree,
  listTaxonomies,
  listTerms,
  type FieldRow,
  type TermNode,
} from '@taprootcms/core';
import type { Kysely } from 'kysely';

import type { TermOption } from './islands/fields/FieldControl.js';
import { reachableFields, type FieldRegistries } from './fieldTree.js';

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
  /**
   * Block types, so a taxonomy field *inside* a block is found too.
   *
   * From the schema rather than the item's data, and no `reusableBlocks` needed: this answers "which
   * taxonomies could be picked from on this screen", which does not depend on what has been placed
   * yet. Terms are loaded whole, so unlike relations there is nothing stored to resolve afterwards.
   */
  registries: FieldRegistries = {},
): Promise<Record<string, TermOption[]>> {
  const taxonomyIds = new Set<string>();

  for (const field of reachableFields(fields, registries.blockTypes ?? [])) {
    /**
     * `query` as well as `taxonomy`, because both name a taxonomy in the same config key and both
     * need its terms on screen — one to file content under a term, the other to filter a listing by
     * one. Missing the second is silent: the field renders with an empty set of checkboxes, which
     * reads as "this taxonomy has no terms" rather than "nobody asked for them".
     */
    if (field.type !== 'taxonomy' && field.type !== 'query') continue;
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

/**
 * Every taxonomy with its terms, for the content list's term filter.
 *
 * Grouped by taxonomy so the select can use `<optgroup>` — a site with a Departments tree and an
 * Audience tree would otherwise present one flat list where "Admissions" and "Prospective students"
 * sit at the same level with nothing to say they answer different questions.
 *
 * Returns an empty list when a site has no taxonomies, which the screens use to omit the control
 * entirely rather than render a select with one option in it.
 */
export async function taxonomyFilterOptions(
  db: Kysely<any>,
): Promise<{ id: string; name: string; terms: TermOption[] }[]> {
  const taxonomies = await listTaxonomies(db);

  const groups = await Promise.all(
    taxonomies.map(async (taxonomy) => ({
      id: taxonomy.id,
      name: taxonomy.name,
      terms: flatten(buildTermTree(await listTerms(db, taxonomy.id))),
    })),
  );

  return groups.filter((group) => group.terms.length > 0);
}

function flatten(nodes: TermNode[], depth = 0): TermOption[] {
  return nodes.flatMap((node) => [
    { id: node.id, name: node.name, depth },
    ...flatten(node.children, depth + 1),
  ]);
}
