/**
 * The kinds a content type can be, in one place.
 *
 * An importless module, exactly like `itemSort.ts` and for the same reason: `schema.ts` needs the
 * type, `validation/fields.ts` needs a Zod enum over it, and a route needs a runtime guard — and
 * `schema.ts` and `validation/fields.ts` already sit on opposite sides of an import graph that must
 * not gain a cycle. Nothing here imports anything, so every one of them can.
 *
 * The list was previously written out at each of those sites. That is survivable for a vocabulary
 * that has not changed since Phase 1 and is still one edit away from a route accepting a kind the
 * database cannot hold.
 */

export const CONTENT_TYPE_KINDS = ['page', 'collection', 'singleton', 'block'] as const;

/**
 * How a content type's instances are addressed.
 *
 * `page` nests under a parent and its identity is its address. `collection` is flat under a
 * `url_prefix`. `singleton` is exactly one item with no create or delete. `block` is not addressed
 * at all — a block type is a content type whose instances live inside another item's `data`, which
 * is why `listContentTypes` excludes them by default.
 */
export type ContentTypeKind = (typeof CONTENT_TYPE_KINDS)[number];

export function isContentTypeKind(value: unknown): value is ContentTypeKind {
  return typeof value === 'string' && (CONTENT_TYPE_KINDS as readonly string[]).includes(value);
}
