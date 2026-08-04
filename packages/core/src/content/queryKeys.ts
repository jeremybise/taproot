/**
 * How a query field's answer is addressed.
 *
 * Its own module, importing nothing, so it can be re-exported from `@taprootcms/core/pure` and
 * reach a consumer's templates. `itemQueries.ts` holds the resolver and pulls in Kysely, which must
 * never reach a site's bundle — the same split `menuHrefs.ts` exists for.
 *
 * **Composite because a field alone is not an address.** A `query` field can sit on a block type,
 * and the same block type placed twice on one page is two listings with two different rules and two
 * different answers. The field's `api_id` is identical in both, so keying by it would collapse them
 * and one placement would render the other's results.
 *
 * `containerId` is whatever holds the field: the content item's `id` for a top-level query field,
 * and the block instance's `id` for one inside a block. A consumer always has it — `BlockRenderer`
 * passes each block its own envelope, and a page's own id is on `item`.
 */
export function queryKey(containerId: string, fieldApiId: string): string {
  return `${containerId}:${fieldApiId}`;
}
