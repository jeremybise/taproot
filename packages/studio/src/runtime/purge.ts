/**
 * Cache purging for the tags a request invalidated.
 *
 * Its own module rather than a helper inside `middleware.ts` so it can be tested: the middleware
 * imports `astro:middleware`, which does not resolve outside an Astro build, and this is the half
 * that has already been wrong in production once.
 */

/** The slice of `ExecutionContext` this needs, named structurally so no adapter type is imported. */
interface CachePurger {
  purge?: (options: { tags: string[] }) => Promise<unknown>;
}

/**
 * Clear cached responses carrying any of these tags.
 *
 * **Never throws, and never fails the request** — the same rule `recordAuditEntry` follows, and for
 * the same reason: the write this describes has already happened and already been reported as
 * successful. Turning a cache-maintenance problem into a 500 would tell an editor their save failed
 * when it did not, and they would do it again. A purge that does not land costs staleness bounded by
 * `s-maxage`, which is exactly the behaviour every deployment had before tags existed.
 *
 * **The accessor is `locals.cfContext`, and reading the old one *throws*.** This shipped as
 * `locals.runtime?.ctx?.cache`, which Astro v6 removed — and the adapter did not delete the
 * property, it replaced it with a getter that throws a message telling you the new name
 * (`@astrojs/cloudflare/dist/utils/cf-helpers.js`). Optional chaining is no defence: `runtime`
 * exists, so `?.ctx` invokes the getter. The effect was invisible on every read and total on every
 * write, because this runs only when something was invalidated: every editor save 500'd *after*
 * `next()` had already committed the row, so the admin reported a failure that had in fact
 * succeeded — the precise outcome the paragraph above exists to prevent.
 *
 * **Hence the whole read sits inside the `try`.** Before, only `purge()` did, so the promise made
 * above covered the call and not the lookup that reaches it. "Never throws" is a claim about the
 * request, not about one line — an accessor is as able to throw as a method, and this one did.
 *
 * `cache` is optional on `ExecutionContext` and absent under `npm run dev`, where there is no
 * Cloudflare cache to purge. That is correct rather than degraded: nothing cached the response
 * either.
 */
export async function purgeInvalidated(locals: unknown, tags: Set<string>): Promise<void> {
  if (tags.size === 0) return;

  try {
    const cache = (locals as { cfContext?: { cache?: CachePurger } }).cfContext?.cache;
    if (!cache?.purge) return;

    await cache.purge({ tags: [...tags] });
  } catch (error) {
    console.error('[taproot] failed to purge cache tags', error);
  }
}
