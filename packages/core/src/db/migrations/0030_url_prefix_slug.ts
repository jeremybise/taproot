import type { Kysely } from 'kysely';

/**
 * Repair `content_types.url_prefix` values that Taproot itself generated and then refused.
 *
 * `createContentType` filled an absent `url_prefix` from the type's `api_id`. The two accept
 * **disjoint character sets**: an `api_id` matches `^[a-z][a-z0-9_]*$`, separating words with `_`
 * and forbidding `-`, while `url_prefix` is validated with `isValidSlug`'s
 * `^[a-z0-9]+(?:-[a-z0-9]+)*$`, which is the exact inverse. So every collection created with a
 * multi-word name and a blank URL prefix stored a value `contentTypeInputSchema` rejects.
 *
 * The consequence was not a bad URL — those paths resolve fine, because `normalizePath` has no
 * opinion about underscores and an item's `path` is stored rather than rebuilt. It was that the
 * **content type settings screen could never be submitted again**, for any change at all: the form
 * round-trips every field, so unticking "Items have their own pages" failed on a URL prefix input
 * nobody had touched, with the browser's opaque "please match the requested format". That is the
 * "never leave a deployment in a state its own UI cannot reach" rule reached from the one direction
 * care at the input cannot cover — the invalid value was machine-written.
 *
 * ## The transform is frozen here rather than importing `slugify`
 *
 * A migration must mean the same thing on the day it is written and three years later; importing a
 * function that is free to change would let a deployment that has not migrated yet get a different
 * result from one that has. The rule is inlined below and is narrower than `slugify` on purpose,
 * because the input is narrow: the only values reachable are `api_id`s, whose sole illegal
 * character is `_`. Runs are collapsed and edges trimmed anyway, since `alum__profile` and `alum_`
 * are both legal `api_id`s whose naive replacement (`alum--profile`, `alum-`) is still invalid.
 *
 * ## Existing item paths are deliberately not rewritten
 *
 * `url_prefix` decides where an item's path is built at **creation**; `buildCollectionPath` is not
 * consulted again, and a stored `path` is what the catch-all resolves. So items already at
 * `/alum_profile/jane-doe` keep working and keep their URLs, while items created after this land
 * under `/alum-profile/`. That divergence is real and is the lesser of the two costs — rewriting
 * them means the cascading path move plus its redirects, which is `updateItem`'s job and not
 * something a raw migration can reach. A deployment wanting them consistent re-slugs the items,
 * which is what bulk operations are for.
 *
 * Rows already valid are left alone, so this is a no-op on every deployment that named its prefixes
 * by hand.
 */

/** `^[a-z0-9]+(?:-[a-z0-9]+)*$` — `isValidSlug`'s rule, copied so this migration cannot drift. */
const VALID_PREFIX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The frozen repair. Anything outside `[a-z0-9]` becomes a separator, runs collapse, edges are
 * trimmed — so `alum_profile`, `alum__profile` and `alum_` all land on something `isValidSlug`
 * accepts, or on an empty string when there was nothing usable in the value at all.
 */
function repairPrefix(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function up(db: Kysely<any>): Promise<void> {
  const rows = await db
    .selectFrom('content_types')
    .select(['id', 'url_prefix'])
    .where('url_prefix', 'is not', null)
    .execute();

  for (const row of rows) {
    const current = String(row.url_prefix ?? '');
    if (VALID_PREFIX.test(current)) continue;

    const repaired = repairPrefix(current);

    /*
     * An unrepairable value becomes null rather than an empty string, which is what a collection
     * with no prefix already means — `buildCollectionPath` reads it as "items sit at the root" and
     * the column is nullable for exactly that. `''` would be a third state that passes neither the
     * validator nor the null check.
     */
    await db
      .updateTable('content_types')
      .set({ url_prefix: repaired || null })
      .where('id', '=', row.id)
      .execute();
  }
}

/**
 * Irreversible, and saying so is the honest answer.
 *
 * The original spelling is not recoverable: `alum-profile` could have come from `alum_profile` or
 * have been typed that way, and re-underscoring every prefix would corrupt the ones that were
 * always correct. Nothing downstream depends on the old value — an item's path is stored, so a
 * revert changes only where *new* items would be created.
 */
export async function down(): Promise<void> {
  // Intentionally empty. See above.
}
