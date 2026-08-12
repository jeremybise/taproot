import type { Kysely } from 'kysely';

import type { ContentStatus, ContentTypeRow, Database } from '../db/schema.js';
import { parseJson } from '../db/values.js';
import { ancestorPaths, descendantPathRange, normalizePath } from './paths.js';
import { hasSnippetToken } from './snippetTokens.js';

/**
 * Books — content that is a document rather than a section of a site.
 *
 * A course catalog, a student handbook, a policy manual. What makes one a book is that it has an
 * *outline*: a reading order, a table of contents, and previous/next between its sections. See
 * `0034_books` for why this is a column on the content type rather than an entity of its own, and
 * why editions are deliberately not modelled.
 *
 * **A book refuses reusable blocks and text snippets, and that is the point rather than a
 * restriction.** The reason a book exists as a concept here is that a published edition must not
 * change: a student holds catalog rights to the year they entered under, so if a course drops from
 * three credits to two in 2027-28, the 2026-27 catalog must still say three, forever. Copying a
 * subtree gets that for the *items*, because the copies are different rows — and loses it for
 * anything they reference out of a shared library. A reusable block and a snippet are both resolved
 * at read time from a row an editor edits centrally, so editing `{{ tuition }}` once silently
 * rewrites every archived year's tuition figure, with no revision on any page recording that it
 * happened.
 *
 * Three notes on the rule, because each has a plausible wrong answer:
 *
 * - **Media stays allowed, and the asymmetry is principled rather than a carve-out.** A media row's
 *   *bytes* are immutable by construction — the storage key derives from the asset id, so replacing
 *   an image writes a new row with a new id. What an editor can still change in place is alt text,
 *   title, hotspot and crop, none of which is a factual claim the document is making. A snippet's
 *   whole purpose is the opposite of that.
 * - **The obvious objection has a better answer than the feature it refuses.** "Every page carries
 *   the accreditation statement" looks like it costs a copy-paste per section. It does not: that
 *   content belongs on the **book root's own fields**, rendered into every section by the site's
 *   template. Per-edition by construction, one field rather than one copy per page, and Taproot
 *   ships no templates so it costs nothing to say.
 * - **Do not add a per-book "allow shared content" toggle** if the rule proves too strong. It would
 *   change meaning the moment somebody presses Duplicate, and would let a copy produce an edition
 *   that is already leaking. The growth path is book-scoped library rows.
 */

/**
 * Whether items of this type are book roots.
 *
 * Asked as a question about the type rather than read off the column at each call site, for the
 * reason `typeHasItemPages` states: `book_root` is only meaningful for a `page`, because a
 * collection is flat under a `url_prefix` and a singleton has exactly one item — neither has a tree
 * to outline. A call site reading the column directly is one that will forget the kind check.
 */
export function typeIsBookRoot(contentType: Pick<ContentTypeRow, 'kind' | 'book_root'>): boolean {
  return contentType.kind === 'page' && contentType.book_root === 1;
}

/**
 * Whether this data holds anything a book would refuse.
 *
 * **The gate that keeps the rule free for everything else.** Answering "is this item in a book"
 * costs an indexed query, and every content write in the deployment would otherwise pay it to
 * discover that almost nothing places a reusable block or a snippet. This is the same data-driven
 * gate `blockTypesFor` uses to skip loading the block registry for an item with no blocks: cheap,
 * synchronous, and conservative in the direction that matters — it may say yes and find no book,
 * which costs one query, but it never says no about data that holds something.
 *
 * Structural rather than definition-driven, deliberately. A `ref` inside a block inside a repeater
 * row is the same fact at any depth, and a walk that needed field definitions could not run before
 * the block registry has been loaded — which is the decision this gate exists to make. Same
 * argument `collectReusableIds` makes for reading the payload structurally.
 *
 * **A token that names no snippet still counts, and that is the deliberate answer.** `{{ tuition }}`
 * with no such snippet renders as itself today, so refusing it looks like a false positive — until
 * somebody creates a snippet called `tuition` next year and every archived edition silently starts
 * substituting it. That is the leak this rule exists to close, arriving late and with nothing left
 * to catch it. Asking whether the snippet *currently* exists would also make this async and put a
 * query on the write path, which is the cost the gate exists to avoid. The escape is to write the
 * value out, which the error message says.
 */
export function holdsSharedContent(value: unknown): boolean {
  if (typeof value === 'string') return hasSnippetToken(value);

  if (Array.isArray(value)) return value.some(holdsSharedContent);

  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    // A placed reusable block. The stored shape is `{ id, type, data, ref }` — `data` is empty and
    // filled in at read time, so `ref` is the whole of what marks it.
    if (typeof record.ref === 'string' && record.ref !== '') return true;
    return Object.values(record).some(holdsSharedContent);
  }

  return false;
}

/** A book root, as the thing that owns a subtree. */
export interface BookRoot {
  id: string;
  title: string;
  path: string;
  contentTypeId: string;
}

