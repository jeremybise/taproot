/**
 * Slug and materialised-path handling.
 *
 * This is the piece most flat-page CMSes skip, so it is worth being explicit about the model:
 *
 * - Every content item stores a denormalised `path` (its ancestors' slugs plus its own), indexed
 *   and unique, so the public catch-all route resolves a request in exactly one lookup.
 * - Slugs are unique **among siblings**, not site-wide. That is what lets `/admissions/apply` and
 *   `/financial-aid/apply` coexist.
 * - Renaming or re-parenting a node must rewrite every descendant's path. That cascade is the
 *   reason this feature usually gets special-cased away; here it is implemented properly, reading
 *   the subtree with one recursive CTE and writing the result as one atomic batch.
 */

export const PATH_SEPARATOR = '/';

/**
 * Convert arbitrary text into a URL-safe slug.
 *
 * Unicode is normalised and stripped of combining marks first, so "Résumé" becomes "resume"
 * rather than being mangled or percent-escaped in the URL.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    // Combining diacritical marks, written as escapes so the source stays readable and cannot be
    // mangled by an editor normalising the file.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Drop apostrophes rather than turning them into separators, so "Dean's Office" becomes
    // "deans-office" and not "dean-s-office".
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
    .replace(/-+$/g, '');
}

/** True when a slug is safe to place in a path. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/**
 * Build a child's path from its parent's path and its own slug.
 *
 * A null parent path yields a root-level path. The result never has a trailing slash, so the
 * stored value and an incoming request path compare directly after normalisation.
 */
export function buildPath(parentPath: string | null, slug: string): string {
  const clean = slug.replace(/^\/+|\/+$/g, '');
  if (!parentPath || parentPath === PATH_SEPARATOR) return `${PATH_SEPARATOR}${clean}`;
  return `${parentPath.replace(/\/+$/, '')}${PATH_SEPARATOR}${clean}`;
}

/**
 * Build the path for a `collection`-kind type, which is flat and type-prefixed
 * (`/events/spring-open-house`) rather than nested under a parent.
 */
export function buildCollectionPath(urlPrefix: string | null, slug: string): string {
  const prefix = (urlPrefix ?? '').replace(/^\/+|\/+$/g, '');
  return prefix ? `${PATH_SEPARATOR}${prefix}${PATH_SEPARATOR}${slug}` : `${PATH_SEPARATOR}${slug}`;
}

/**
 * Normalise an incoming request path for lookup: leading slash, no trailing slash, no duplicate
 * separators. The site root normalises to `/`.
 */
export function normalizePath(path: string): string {
  const collapsed = `/${path}`.replace(/\/+/g, PATH_SEPARATOR).replace(/\/+$/, '');
  return collapsed === '' ? PATH_SEPARATOR : collapsed;
}

/** Depth of a path: 0 for a root-level item. */
export function pathDepth(path: string): number {
  const normalized = normalizePath(path);
  if (normalized === PATH_SEPARATOR) return 0;
  return normalized.split(PATH_SEPARATOR).length - 2;
}

/** Split a path into the ancestor paths leading to it, useful for breadcrumbs. */
export function ancestorPaths(path: string): string[] {
  const segments = normalizePath(path).split(PATH_SEPARATOR).filter(Boolean);
  const out: string[] = [];
  let current = '';
  for (const segment of segments.slice(0, -1)) {
    current += `${PATH_SEPARATOR}${segment}`;
    out.push(current);
  }
  return out;
}

/**
 * The bounds that select every descendant of a path, as a range rather than a prefix match.
 *
 * The predicate is `path > start and path < end`, and it has to be a range because **`like` cannot
 * use the index**. SQLite's LIKE optimisation only fires when the indexed column has `NOCASE`
 * collation or `case_sensitive_like` is on; `content_items_path_unique` is a plain BINARY index and
 * **D1 refuses PRAGMA**, so neither escape is available. Measured on the real index:
 * `like '/catalog/2026-27/%'` plans as `SCAN content_items`, this plans as `SEARCH … USING INDEX`.
 * Same lesson as `0020_perf_indexes` — a query that looks correct is not evidence the scan is gone.
 *
 * `end` is the prefix with its trailing separator replaced by the next codepoint: `/` is 0x2F and
 * `0` is 0x30, so `/catalog/` becomes `/catalog0` and everything under `/catalog/` sorts between
 * them. Nothing else can: a sibling named `/catalog-archive` sorts *below* `/catalog/` because `-`
 * is 0x2D, and `/catalog0` is the first thing above the branch.
 *
 * **Descendants only, never the root itself.** Including it would need an `or`, and this repo has
 * already paid for one: indexing both sides of `purgeStaleResetTokens`' `or` changed its plan by
 * nothing at all and the delete had to be split in two to spend the indexes. Every caller wants
 * descendants anyway — `resolveDelivery` fetches the root separately. `>` rather than `>=` so a
 * book rooted at `/` excludes the home page; no other root can equal its own prefix, which carries
 * a trailing separator no stored path has.
 */
