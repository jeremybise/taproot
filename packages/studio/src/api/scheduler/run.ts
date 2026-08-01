import type { APIContext } from 'astro';
import { publishDueItems, publishDueReleases } from '@taproot/core';

import { apiError, json } from '../_shared.js';
import { getTaproot, hasRole } from '../../runtime/guards.js';

/**
 * Publish everything whose scheduled time has come.
 *
 * Two ways in, because the two callers are nothing alike:
 *
 *  - **A scheduler**, holding `TAPROOT_CRON_SECRET` in an `authorization: Bearer` header. It has no
 *    session and cannot get one; a shared secret is the whole of its identity.
 *  - **An admin**, from the content list, to run it by hand.
 *
 * Not `handle()`, because that requires a signed-in user and the primary caller is a machine. The
 * authorisation is therefore written out here rather than inherited, which is worth being explicit
 * about: this endpoint publishes content, so getting its gate wrong publishes drafts.
 *
 * Idempotent. Running it twice publishes nothing the second time — `publishDueItems` updates
 * conditionally on the status still being `scheduled` — so a scheduler that retries on timeout
 * cannot double-publish or double-log.
 */
export async function POST(context: APIContext): Promise<Response> {
  const taproot = getTaproot(context.locals);

  const secret = process.env.TAPROOT_CRON_SECRET;
  const presented = context.request.headers.get('authorization');

  /**
   * Compared only when a secret is configured, and never by a prefix.
   *
   * With no secret set, this falls through to the session check — which is what keeps `npm run dev`
   * working with no configuration, without ever making an unset variable *grant* anything.
   */
  const authorisedBySecret =
    Boolean(secret) && presented === `Bearer ${secret}`;

  if (!authorisedBySecret && !hasRole(taproot.user, 'admin')) {
    return apiError(401, 'This endpoint needs the scheduler secret or an admin session.');
  }

  const result = await publishDueItems(taproot.db.db);
  /**
   * Items first, then releases. A release publishes through `updateItem`, which clears
   * `publish_at`, so a page that is both scheduled on its own and staged in a release would lose
   * its own moment if the release ran first.
   */
  const releases = await publishDueReleases(taproot.db);

  /**
   * A form post comes from the admin's "Run now" button and wants a screen back.
   *
   * A scheduler wants the count, which is what makes a failed run visible in its logs rather than
   * a silent 200.
   */
  if ((context.request.headers.get('content-type') ?? '').includes('form')) {
    const params = new URLSearchParams({ published: String(result.published.length) });
    if (releases.published.length > 0) {
      params.set('releases', String(releases.published.length));
    }
    // A blocked release is the one outcome of a sweep that needs somebody to do something, so it
    // travels back to the screen rather than only into the audit log.
    if (releases.blocked.length > 0) {
      params.set('blocked', releases.blocked.map((release) => release.name).join(', '));
    }
    return context.redirect(`/admin/content?${params}`, 303);
  }

  return json({
    published: result.published,
    count: result.published.length,
    releases: {
      published: releases.published,
      blocked: releases.blocked.map(({ id, name }) => ({ id, name })),
    },
  });
}