/**
 * The book a path belongs to, or undefined.
 *
 * Includes the path itself, so a book root is in its own book — which is what every caller means by
 * "which book is this in", and what makes the nesting check below read as `bookRootFor(parent)`.
 *
 * **One indexed query, whatever the depth.** The ancestor paths are known from the path itself, so
 * this is a single `in` against the unique path index rather than a walk up the tree — the same
 * shape `resolveDelivery` uses for breadcrumbs, and for the same reason: one lookup per ancestor is
 * exactly the N+1 `npm run query-count` exists to catch.
 *
 * Nested books are refused on write, so at most one row can come back; the deepest is taken anyway
 * rather than asserting, because a read path should not throw over data it can interpret.
 */
export async function bookRootFor(
  db: Kysely<Database>,
  path: string,
): Promise<BookRoot | undefined> {
  const normalized = normalizePath(path);
  const candidates = [...ancestorPaths(normalized), normalized];
  if (candidates.length === 0) return undefined;

  const rows = await db
    .selectFrom('content_items')
    .innerJoin('content_types', 'content_types.id', 'content_items.content_type_id')
    .select([
      'content_items.id as id',
      'content_items.title as title',
      'content_items.path as path',
      'content_items.content_type_id as contentTypeId',
    ])
    .where('content_items.path', 'in', candidates)
    .where('content_types.kind', '=', 'page')
    .where('content_types.book_root', '=', 1)
    .execute();

  if (rows.length === 0) return undefined;

  // Deepest wins: "which book am I in" means the innermost one that contains me.
  return rows.reduce((deepest, row) => (row.path.length > deepest.path.length ? row : deepest));
}

/** A book as the Books screen lists it. */
export interface BookSummary extends BookRoot {
  status: ContentStatus;
  updatedAt: string;
  typeApiId: string;
  typeName: string;
  /** Sections beneath it, at any depth — what tells "started" from "a real document". */
  sectionCount: number;
  /**
   * The parent's title, or null at the top level.
   *
   * What the screen groups by, and the whole of how editions are expressed: `/catalog/2026-27` and
   * `/catalog/2027-28` are two books sharing an ordinary parent, so "Catalog" is a heading rather
   * than a row. Nothing models an edition — see `0034_books`.
   */
  parentTitle: string | null;
  parentId: string | null;
}

/**
 * Every book, newest first within its parent.
 *
 * Two queries whatever the number of books: one for the roots, one counting sections for all of
 * them at once. Counting per row would be the N+1 the reusable-block and snippet lists are already
 * documented as deliberately paying — affordable there because those tables hold tens of rows, and
 * not worth copying here when a single grouped count answers it.
 */
export async function listBooks(db: Kysely<Database>): Promise<BookSummary[]> {
  const roots = await db
    .selectFrom('content_items')
    .innerJoin('content_types', 'content_types.id', 'content_items.content_type_id')
    .leftJoin('content_items as parent', 'parent.id', 'content_items.parent_id')
    .select([
      'content_items.id as id',
      'content_items.title as title',
      'content_items.path as path',
      'content_items.status as status',
      'content_items.updated_at as updatedAt',
      'content_items.parent_id as parentId',
      'content_items.content_type_id as contentTypeId',
      'content_types.api_id as typeApiId',
      'content_types.name as typeName',
      'parent.title as parentTitle',
    ])
    .where('content_types.kind', '=', 'page')
    .where('content_types.book_root', '=', 1)
    .orderBy('content_items.path')
    .execute();

  if (roots.length === 0) return [];

  /**
   * Section counts for every book in one pass.
   *
   * Each book is a path range, so this reads the paths once and buckets them in memory rather than
   * issuing a count per book. Books are few and their subtrees are not, which is the shape that
   * makes the single scan the cheaper side of the trade.
   */
  const ranges = roots.map((root) => ({ id: root.id, ...descendantPathRange(root.path) }));
  const paths = await db.selectFrom('content_items').select('path').execute();

  const counts = new Map<string, number>();
  for (const row of paths) {
    for (const range of ranges) {
      if (row.path > range.start && row.path < range.end) {
        counts.set(range.id, (counts.get(range.id) ?? 0) + 1);
      }
    }
  }

  return roots.map((root) => ({ ...root, sectionCount: counts.get(root.id) ?? 0 }));
}

/** Something already stored that a book would refuse. */
export interface BookConflict {
  id: string;
  title: string;
  path: string;
  /** Which rule it breaks, so a screen can say so rather than just listing paths. */
  reason: 'reusable_block' | 'snippet';
}

/**
 * What would break if this content type became a book root.
 *
 * **"Never leave a deployment in a state its own UI cannot reach", approached from the one direction
 * care at the input cannot cover.** Ticking the box is a rule change applied to content written
 * weeks earlier: every existing item of this type gains a subtree that now refuses reusable blocks
 * and snippets, and nothing on the settings screen would have hinted at it. Left unreported, the
 * consequence lands on somebody else entirely — an editor opens an unrelated page inside that
 * subtree, presses Save, and is refused by a rule they did not set and cannot see. Same shape as the
 * `url_prefix` repair in `0030`, and the same answer: report before the write.
 *
 * A **blocker**, not a warning, following `contentTypeDeleteBlockers`: the guard lives here and the
 * screen renders it, so the affordance cannot drift from what the write path will accept.
 *
 * Two queries whatever the size of the site. The `like` prefilter is a scan and is affordable for
 * exactly the reason `countBlockUsage`'s is — this runs when somebody ticks a box on a settings
 * screen, not on a read path — and it is **verified in JS afterwards** with the same
 * `holdsSharedContent` the write path uses, which is the repo's standing pattern for reaching into
 * `data`: the `like` narrows, it never decides.
 */
