import { MAX_BLOCK_DEPTH, repeaterRowFields, type FieldRow } from '@taprootcms/core';

import type { BlockTypeOption, ReusableBlockOption } from './islands/fields/BlockListEditor.js';

/**
 * Reaching the fields that are not in `content_types.fields`.
 *
 * A content type's field list is only the top level. A relation sitting inside a block type, or
 * inside a repeater row, is just as editable and was invisible to every server-side resolver here —
 * so `relationTargetsForFields` found no target for it and `RelationField` rendered "Items of the
 * target type are listed here in the item editor", which is a sentence about a screen the editor was
 * already looking at. Same gap for `taxonomy`. `media` escaped it only because `mediaOptions` loads
 * the library wholesale rather than per field.
 *
 * **There are two walks here and they answer different questions.** Collapsing them into one is the
 * obvious simplification and it reintroduces half the bug:
 *
 * - `reachableFields` walks the *schema* — every field an editor could reach on this screen, whether
 *   or not anything holding it exists yet. That is the one that matters for options, because an
 *   editor adds a Slider block *after* the page has rendered and the control has to work when they
 *   do. A data-driven walk would resolve targets only for blocks already placed, which looks correct
 *   on every screen where somebody is editing and fails on every screen where somebody is composing.
 * - `walkStoredValues` walks the *values*, and is only for resolving what is already stored —
 *   a relation pointing past the first page of candidates needs its title looked up by id.
 */

export interface FieldRegistries {
  blockTypes?: BlockTypeOption[];
  reusableBlocks?: ReusableBlockOption[];
}

/**
 * Every field definition an editor could reach from this screen.
 *
 * No depth bound and no recursion through `block`, deliberately: `blockTypes` is the whole registry,
 * so the union of every block type's fields is already closed under "a block field holds some block
 * type". Recursing would revisit the same lists and terminate on a counter instead of on the data.
 * Repeaters do recurse, exactly one level — `REPEATER_SUB_FIELD_TYPES` excludes `block` and
 * `repeater`, so a row's fields are all leaves.
 */
export function reachableFields(fields: FieldRow[], blockTypes: BlockTypeOption[] = []): FieldRow[] {
  const out: FieldRow[] = [];

  const push = (list: FieldRow[]) => {
    for (const field of list) {
      out.push(field);
      if (field.type === 'repeater') out.push(...repeaterRowFields(field));
    }
  };

  push(fields);
  for (const type of blockTypes) push(type.fields);

  return out;
}

/**
 * Every stored `(field, value)` pair, descending through block instances and repeater rows.
 *
 * Mirrors `referencedMediaIds`' walk in core, including its `MAX_BLOCK_DEPTH` bound and its
 * treatment of a reusable block — whose content belongs to the library entry, not to the page.
 */
export function walkStoredValues(
  fields: FieldRow[],
  data: Record<string, unknown>,
  registries: FieldRegistries,
  visit: (field: FieldRow, value: unknown) => void,
): void {
  const blockTypes = new Map((registries.blockTypes ?? []).map((type) => [type.api_id, type]));
  const reusable = new Map((registries.reusableBlocks ?? []).map((entry) => [entry.id, entry]));

  const walk = (list: FieldRow[], values: Record<string, unknown>, depth: number): void => {
    for (const field of list) {
      const value = values[field.api_id];
      visit(field, value);

      if (field.type === 'block' && Array.isArray(value) && depth > 0) {
        for (const block of value) {
          if (typeof block !== 'object' || block === null) continue;
          const instance = block as { type?: string; ref?: string; data?: unknown };

          // A referencing page stores no copy, so the values are the library entry's.
          if (instance.ref) {
            const entry = reusable.get(instance.ref);
            const refType = entry && blockTypes.get(entry.block_type);
            if (entry && refType) walk(refType.fields, entry.data ?? {}, depth - 1);
            continue;
          }

          const blockType = instance.type ? blockTypes.get(instance.type) : undefined;
          if (blockType) {
            walk(blockType.fields, asRecord(instance.data), depth - 1);
          }
        }
        continue;
      }

      if (field.type === 'repeater' && Array.isArray(value)) {
        const sub = repeaterRowFields(field);
        if (sub.length === 0) continue;

        for (const row of value) {
          if (typeof row !== 'object' || row === null) continue;
          // The row envelope: `{ id, data }`, with the sub-field values under `data`.
          const rowData = (row as { data?: unknown }).data;
          if (typeof rowData !== 'object' || rowData === null) continue;
          walk(sub, rowData as Record<string, unknown>, depth);
        }
      }
    }
  };

  walk(fields, data, MAX_BLOCK_DEPTH);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
