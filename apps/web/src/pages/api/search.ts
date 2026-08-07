import { createTaprootSearchHandler } from '@taprootcms/astro';

import { taproot } from '../../taproot.ts';

/**
 * The same-origin search endpoint, for a browser rather than for frontmatter.
 *
 * **This site's own `/search` page does not use it**, and that is worth saying out loud rather than
 * leaving as a puzzle. `/search` is a plain `method="get"` form with no JavaScript, because a
 * results URL that can be linked, bookmarked and reloaded is worth more than a list that updates as
 * you type. This route is here because the *other* choice is legitimate and, made without a handler
 * like this, is made badly: a site wanting a suggestion list reaches for `fetch` against the
 * delivery API, discovers it needs `TAPROOT_API_KEY` in the browser, and ships a `content:read`
 * credential in a script bundle.
 *
 * So the proxy is the thing being demonstrated. `client` is the same server-side client every route
 * here uses, and the key never leaves the Worker.
 *
 * Try it with `curl 'http://localhost:4323/api/search?q=admiss'`.
 *
 * `minLength: 2` because the last token carries FTS5's `*`: a single letter is a prefix match
 * against most of the site, which is correct, useless to read, and the most expensive question the
 * index can be asked. `sort` is left alone so results come back ranked, which is what a suggestion
 * list wants.
 */
export const prerender = false;

export const GET = createTaprootSearchHandler({
  client: taproot,
  limit: 5,
  minLength: 2,
});
