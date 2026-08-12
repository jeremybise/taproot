import type { Kysely } from 'kysely';

import type { ContentTypeRow, Database, FieldRow } from '../db/schema.js';
import type { TaprootDb } from '../db/client.js';
import { createItem, getItem, updateItem, type ContentItem } from './items.js';
import { getContentType } from './types.js';
import { descendantPathRange, normalizePath, slugify } from './paths.js';
import { remapRichTextItemRefs } from './richTextRefs.js';
import { newId } from '../ids.js';

/**
 * Copying a subtree — which is how a book gets its next edition.
 *
 * The rollover a versioned document needs: duplicate `/catalog/2026-27` and every section beneath it
 * to `/catalog/2027-28` as drafts, edit the copy, publish it. Freezing the old year is then
 * structural rather than enforced — the 2026-27 pages are *different rows*, so nothing anybody does
 * to next year's catalog can reach them. That is the whole argument for copy-forward over
 * effective-dating or a version column, and it is why a book refuses shared library content, which
 * would otherwise leak straight through the copy (see `books.ts`).
 *
 * Nothing here is book-specific. A subtree is a subtree, and the same operation serves any versioned
 * section of a site.
 */

/** What to call the copy, and where to put it. */
export interface DuplicateSubtreeInput {
  /** The copy's slug. Defaults to the source's, disambiguated by `createItem` against siblings. */
  slug?: string;
  /**
   * Where the copy's root goes. Defaults to the source's own parent, which makes the copy a sibling
   * — the shape an edition takes, since `/catalog/2026-27` and `/catalog/2027-28` share a parent.
   */
  parentId?: string | null;
  /** Title for the copy's root. Descendants always keep theirs. */
  title?: string;
  userId?: string | null;
  /**
   * How many items to write before returning. Defaults to everything.
   *
   * **Chunking is not optional at scale and this is how it is expressed.** A catalog year is ~280
   * items, each needing its own batch — D1 caps statements per batch, and every item carries path
   * rewrites, a revision, a taxonomy plan and two derived indexes — so one request cannot do it
   * inside a Worker's budget. A caller loops until `remaining` is 0.
   */
  limit?: number;
}

export interface DuplicateSubtreeResult {
  /** The copy's root, whether it was created by this call or an earlier one. */
  root: ContentItem;
  /** Items written by *this* call. */
  created: number;
  /** Items still to copy. Zero means done; anything else means call again. */
  remaining: number;
}

export class DuplicateError extends Error {
  override name = 'DuplicateError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid_target' = 'not_found',
  ) {
    super(message);
  }
}

/**
 * Copy an item and everything beneath it.
 *
 * **Resumable with no bookkeeping table, because the destination paths are derivable.** An item is
 * already copied when something exists at its mapped path, which is the same lookup-then-create
 * shape `seed.ts` uses to stay idempotent. So a caller can loop, a failed run can be re-run, and
 * nothing has to be cleaned up first — where a job table would need its own lifecycle, its own
 * sweep, and a story for what happens when a row outlives the content it describes.
 *
 * **Reads first, then compute, then write** — the batch rule, applied one item at a time rather than
 * once, since `createItem` owns its own batch and there is no transaction spanning N of them. The
 * consequence is honest and worth stating: an interrupted copy leaves a *partial* subtree of drafts,
 * not a corrupt one. Nothing is published, so nothing a visitor sees is affected, and the next call
 * carries on where this one stopped.
 *
 * Order is by depth, so a parent always exists before its child needs it as a `parentId`.
 */
