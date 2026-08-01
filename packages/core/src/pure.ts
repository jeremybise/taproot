/**
 * The parts of core a *consumer* may hold: no database, no storage, no Kysely.
 *
 * `@taproot/astro` is a thin client that talks to a Taproot server over HTTP, and it must not drag
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
export * from './content/menuHrefs.js';
/**
 * The query parameter a preview link travels in.
 *
 * Declared *here* rather than beside the token logic, because this is the only entry both sides of
 * the wire can import: `preview.ts` needs Kysely and a consumer must never see it. The server reads
 * this constant through the main barrel, the client through `/pure`, and there is exactly one
 * string — a second copy is how the two ends stop agreeing on a name.
 */
export const PREVIEW_PARAM = 'taproot_preview';

export type {
  DeliveryField,
  DeliveryItem,
  DeliveryItemRef,
  DeliveryMedia,
  DeliveryMenuItem,
  DeliveryMenuTarget,
  DeliveryResult,
  DeliverySchema,
  DeliveryTermRef,
  DeliveryTypeSchema,
} from './content/delivery.js';

export type { ContentStatus, ContentTypeKind, FieldType } from './db/schema.js';
