/**
 * The parts of core a *consumer* may hold: no database, no storage, no Kysely.
 *
 * `@taprootcms/astro` is a thin client that talks to a Taproot server over HTTP, and it must not drag
 * the data layer into a site's bundle. Importing from the main entry would: the barrel re-exports
 * `db/index.js`, which pulls Kysely and the dialect loaders, none of which a consumer can use and
 * all of which it would ship.
 *
 * Two kinds of thing are safe to share, and this file is exactly those:
 *
 *  - **Pure functions with no imports at all.** `imageCrop` is the whole of it today — resolving a
 *    stored hotspot and crop into a rectangle is arithmetic, and the alternative to sharing it is a
 *    second copy that drifts from the one the admin's preview uses. A preview that disagreed with
 *    the rendered page is precisely the bug `TaprootImage` was written to fix.
 *  - **Types.** `export type` is erased at build, so the delivery response shapes cost a consumer
 *    nothing at runtime while keeping one definition for both sides of the wire. Two hand-kept
 *    copies of a wire format is how a client and a server stop agreeing.
 *
 * Nothing with a database import may be added here. The check is not subtle: if it needs `Kysely`,
 * it belongs in the main entry.
 */

export * from './content/imageCrop.js';

/**
 * `imageVariants` — the `?w=` / `?f=` vocabulary the media route answers and a consumer builds
 * `srcset` from. Shared for the reason `cacheTags` is: a spelling that differs between the two
 * sides fails silently, serving every visitor the full-size original while every test passes.
 */
export * from './content/imageVariants.js';
export * from './content/menuHrefs.js';
/**
 * `queryKey` — how a consumer finds a listing's results in the response's `queries` map.
 *
 * Its own module for the same reason `menuHrefs` is one: the resolver beside it needs Kysely, and a
 * consumer that imported that would drag the whole data layer into its bundle. One implementation
 * of the key on both sides, because a mismatched key fails by returning `undefined` — a listing that
 * renders nothing and reports nothing.
 */
export * from './content/queryKeys.js';
/**
 * The cache-tag vocabulary, shared by the two caches that use it.
 *
 * The studio tags its cached delivery JSON; a consumer tags the HTML it renders from that JSON, and
 * mounts a purge endpoint the CMS calls. Both have to spell a tag identically or the purge succeeds,
 * reports success, and clears nothing — a failure with no symptom until somebody notices the site
 * showing last week's front page. Importless, so it costs a consumer's bundle nothing.
 */
export * from './content/cacheTags.js';
export type { ItemSort } from './content/itemSort.js';
/**
 * The query parameter a preview link travels in.
 *
 * Declared *here* rather than beside the token logic, because this is the only entry both sides of
 * the wire can import: `preview.ts` needs Kysely and a consumer must never see it. The server reads
 * this constant through the main barrel, the client through `/pure`, and there is exactly one
 * string — a second copy is how the two ends stop agreeing on a name.
 */
export const PREVIEW_PARAM = 'taproot_preview';

/**
 * The postMessage vocabulary the split-view preview pane and the consumer's bridge share.
 *
 * Here for the same reason `PREVIEW_PARAM` is: the pane reads it through the main barrel and the
 * bridge through `/pure`, so there is exactly one spelling of each name. Two hand-kept copies is how
 * a handshake starts failing silently in one direction — and silently is the only way it can fail,
 * because the pane's fallback is to reload the frame anyway.
 *
 * The child never posts to `'*'`. It learns the CMS's origin from `event.origin` of the hello, which
 * is why nothing here needs configuring and why a hostile framer gets no reply.
 */
export const PREVIEW_MESSAGE = {
  /** CMS → site, once the frame has loaded. */
  hello: 'taproot:preview:hello',
  /** Site → CMS, answering a hello. Its arrival is what tells the pane a bridge is present. */
  ready: 'taproot:preview:ready',
  /** CMS → site. Reloading from *inside* the frame is what keeps the scroll position. */
  refresh: 'taproot:preview:refresh',
} as const;

export type {
  DeliveryField,
  DeliveryItem,
  DeliveryItemRef,
  DeliveryList,
  DeliveryListItem,
  DeliveryMedia,
  DeliveryMenuItem,
  DeliveryMenuTarget,
  DeliveryResult,
  DeliverySchema,
  DeliveryTaxonomy,
  DeliveryTaxonomySummary,
  DeliveryTaxonomyTerm,
  DeliveryTermRef,
  DeliveryTypeSchema,
} from './content/delivery.js';

export type { DeliveryQueryResult } from './content/itemQueries.js';

export type { ContentStatus, ContentTypeKind, FieldType } from './db/schema.js';
