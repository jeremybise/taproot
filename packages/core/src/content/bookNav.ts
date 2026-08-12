/**
 * Where you are in a book, and where previous and next go.
 *
 * **Importless, and that is load-bearing.** `pure.ts` re-exports it so `@taprootcms/astro` can call
 * it in a site's own layout, and nothing with a database import may reach that file — the built
 * consumer is ~460K against the studio's 12M precisely because Kysely never gets in. Same reason
 * `queryKey`, `searchTokens` and `cacheTags` live in modules of their own.
 *
 * **Previous and next cost no query, and that is the whole design.** Materialising a reading-order
 * integer per item was the obvious alternative, and it renumbers every section after the one
 * somebody inserts — a cascading write over the whole book on an ordinary save. It is unnecessary:
 * a book page renders a table of contents, so the outline is already in the caller's hands, and
 * navigation is arithmetic over an array it has anyway.
 */

/** The shape this works over — `BookOutlineEntry` minus everything navigation does not read. */
export interface BookNavEntry {
  title: string;
  path: string;
  depth: number;
  typeApiId: string;
}

export interface BookNavOptions {
  /**
   * Content types that take part in navigation. Every type, when omitted.
   *
   * **This is the consumer's decision and deliberately not Taproot's.** A catalog keeps its 91
   * programs of study inside the book — real content, indexed, rolled forward with the edition — and
   * nobody wants previous/next to page through them one at a time. Which branches deserve
   * navigation depends on the routes a site actually serves, so the CMS would be asserting something
   * it cannot know. Same split as `resolveMenu`'s `termHref` callback.
   */
  only?: readonly string[];
  /** Content types to leave out, applied after `only`. The same decision from the other side. */
  exclude?: readonly string[];
}

export interface BookNavigation<T extends BookNavEntry = BookNavEntry> {
  /** The entry for `currentPath`, or null when the path is not in this book. */
  current: T | null;
  previous: T | null;
  next: T | null;
  /**
   * The nearest navigable ancestor, or null at the top level.
   *
   * Derived from `depth` walking backwards rather than from `parentId`, because the *navigable*
   * parent is not always the real one: hide a branch with `exclude` and the section beneath it
   * should point up at the last thing a reader can actually reach, not at a page the site does not
   * render.
   */
  up: T | null;
  /** Ancestors from the top down, for a breadcrumb inside the book. */
  ancestors: T[];
}

/**
 * Previous, next and up for one page of a book.
 *
 * Reading order is the order `bookOutline` returns — depth-first, siblings by `(position, title)` —
 * so this walks the array rather than re-deriving anything. Filtering happens **first**, so
 * previous and next skip a hidden branch entirely instead of landing inside it.
 *
 * A `currentPath` that is not in the outline answers all-null rather than throwing: the book root
 * itself is the ordinary case, since the root is not one of its own sections, and a template asking
 * for navigation there should render none rather than fail.
 */
export function bookNavigation<T extends BookNavEntry>(
  entries: readonly T[],
  currentPath: string,
  options: BookNavOptions = {},
): BookNavigation<T> {
  const { only, exclude } = options;

  const navigable = entries.filter((entry) => {
    if (only && !only.includes(entry.typeApiId)) return false;
    if (exclude && exclude.includes(entry.typeApiId)) return false;
    return true;
  });

  const index = navigable.findIndex((entry) => entry.path === currentPath);
  if (index === -1) return { current: null, previous: null, next: null, up: null, ancestors: [] };

  const current = navigable[index]!;

  /**
   * Ancestors, by walking backwards and taking each entry shallower than the last one taken.
   *
   * **A falling ceiling rather than an exact depth**, and the difference is the whole point of
   * computing this over the *filtered* list: looking for `depth - 1`, then `depth - 2`, works only
   * while every level survives the filter. Hide one intermediate branch and the search for that
   * depth never matches, the walk runs to the start of the book, and a page three levels down
   * reports no ancestors at all. Taking anything shallower than the ceiling skips the gap instead.
   */
  const ancestors: T[] = [];
  let ceiling = current.depth;
  for (let cursor = index - 1; cursor >= 0 && ceiling > 0; cursor -= 1) {
    const entry = navigable[cursor]!;
    if (entry.depth < ceiling) {
      ancestors.unshift(entry);
      ceiling = entry.depth;
    }
  }

  return {
    current,
    previous: navigable[index - 1] ?? null,
    next: navigable[index + 1] ?? null,
    up: ancestors[ancestors.length - 1] ?? null,
    ancestors,
  };
}
