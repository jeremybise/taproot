import { getContentType, listItems, type FieldRow } from '@taproot/core';
import type { Kysely } from 'kysely';

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
): Promise<Record<string, RelationTarget>> {
  const targetsByField = new Map<string, string>();

  for (const field of fields) {
    if (field.type !== 'relation') continue;
    try {
      const config = JSON.parse(field.config) as { targetContentTypeId?: string | null };
      if (config.targetContentTypeId) targetsByField.set(field.api_id, config.targetContentTypeId);
    } catch {
      // A malformed config should leave the field without options, not break the whole editor.
    }
  }

  if (targetsByField.size === 0) return {};

  /** Ids already stored on this item, grouped by the type they point at. */
  const selectedByTarget = new Map<string, Set<string>>();
  for (const [apiId, contentTypeId] of targetsByField) {
    const stored = data[apiId];
    const ids = Array.isArray(stored)
      ? stored.filter((entry): entry is string => typeof entry === 'string')
      : typeof stored === 'string' && stored
        ? [stored]
        : [];
    if (ids.length === 0) continue;
    const set = selectedByTarget.get(contentTypeId) ?? new Set<string>();
    for (const id of ids) set.add(id);
    selectedByTarget.set(contentTypeId, set);
  }

  const contentTypeIds = [...new Set(targetsByField.values())];

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
