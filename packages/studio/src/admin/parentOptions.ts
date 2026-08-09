import {
  listContentTypes,
  listItemSummaries,
  type ContentItemSummary,
  type ContentTypeRow,
} from '@taprootcms/core';
import type { Kysely } from 'kysely';

import { PICKER_FIRST_PAGE } from './itemPicker.js';

/**
 * Candidate parents for a `page`-kind item, resolved server-side.
 *
 * Extracted from the two screens that render the picker — `content/[id].astro` and
 * `content/new.astro` — for the reason `fieldTree.ts` and `status.ts` were: an `.astro` file's
 * contents are neither type-checked nor testable here. The ambient shim in `astro-modules.d.ts`
 * only makes the import resolve, so logic left inline in one is logic no suite can reach, and this
 * had drifted from what `createItem` actually allows without anything noticing.
 *
 * ## A parent need not share the item's content type
 *
 * Both screens used to ask for `{ contentTypeId: contentType.id }`, so the picker offered only
 * items of the same type. Nothing in core imposes that: `createItem` looks the parent up by id and
 * checks that it exists, and `resolveItemPath`, the breadcrumb walk and the cascading path rewrite
 * are all indifferent to which type a parent belongs to. A campus site nests a Program under a
 * Program Group under a Program Category, which is three types and one tree.
 *
 * The narrowing was not a save-time bug, which is why it survived — `ItemEditor` keeps the real
 * `parentId` in React state, so an untouched save still writes the right value. It was a *display*
 * bug with a sharp edge: a controlled `<select>` whose `value` matches no `<option>` renders blank,
 * so a correctly nested item looked parentless, and every option on offer would have moved it
 * somewhere wrong — rewriting every descendant's URL and writing redirects on the way.
 *
 * `contentTypeKinds` already existed on `ItemFilters` for the delivery listing, so this needs
 * nothing from core.
 */

export interface ParentOption {
  id: string;
  title: string;
  path: string;
  /**
   * The owning content type's name, for the picker's `<optgroup>`.
   *
   * Grouping is not decoration once the candidate set spans every page-kind type: choosing a parent
   * for a Program means finding a Program Group, and a flat list of a hundred-odd paths makes that
   * a reading exercise. It also keeps the plain `page` type's picker — the one most people use —
   * from silently becoming a list of everything.
   */
  typeName: string;
}

/**
 * How many candidates travel to the picker before it has to search for more.
 *
 * This was 500, and the comment here said so because the control was a `<select>`: the whole
 * candidate set had to fit in the prop, truncation was the failure to fear, and the note ended
 * *"the real answer past this size is a searchable control on `RelationField`'s pattern, which is a
 * different piece of work"*. That work is done — `ItemPicker` searches through the items API with
 * the same `contentTypeKinds: ['page']` narrowing this applies — so the number now sizes a **first
 * page** rather than a ceiling, and small enough that a large site is not shipping five hundred rows
 * of JSON into every editor load. `total` is what lets the control say what it is not showing.
 */
const PARENT_LIMIT = PICKER_FIRST_PAGE;

export interface ParentCandidates {
  options: ParentOption[];
  /**
   * How many page-kind items exist in total, **before** self and descendants are removed.
   *
   * Only ever used to say "showing N of M, search to reach the rest", so an off-by-a-few against the
   * genuinely selectable set is not worth a second query to correct — and correcting it would mean
   * counting a subtree the picker is about to exclude anyway.
   */
  total: number;
}

export async function parentCandidates(
  db: Kysely<any>,
  contentType: Pick<ContentTypeRow, 'kind'>,
  /**
   * The item being edited, when there is one.
   *
   * Absent on the create screen, where nothing needs excluding because the item does not exist yet.
   */
  item?: Pick<ContentItemSummary, 'id' | 'path'>,
): Promise<ParentCandidates> {
  // Only a `page` nests. A collection is flat under its `url_prefix` and a singleton has one
  // synthetic path, so `createItem` force-nulls `parentId` for both and a picker would be offering
  // a choice that is discarded.
  if (contentType.kind !== 'page') return { options: [], total: 0 };

  const [{ items, total }, types] = await Promise.all([
    listItemSummaries(db, { contentTypeKinds: ['page'], limit: PARENT_LIMIT }),
    listContentTypes(db),
  ]);

  /** Type ids to their name and sidebar position, for the group label and the group order. */
  const byTypeId = new Map(types.map((type, index) => [type.id, { name: type.name, index }]));

  const options = (
    items
      .filter((candidate) => {
        if (!item) return true;
        // An item cannot be its own parent, and cannot move under its own descendants — the server
        // rejects both, but keeping them out of the menu means never offering a choice that fails.
        return candidate.id !== item.id && !candidate.path.startsWith(`${item.path}/`);
      })
      .map((candidate) => {
        // A type missing from the map would mean an item whose content type is a block, which
        // `createItem` refuses — so this sorts last and is labelled rather than dropped, because a
        // parent an editor can see and cannot explain beats one that silently is not there.
        const type = byTypeId.get(candidate.content_type_id);
        return {
          order: type?.index ?? Number.MAX_SAFE_INTEGER,
          option: {
            id: candidate.id,
            title: candidate.title,
            path: candidate.path,
            typeName: type?.name ?? 'Other',
          } satisfies ParentOption,
        };
      })
      /*
       * Grouped in sidebar order, and stable — `listItemSummaries` defaults to ordering by `path`,
       * and a stable sort keeps that ordering inside each group, so a group still reads as a tree.
       * `<optgroup>` requires its options to be contiguous, which is what makes the sort mandatory
       * rather than cosmetic.
       */
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.option)
  );

  return { options, total };
}