export async function duplicateSubtree(
  handle: TaprootDb,
  rootId: string,
  input: DuplicateSubtreeInput = {},
): Promise<DuplicateSubtreeResult> {
  const { db } = handle;

  const source = await getItem(db, rootId);
  if (!source) throw new DuplicateError(`Content item ${rootId} not found.`);

  const sourceType = await getContentType(db, source.content_type_id);
  if (!sourceType) throw new DuplicateError(`Content type ${source.content_type_id} not found.`);

  /**
   * Only a `page` has a subtree to copy.
   *
   * A collection is flat under a `url_prefix` and a singleton is one item by definition, so "copy
   * this and everything under it" is a question neither can answer. Refused rather than quietly
   * copying one row, which would look like it worked.
   */
  if (sourceType.kind !== 'page') {
    throw new DuplicateError(
      `Only a page can be duplicated with its subtree; "${sourceType.name}" is a ${sourceType.kind}.`,
      'invalid_target',
    );
  }

  const parentId = input.parentId === undefined ? source.parent_id : input.parentId;
  const parent = parentId ? await getItem(db, parentId) : undefined;
  if (parentId && !parent) {
    throw new DuplicateError(`Parent item ${parentId} not found.`, 'invalid_target');
  }

  /**
   * The copy's root, created on the first call and found again on every later one.
   *
   * Found by path rather than remembered, which is what makes the whole operation resumable without
   * state. The desired slug is disambiguated by `createItem` exactly as any other create is, so two
   * runs cannot produce two roots: the second run finds the first run's.
   */
  const desiredSlug = slugify(input.slug ?? source.slug) || source.slug;
  const targetRootPath = normalizePath(`${parent ? parent.path : ''}/${desiredSlug}`);

  let created = 0;
  let root = await getItem(db, (await idAtPath(db, targetRootPath)) ?? '');

  if (!root) {
    root = await createItem(handle, sourceType, sourceType.fields, {
      contentTypeId: sourceType.id,
      title: input.title ?? source.title,
      slug: desiredSlug,
      parentId,
      // Always a draft. A copy of a published page must not go live the moment it is written — the
      // point of an edition is that somebody works on it before anybody sees it. `publish_at` is
      // left unset for the same reason revisions do not restore one: a scheduled moment is an
      // intention about the future, and it does not survive being copied.
      status: 'draft',
      data: remapData(source.data, new Map(), { mintIds: true }),
      seo: source.seo,
      userId: input.userId ?? null,
    });
    created += 1;
  }

  const limit = input.limit ?? Number.POSITIVE_INFINITY;
  if (created >= limit) {
    return { root, created, remaining: await countRemaining(db, source.path, root.path) };
  }

  /**
   * Everything under the source, shallowest first.
   *
   * Depth order is what lets a single pass work: a child's `parentId` must already exist as a copy,
   * and sorting by depth guarantees its parent was handled earlier in this loop or in a previous
   * call. `path` as a tiebreak keeps the order stable across calls, so resuming is deterministic.
   */
  const { start, end } = descendantPathRange(source.path);
  const descendants = await db
    .selectFrom('content_items')
    .selectAll()
    .where('path', '>', start)
    .where('path', '<', end)
    .orderBy('depth')
    .orderBy('path')
    .execute();

  /**
   * Source id → copy id, for remapping references.
   *
   * Rebuilt from the database on every call rather than carried between them, because a resumed run
   * has to remap against copies an *earlier* run made. Deriving it from paths is what keeps that
   * possible without storing anything.
   */
  const idMap = new Map<string, string>([[source.id, root.id]]);
  const copyPathFor = (sourcePath: string) => root!.path + sourcePath.slice(source.path.length);

  const existing = await db
    .selectFrom('content_items')
    .select(['id', 'path'])
    .where('path', '>', descendantPathRange(root.path).start)
    .where('path', '<', descendantPathRange(root.path).end)
    .execute();

  const copyIdByPath = new Map(existing.map((row) => [row.path, row.id]));
  for (const node of descendants) {
    const already = copyIdByPath.get(copyPathFor(node.path));
    if (already) idMap.set(node.id, already);
  }

  const typeCache = new Map<string, { type: ContentTypeRow; fields: FieldRow[] }>();
  const typeFor = async (id: string) => {
    const hit = typeCache.get(id);
    if (hit) return hit;
    const loaded = await getContentType(db, id);
    if (!loaded) throw new DuplicateError(`Content type ${id} not found.`);
    const entry = { type: loaded, fields: loaded.fields };
    typeCache.set(id, entry);
    return entry;
  };

  let remaining = 0;

  for (const node of descendants) {
    if (idMap.has(node.id)) continue;

    if (created >= limit) {
      remaining += 1;
      continue;
    }

    const parentCopyId = node.parent_id ? idMap.get(node.parent_id) : undefined;
    /**
     * A descendant whose parent has not been copied yet is left for the next call.
     *
     * Reachable when a `limit` cut the previous pass mid-tree. Counting it as remaining rather than
     * attaching it somewhere plausible is the only honest option — a section silently re-parented
     * to the book's root is a table of contents that is quietly wrong.
     */
    if (!parentCopyId) {
      remaining += 1;
      continue;
    }

    const { type, fields } = await typeFor(node.content_type_id);

    const copy = await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: node.title,
      slug: node.slug,
      parentId: parentCopyId,
      status: 'draft',
      data: remapData(parseData(node.data), idMap, { mintIds: true }),
      seo: parseData(node.seo),
      userId: input.userId ?? null,
    });

    idMap.set(node.id, copy.id);
    created += 1;
  }

  /**
   * A second pass over what was written, so a link *forward* in the tree is not left dangling.
   *
   * The copy loop remaps against the ids it knows, and it cannot know one it has not created yet —
   * a chapter linking to an appendix later in the book would keep pointing at the original. Rather
   * than a topological sort over an arbitrary reference graph (which can be cyclic, and a book's
   * cross-references frequently are), every item is written once and then repaired once with the
   * complete map.
   *
   * Only items whose remapped data actually differs are rewritten, so a book with no internal links
   * pays nothing, and a resumed run does not churn what an earlier one already fixed.
   */
  if (remaining === 0) created += await repairReferences(handle, root, idMap, input.userId ?? null);

  return { root, created, remaining };
}

