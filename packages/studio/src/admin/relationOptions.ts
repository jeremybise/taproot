import { getContentType, listItems, type FieldRow } from '@taprootcms/core';
import type { Kysely } from 'kysely';

import { reachableFields, walkStoredValues, type FieldRegistries } from './fieldTree.js';

/**
 * Candidate items for a `relation` field, resolved server-side.
 *
 * Same reasoning as `termOptionsForFields`: the editor page already reads the content type, so
 * pulling the candidates in the same pass avoids a request per relation field on every load and a
 * visible pop-in before the control can render.
 *
 * Unlike terms, a content type can hold far more items than belong in a prop, so this is a *first
 * page* rather than the whole set — the control searches past it through the items API, the same
 * split the media picker uses. `total` is what lets it say so rather than silently appearing to be
 * the complete list.
 */

export interface RelationOption {
  id: string;
  title: string;
  path: string;
  status: string;
}

export interface RelationTarget {
  contentTypeId: string;
  /** For wording: "Choose an Event", "Add Events". */
  name: string;
  namePlural: string;
  items: RelationOption[];
  /** How many the target type holds in total, so the control can say what it is not showing. */
  total: number;
}

/** How many candidates travel in the prop before the control has to search for more. */
const FIRST_PAGE = 50;

export async function relationTargetsForFields(
  db: Kysely<any>,
  fields: FieldRow[],
  /**
   * The item's stored values, so ids outside the first page still resolve to a title.
   *
   * Without this a field pointing at the 200th-oldest item would render as a bare id — the control
   * has no way to look it up, because searching by title cannot find something whose title it does
   * not know. Resolved here rather than through an `ids=` API parameter because the editor page is
   * already loading the item and can simply ask for them.
   */
  data: Record<string, unknown> = {},
  /**
   * Block types and library entries, so relation fields *inside* a block are found too.
   *
   * Optional because the content-type builder's preview has no registry to give — and because
   * a screen that forgets it degrades to the old behaviour for nested fields rather than throwing.
   */
  registries: FieldRegistries = {},
): Promise<Record<string, RelationTarget>> {
  /**
   * From the schema, not from the data — an editor adds a block after this page renders, and the
   * control inside it has to work when they do. See `fieldTree.ts` for why that is the whole point.
   */
  const targets = new Set<string>();
  for (const field of reachableFields(fields, registries.blockTypes ?? [])) {
    if (field.type !== 'relation') continue;
    const target = relationTargetId(field.config);
    // A malformed config leaves that field without options, not the whole editor without a target.
    if (target) targets.add(target);
  }

  if (targets.size === 0) return {};

  /** Ids already stored on this item, grouped by the type they point at. */
  const selectedByTarget = new Map<string, Set<string>>();
  walkStoredValues(fields, data, registries, (field, stored) => {
    if (field.type !== 'relation') return;
    const target = relationTargetId(field.config);
    if (!target) return;

    // Follows the field's own config: a bare id when single, an ordered array when multiple.
    const ids = Array.isArray(stored)
      ? stored.filter((entry): entry is string => typeof entry === 'string')
      : typeof stored === 'string' && stored
        ? [stored]
        : [];
    if (ids.length === 0) return;

    const set = selectedByTarget.get(target) ?? new Set<string>();
    for (const id of ids) set.add(id);
    selectedByTarget.set(target, set);
  });

  const contentTypeIds = [...targets];

  const entries = await Promise.all(
    contentTypeIds.map(async (contentTypeId) => {
      const contentType = await getContentType(db, contentTypeId);
      /**
       * A relation whose target type has been deleted resolves to nothing rather than throwing.
       *
       * Deleting a type that another type's relation field points at is refused, so this is
       * unusual — but an editor screen is the wrong place to discover a broken invariant.
       */
      if (!contentType) return null;

      const { items, total } = await listItems(db, { contentTypeId, limit: FIRST_PAGE });
      const options = items.map(toOption);

      const missing = [...(selectedByTarget.get(contentTypeId) ?? [])].filter(
        (id) => !options.some((option) => option.id === id),
      );

      if (missing.length > 0) {
        const rows = await db
          .selectFrom('content_items')
          .select(['id', 'title', 'path', 'status'])
          .where('id', 'in', missing)
          .execute();
        options.push(...rows.map(toOption));
      }

      return [
        contentTypeId,
        {
          contentTypeId,
          name: contentType.name,
          namePlural: contentType.name_plural,
          items: options,
          total,
        } satisfies RelationTarget,
      ] as const;
    }),
  );

  return Object.fromEntries(entries.filter((entry) => entry !== null));
}

/** Which content type each relation field points at, so the control can find its candidates. */
export function relationTargetId(config: string): string | null {
  try {
    return (JSON.parse(config) as { targetContentTypeId?: string | null }).targetContentTypeId ?? null;
  } catch {
    return null;
  }
}

function toOption(row: {
  id: string;
  title: string;
  path: string;
  status: string;
}): RelationOption {
  return { id: row.id, title: row.title, path: row.path, status: row.status };
}
