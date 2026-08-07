import { createTaprootSearchLogHandler } from '@taprootcms/astro';

import { taproot } from '../../taproot.ts';

/**
 * Where the browser reports a search, for the CMS's Settings → Search report.
 *
 * Same reason `api/search.ts` beside it exists: the API key must not reach the browser, so the page
 * talks to this origin and the Worker forwards it with the key.
 *
 * **Why the browser reports it at all**, rather than the server logging what it answered: every
 * layer is cached. `/delivery/search` carries a day-long `s-maxage` and this site's own `/search`
 * page is cached too, so the second person to search a term is served from an edge cache and no
 * origin ever hears about it. A log fed by request counting would rank the terms nobody repeats as
 * the most popular. Reporting from the page is what makes the count real.
 *
 * It also carries intent. A type-ahead fires per settled keystroke, and only the page knows whether
 * one was somebody committing (`page`), picking a suggestion (`suggest`), or giving up
 * (`abandoned`).
 */
export const prerender = false;

export const POST = createTaprootSearchLogHandler({ client: taproot });
