import {
  SITE_TAG,
  bookOutline,
  cacheTagHeader,
  itemTag,
  listContentTypes,
  normalizeCacheTags,
  normalizePath,
  typeTag,
} from '@taprootcms/core';

import { apiError, handleScoped, json } from '../_shared.js';
import { DELIVERY_CACHE_CONTROL } from './cache.js';

/**
 * A book's outline — every section, in the order somebody reads them.
 *
 * The question `resolve` cannot answer. It returns an item's *direct children*, which is enough for
 * "in this section" and useless for a table of contents: a catalog is 188 sections across 13
 * chapters, and building that from `resolve` means one request per node.
 *
 * **A separate endpoint rather than a key on `resolve`, and the reason is the cache.** Folding the
 * outline into `resolve` would put all 188 entries on all 188 cached page responses — the same
 * bytes stored 188 times, re-stored whenever any one page changes. Asked separately it is one
 * cached copy the whole book shares, and a consumer fetches it alongside `resolve` in the same
 * `Promise.all` it already uses for the menu.
 *
 * **Previous/next is not here, deliberately.** It is `bookNavigation` in `@taprootcms/astro`,
 * computed from this array. A server-side answer would need the current path as a cache key, which
 * turns one cached outline per book into one per page — exactly what this endpoint exists to avoid.
 *
 * Entries come back **flat, with `parentId` and `depth`, in reading order**, the shape the taxonomy
 * terms endpoint chose: a sidebar nests it and a prev/next control reads it straight through, where
 * a nested answer would force the second one to flatten somebody else's tree.
 */
export const GET = handleScoped(
  async ({ context, taproot }) => {
    const url = new URL(context.request.url);
    const path = url.searchParams.get('path');
    if (path === null) {
      return apiError(400, 'A `path` query parameter is required.');
    }

    const db = taproot.db.db;
    const outline = await bookOutline(db, normalizePath(path));

    /**
     * 404 for a path that is not a published book root.
     *
     * An empty outline reads as "a book with no sections yet", which is a real and ordinary state —
     * so answering one for a path that is not a book at all, or for a book still in draft, would
     * hide a misspelled address for as long as nobody happened to add a section. Same reasoning the
     * taxonomy terms endpoint gives for refusing an unknown vocabulary.
     */
    if (!outline) return apiError(404, `No book at "${path}".`);

    /**
     * Every type, not only the ones the outline currently holds.
     *
     * The invalidation a book needs is "somebody added a section", and a *new* section can be of a
     * type this outline has never contained — so tagging the types present would leave the very
     * change most worth catching untagged. Exactly the argument `listingCacheTagHeader` makes for a
     * listing that names no type, and the same answer.
     *
     * `item:` for the root as well, because renaming or unpublishing the book itself changes what
     * this endpoint answers without touching any section.
     */
    const types = await listContentTypes(db);
    const tags = normalizeCacheTags([
      SITE_TAG,
      itemTag(outline.root.id),
      ...types.map((contentType) => typeTag(contentType.api_id)),
    ]);

    return json(outline, {
      headers: {
        'cache-control': DELIVERY_CACHE_CONTROL,
        vary: 'authorization',
        'cache-tag': cacheTagHeader(tags) ?? SITE_TAG,
      },
    });
  },
  { scope: 'content:read' },
);