/** Whether anything under the source has no counterpart under the copy yet. */
async function countRemaining(
  db: Kysely<Database>,
  sourcePath: string,
  targetPath: string,
): Promise<number> {
  const source = descendantPathRange(sourcePath);
  const target = descendantPathRange(targetPath);

  const [from, to] = await Promise.all([
    db
      .selectFrom('content_items')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('path', '>', source.start)
      .where('path', '<', source.end)
      .executeTakeFirst(),
    db
      .selectFrom('content_items')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('path', '>', target.start)
      .where('path', '<', target.end)
      .executeTakeFirst(),
  ]);

  return Math.max(0, Number(from?.count ?? 0) - Number(to?.count ?? 0));
}

async function idAtPath(db: Kysely<Database>, path: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('content_items')
    .select('id')
    .where('path', '=', path)
    .executeTakeFirst();
  return row?.id;
}

function parseData(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Rewrite every reference that points inside the copied subtree, and re-mint every instance id.
 *
 * **Five field types carry an item reference, not one.** The obvious version of this remaps
 * `relation` fields and stops — and then a `link` field's button, a rich-text paragraph's internal
 * link, and anything of either kind nested inside a block or a repeater row all keep pointing at
 * last year's pages. None of those breaks visibly: every link works and lands on a real page that
 * looks almost the same, which is exactly why it would survive review.
 *
 * Structural rather than definition-driven, deliberately. `collectReferences` walks by field type
 * and needs the schema; this runs over stored `data` where the shapes are unambiguous on their own —
 * a `{ kind: 'item', id }` object is a link wherever it sits, and a string containing
 * `taproot:item:` is prose wherever it sits. That means one walk covers every depth without loading
 * a block registry, and it cannot be defeated by a field whose definition has since changed.
 *
 * **Media, taxonomy terms and query rules are left alone.** They point *outside* the subtree by
 * design: a copy shares the library's assets and the site's vocabulary, and a saved query is a rule
 * rather than a set of ids. Remapping them would be a bug, not a missing feature.
 *
 * Block instance ids and repeater row ids are re-minted, because an id should identify one thing —
 * and `queryKey` is `${containerId}:${fieldApiId}`, so two pages sharing a block instance id is a
 * collision waiting for somebody to put a query field in that block.
 */
export function remapData(
  value: Record<string, unknown>,
  idMap: ReadonlyMap<string, string>,
  options: { mintIds?: boolean } = {},
): Record<string, unknown> {
  return remapValue(value, idMap, options.mintIds ?? false) as Record<string, unknown>;
}

/**
 * `mintIds` is off by default, and the split is what makes the repair pass possible.
 *
 * Copying an item mints fresh block and repeater ids; repairing one afterwards must not, or every
 * repair would differ from what it is comparing against and the pass could never decide that
 * nothing changed. Two callers, two answers, one walk.
 */
function remapValue(value: unknown, idMap: ReadonlyMap<string, string>, mintIds: boolean): unknown {
  if (typeof value === 'string') {
    // A bare id — a `relation` or `media` field's stored value. Only remapped when the map knows it,
    // which is what leaves a media id and an outside-the-subtree relation untouched.
    return idMap.get(value) ?? remapRichTextItemRefs(value, idMap);
  }

  if (Array.isArray(value)) return value.map((entry) => remapValue(entry, idMap, mintIds));

  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(record)) {
      /**
       * A `link` field's `{ kind: 'item', id }`. Remapped only for the `item` kind: a `media` link
       * points at the shared library, and a `url` has no id at all.
       */
      if (key === 'id' && typeof entry === 'string') {
        const isItemLink = record.kind === 'item';
        const isEnvelope = typeof record.type === 'string' || 'data' in record;

        if (isItemLink) {
          out.id = idMap.get(entry) ?? entry;
          continue;
        }
        // A block instance or a repeater row: re-minted on a copy, left alone on a repair.
        if (isEnvelope) {
          out.id = mintIds ? newId() : entry;
          continue;
        }
      }

      out[key] = remapValue(entry, idMap, mintIds);
    }

    return out;
  }

  return value;
}

/**
 * Fix references that pointed at items copied after their referrer.
 *
 * See the call site: one repair pass beats a topological sort, because a book's cross-references are
 * routinely cyclic and a sort has no answer for that.
 */
async function repairReferences(
  handle: TaprootDb,
  root: ContentItem,
  idMap: ReadonlyMap<string, string>,
  userId: string | null,
): Promise<number> {
  const { db } = handle;
  const { start, end } = descendantPathRange(root.path);

  const copies = await db
    .selectFrom('content_items')
    .selectAll()
    .where((eb) =>
      eb.or([eb('id', '=', root.id), eb.and([eb('path', '>', start), eb('path', '<', end)])]),
    )
    .execute();

  let repaired = 0;

  for (const copy of copies) {
    const current = parseData(copy.data);
    // No id minting here, so an unchanged item compares equal and is skipped — which is what keeps a
    // book with no internal links from being rewritten end to end for nothing.
    const remapped = remapData(current, idMap);
    if (JSON.stringify(current) === JSON.stringify(remapped)) continue;

    const contentType = await getContentType(db, copy.content_type_id);
    if (!contentType) continue;

    await updateItem(handle, contentType, contentType.fields, copy.id, {
      data: remapped,
      userId,
      revisionReason: 'save',
    });
    repaired += 1;
  }

  return repaired;
}
