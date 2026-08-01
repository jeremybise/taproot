import { deliverMenu } from '@taprootcms/core';

import { handleScoped, json } from '../../_shared.js';

/**
 * A menu, with term targets left unresolved.
 *
 * This is the shape SCOPE asked to decide rather than discover. `resolveMenu` takes a `termHref`
 * **callback**, and a function cannot cross an HTTP boundary — so either the endpoint returns
 * unresolved targets and the client builds hrefs, or "Taproot has no opinion about term URLs" stops
 * being true.
 *
 * The first. Which taxonomies deserve public pages depends on the routes a site actually serves,
 * and a review status or an internal owner classifies content perfectly well without wanting one.
 * The consumer applies `applyTermHrefs` with exactly the resolver it would have passed to
 * `resolveMenu`, so the decision stays where it always was.
 *
 * Not conditionally cached. A menu changes when any page in it is published, moved, or renamed —
 * none of which touches the menu's own rows — so there is no version to build a validator from.
 * `s-maxage` bounds the staleness instead, which is what the embedded site already lived with.
 */
export const GET = handleScoped(
  async ({ context, taproot }) => {
    const items = await deliverMenu(taproot.db.db, context.params.apiId!);

    // An absent menu is an empty list, not a 404. A site asking for `footer` before anyone has
    // created one wants to render no footer nav, and a 404 would make that an error to handle.
    return json(
      { items },
      { headers: { 'cache-control': 'public, max-age=0, s-maxage=60', vary: 'authorization' } },
    );
  },
  { scope: 'content:read' },
);
