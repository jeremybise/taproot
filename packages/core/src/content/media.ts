import { sql, type Kysely, type SelectQueryBuilder } from 'kysely';

import type { Database, MediaRow } from '../db/schema.js';

/**
 * Listing and searching the media library.
 *
 * This lives in core rather than in the API route because three callers need the same answer: the
 * REST endpoint the picker fetches from, the library screen, and the server-side seed the picker
 * opens with. Two of those would otherwise hand-roll the same WHERE clause, and a picker whose
 * search disagreed with the grid it filters is worse than no search at all.
 */

export interface MediaFilters {
  /**
   * Specific assets by id, for resolving what a field already references.
   *
   * A picker only ever holds the most recent page of the library, so an item pointing at an older
   * asset would otherwise have nothing to render its thumbnail from. An empty array matches
   * nothing, which is the honest reading of "these ids" — `undefined` is what means "no filter".
   */
  ids?: string[];
  /** Matches filename or alt text. */
  search?: string;
  /**
   * MIME prefixes to include, e.g. `['image/', 'application/pdf']`. Empty means everything.
   *
   * Prefixes rather than exact types because that is what a `media` field's config stores — an
   * editor picks "Images", not a list of the eleven image MIME types a browser might send.
   */
  accept?: string[];
  /**
   * Images nobody has described and nobody has marked decorative.
   *
   * `alt_text is null` and **not** `= ''`, which is the whole three-state rule in one predicate:
   * null is "nobody has said", `''` is "somebody decided it carries no information", and only the
   * first is an open question. Asking `!alt_text` here would drag every divider and icon back into
   * a list an editor has already finished with — the same mistake `needsAltText` exists to stop
   * call sites making.
   *
   * Narrowed to `image/` because alt text is a question about images; a PDF has no such attribute.
   *
   * It lives here, in the shared predicate, because two screens ask it — the accessibility report's
   * count and the bulk describe grid — and a grid that disagreed with the number that sent somebody
   * to it is the faceted-count bug one feature along.
   */
  undescribed?: boolean;
}

export interface ListMediaOptions extends MediaFilters {
  limit?: number;
  offset?: number;
}

/**
 * `total` is the count *before* the limit, so a picker can say "showing 50 of 300" rather than
 * leaving the editor to guess whether scrolling would reveal more.
 */
export async function listMedia(
  db: Kysely<Database>,
  options: ListMediaOptions = {},
): Promise<{ media: MediaRow[]; total: number }> {
  const query = applyMediaFilters(db.selectFrom('media'), options);

  const totalRow = await query
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirst();

  const media = await query
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0)
    .execute();

  return { media, total: Number(totalRow?.count ?? 0) };
}

type MediaQuery = SelectQueryBuilder<Database, 'media', {}>;

function applyMediaFilters(query: MediaQuery, filters: MediaFilters): MediaQuery {
  let q = query;

  if (filters.ids !== undefined) {
    // `in ()` is a syntax error rather than an empty result, so an empty list becomes an explicit
    // contradiction. Falling through to "no filter" would turn "resolve these none" into "return
    // the whole library", which is the wrong way for this to fail.
    q = filters.ids.length > 0 ? q.where('id', 'in', filters.ids) : q.where(sql<boolean>`1 = 0`);
  }

  if (filters.search) {
    /**
     * Lowercased on both sides rather than relying on the collation. SQLite's LIKE is
     * case-insensitive for ASCII only, so an unqualified LIKE finds `RÉSUMÉ.pdf` for `résumé` on
     * neither side of the accent — being explicit keeps the rule one an editor can predict rather
     * than one the collation happens to give. Same approach as the content-item search.
     *
     * `%` and `_` in the needle are left as wildcards. Filenames do contain underscores, so this
     * over-matches slightly — but over-matching a search box still shows the file the editor was
     * looking for, and an ESCAPE clause is a third dialect-specific behaviour to keep in step.
     */
    const needle = `%${filters.search.toLowerCase()}%`;
    q = q.where((eb) =>
      eb.or([
        eb(sql`lower(filename)`, 'like', needle),
        eb(sql`lower(coalesce(alt_text, ''))`, 'like', needle),
      ]),
    );
  }

  const accept = (filters.accept ?? []).filter((prefix) => prefix.trim() !== '');
  if (accept.length > 0) {
    q = q.where((eb) => eb.or(accept.map((prefix) => eb('mime_type', 'like', `${prefix}%`))));
  }

  if (filters.undescribed) {
    q = q.where('alt_text', 'is', null).where('mime_type', 'like', 'image/%');
  }

  return q;
}

/**
 * The same query the library screen runs, exposed so the accessibility report cannot drift from it.
 *
 * Exported rather than left private because `undescribedImages` builds its own `selectFrom('media')`
 * to keep its select list to three columns, and the alternative to sharing this was spelling
 * `alt_text is null and mime_type like 'image/%'` in two files — which is exactly the pairing that
 * makes a count and the grid it links to disagree.
 */
export { applyMediaFilters };

/**
 * Whether an asset's MIME type satisfies a field's accept list.
 *
 * Exported so the client can filter an already-loaded page of assets without a round trip, using
 * exactly the rule the query uses. An empty list accepts everything, which is what the field
 * builder's "leave all unchecked" means.
 */
export function mediaMatchesAccept(mimeType: string, accept: string[] | undefined): boolean {
  const prefixes = (accept ?? []).filter((prefix) => prefix.trim() !== '');
  return prefixes.length === 0 || prefixes.some((prefix) => mimeType.startsWith(prefix));
}

/**
 * What deleting this asset would break.
 *
 * All warnings, no blockers, and that asymmetry with content items is deliberate. A missing image
 * degrades in place — the alt text still describes it, the layout still holds, the page still
 * serves — whereas an item deleted out from under its own children leaves the tree describing a
 * shape it no longer has. Refusing to delete an image because some page uses it would make the
 * library impossible to tidy, since the useful assets are exactly the used ones.
 *
 * `default_og_image_id` is checked because it is inherited rather than copied: clearing it changes
 * the social card of every item that never set its own, which is a bigger blast radius than the
 * one page an editor is looking at.
 */
export async function mediaDeleteImpact(
  db: Kysely<Database>,
  mediaId: string,
): Promise<{ blockers: string[]; warnings: string[] }> {
  const warnings: string[] = [];

  const types = await db
    .selectFrom('content_types')
    .select('name')
    .where('default_og_image_id', '=', mediaId)
    .execute();

  if (types.length > 0) {
    warnings.push(
      `It is the default social image for ${types.map((type) => type.name).join(', ')}. ` +
        'Every item of those types that has not set its own loses its social card.',
    );
  }

  /**
   * A `LIKE` over `data`, the same prefilter `countBlockUsage` uses.
   *
   * A media field stores a bare id, and so does the SEO panel's `ogImageId`, so there is no key
   * shape to match on the way a block envelope has one. Over-reporting here costs a warning that
   * names one page too many; under-reporting would silently break a page.
   */
  const usedIn = await db
    .selectFrom('content_items')
    .select(['title', 'path'])
    .where((eb) =>
      eb.or([eb('data', 'like', `%${mediaId}%`), eb('seo', 'like', `%${mediaId}%`)]),
    )
    .orderBy('path')
    .limit(20)
    .execute();

  if (usedIn.length > 0) {
    const titles = usedIn
      .slice(0, 5)
      .map((row) => row.title)
      .join(', ');
    const more = usedIn.length > 5 ? `, and ${usedIn.length - 5} more` : '';
    warnings.push(`${usedIn.length} content item(s) use it: ${titles}${more}.`);
  }

  return { blockers: [], warnings };
}