export function descendantPathRange(rootPath: string): { start: string; end: string } {
  const normalized = normalizePath(rootPath);
  const prefix =
    normalized === PATH_SEPARATOR ? PATH_SEPARATOR : `${normalized}${PATH_SEPARATOR}`;

  return { start: prefix, end: `${prefix.slice(0, -1)}0` };
}

export interface SubtreeNode {
  id: string;
  path: string;
  depth: number;
}

export interface PathRewrite {
  id: string;
  oldPath: string;
  newPath: string;
  depth: number;
}

/**
 * Given a subtree and the node's new path, compute every descendant's new path.
 *
 * Pure and synchronous by design: the caller reads the subtree with one recursive CTE, calls this
 * to work out the whole rewrite in memory, then submits the updates as a single atomic batch.
 * That ordering is what makes the operation portable — D1 has no interactive transactions, so
 * "read, then compute, then write once" is the only shape that works everywhere.
 *
 * Throws if a descendant does not actually sit under the root, which would mean the caller passed
 * a mismatched subtree and is about to corrupt paths.
 */
export function computeSubtreeRewrite(
  subtree: SubtreeNode[],
  rootId: string,
  newRootPath: string,
): PathRewrite[] {
  const root = subtree.find((node) => node.id === rootId);
  if (!root) {
    throw new Error(`Subtree does not contain its root node (${rootId}).`);
  }

  const oldRootPath = normalizePath(root.path);
  const normalizedNewRoot = normalizePath(newRootPath);
  const depthShift = pathDepth(normalizedNewRoot) - pathDepth(oldRootPath);

  return subtree.map((node) => {
    const oldPath = normalizePath(node.path);

    if (node.id === rootId) {
      return { id: node.id, oldPath, newPath: normalizedNewRoot, depth: pathDepth(normalizedNewRoot) };
    }

    if (!isDescendantPath(oldPath, oldRootPath)) {
      throw new Error(
        `Node ${node.id} (${oldPath}) is not a descendant of ${oldRootPath}; refusing to rewrite ` +
          `paths from a mismatched subtree.`,
      );
    }

    const suffix = oldPath.slice(oldRootPath.length);
    const newPath = normalizePath(`${normalizedNewRoot}${suffix}`);
    return { id: node.id, oldPath, newPath, depth: node.depth + depthShift };
  });
}

/** True when `candidate` sits strictly below `ancestor` in the tree. */
export function isDescendantPath(candidate: string, ancestor: string): boolean {
  const a = normalizePath(ancestor);
  const c = normalizePath(candidate);
  if (a === PATH_SEPARATOR) return c !== PATH_SEPARATOR;
  return c.startsWith(`${a}${PATH_SEPARATOR}`);
}

/**
 * Guard against re-parenting a node underneath itself.
 *
 * Without this check the subtree read would recurse forever and the node plus everything under it
 * would be detached from the tree entirely.
 */
export function wouldCreateCycle(subtree: SubtreeNode[], newParentId: string | null): boolean {
  if (newParentId === null) return false;
  return subtree.some((node) => node.id === newParentId);
}

/**
 * Pick a slug that does not collide with its siblings, appending `-2`, `-3`, and so on.
 *
 * Used when an author names two sibling pages the same thing — better to disambiguate silently at
 * creation than to reject the save and make them invent a slug by hand.
 */
export function uniqueSlug(desired: string, takenSlugs: Iterable<string>): string {
  const taken = new Set(takenSlugs);
  const base = slugify(desired) || 'item';
  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not find a free slug for "${desired}" after 1000 attempts.`);
}
