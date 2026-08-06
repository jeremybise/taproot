import { createTaprootPurgeHandler } from '@taprootcms/astro';

/**
 * The endpoint that lets the CMS clear this site's cached HTML.
 *
 * **Cloudflare scopes cache purging to the Worker that owns the cache.** The CMS purges its own
 * cached delivery JSON when content changes and physically cannot reach the HTML rendered from it,
 * so without this route a published page reaches visitors only when this site's own `s-maxage`
 * lapses — which is the whole day the caching design is built around, not a minute.
 *
 * A file in the site's own `src/pages` rather than a route injected by an integration, because
 * `@taprootcms/astro` is a plain library: the site owns the path, the runtime, and where the secret
 * comes from. Mounting it elsewhere is fine — `TAPROOT_SITE_PURGE_URL` on the CMS is a full URL —
 * and `PURGE_PATH` is only the convention the docs and the scaffolder agree on.
 *
 * **Unset `TAPROOT_PURGE_SECRET` answers 404**, so a site that has not configured this looks like a
 * site with no such route rather than one guarding something worth guessing at. That also keeps
 * `npm run dev` working untouched.
 */
export const prerender = false;

export const POST = createTaprootPurgeHandler({
  secret: import.meta.env.TAPROOT_PURGE_SECRET ?? process.env.TAPROOT_PURGE_SECRET,
});