export async function bookRootBlockers(
  db: Kysely<Database>,
  contentType: ContentTypeRow,
): Promise<BookConflict[]> {
  if (contentType.kind !== 'page') return [];

  const roots = await db
    .selectFrom('content_items')
    .select('path')
    .where('content_type_id', '=', contentType.id)
    .execute();

  if (roots.length === 0) return [];

  const candidates = await db
    .selectFrom('content_items')
    .select(['id', 'title', 'path', 'data'])
    .where((eb) =>
      eb.or([eb('data', 'like', '%"ref"%'), eb('data', 'like', '%{{%')]),
    )
    .execute();

  const ranges = roots.map((root) => descendantPathRange(root.path));
  const rootPaths = new Set(roots.map((root) => root.path));

  const conflicts: BookConflict[] = [];
  for (const row of candidates) {
    // A book root is inside its own book, so its own front matter counts too.
    const inside =
      rootPaths.has(row.path) ||
      ranges.some((range) => row.path > range.start && row.path < range.end);
    if (!inside) continue;

    const data = parseJson<Record<string, unknown>>(row.data, {});
    if (!holdsSharedContent(data)) continue;

    conflicts.push({
      id: row.id,
      title: row.title,
      path: row.path,
      reason: holdsReusableBlock(data) ? 'reusable_block' : 'snippet',
    });
  }

  return conflicts;
}

/** Which of the two rules an item breaks, for the message. Structural, like `holdsSharedContent`. */
function holdsReusableBlock(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsReusableBlock);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.ref === 'string' && record.ref !== '') return true;
    return Object.values(record).some(holdsReusableBlock);
  }
  return false;
}

/**
 * Whether an item of this type, placed at this parent, sits inside a book.
 *
 * The question `validateItemData`'s `allowSharedContent` is derived from, and it takes the *parent's*
 * path because on a create the item has no path yet — while on an update the destination parent is
 * what decides, not where the item is now. Both write paths ask it the same way for that reason.
 *
 * **A book root is inside its own book**, which is not a special case but the rule: shared text on a
 * catalog's front matter is resolved from the same library row and goes stale in the same archived
 * edition. What belongs on a book root is the value written out, which is then copied with it.
 */
export async function isInBook(
  db: Kysely<Database>,
  contentType: Pick<ContentTypeRow, 'kind' | 'book_root'>,
  parentPath: string | null,
): Promise<boolean> {
  if (typeIsBookRoot(contentType)) return true;
  if (parentPath === null) return false;
  return (await bookRootFor(db, parentPath)) !== undefined;
}

/**
 * Whether putting an item at this parent would nest one book inside another.
 *
 * **Nested books are refused rather than resolved.** Allowing them means answering "which outline
 * does this section belong to" on every read, and every answer is wrong for somebody: the outer
 * book's table of contents either swallows the inner book whole or stops at its root with no way to
 * say why. Refusing removes the question instead of picking a side — the same move `canChangeStatus`
 * makes for `archived → published`, where the transition is refused for an admin too because the
 * problem is the move rather than the mover.
 *
 * Takes the *parent's* path, because `bookRootFor` includes the path it is given: an item is in its
 * own book, so asking about the item itself would refuse every book root that already exists.
 */
export async function wouldNestBook(
  db: Kysely<Database>,
  parentPath: string | null,
): Promise<BookRoot | undefined> {
  if (parentPath === null) return undefined;
  return bookRootFor(db, parentPath);
}

/**
 * The first book root among these item ids, or undefined.
 *
 * The move case `wouldNestBook` alone cannot see: dragging an *ordinary* page into a book nests
 * every book inside **its** subtree, and the item being moved is not a book root itself so the
 * type check never fires. `/staging` holding next year's catalog, moved under a handbook, is the
 * shape — and it would leave two book roots on one ancestor chain with nothing having refused it.
 *
 * Takes ids rather than reading the subtree itself because the one caller already has it: the
 * cascading path move loads the whole subtree in one recursive CTE before computing anything, and
 * a second walk would be a second query for a set already in hand.
 */
export async function bookRootWithin(
  db: Kysely<Database>,
  itemIds: string[],
): Promise<BookRoot | undefined> {
  if (itemIds.length === 0) return undefined;

  const row = await db
    .selectFrom('content_items')
    .innerJoin('content_types', 'content_types.id', 'content_items.content_type_id')
    .select([
      'content_items.id as id',
      'content_items.title as title',
      'content_items.path as path',
      'content_items.content_type_id as contentTypeId',
    ])
    .where('content_items.id', 'in', itemIds)
    .where('content_types.kind', '=', 'page')
    .where('content_types.book_root', '=', 1)
    .executeTakeFirst();

  return row;
}
