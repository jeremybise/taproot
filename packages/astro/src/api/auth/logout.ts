import type { APIContext } from 'astro';
import { buildSessionClearCookie, invalidateSession } from '@taproot/core';

import { mapError } from '../_shared.js';
import { getTaproot } from '../../runtime/guards.js';

/** Sign out: destroy the server-side session, then clear the cookie. */
export async function POST(context: APIContext): Promise<Response> {
  try {
    const taproot = getTaproot(context.locals);

    if (taproot.sessionToken) {
      await invalidateSession(taproot.db.db, taproot.sessionToken);
    }

    const response = context.redirect('/admin/login', 303);
    response.headers.append(
      'set-cookie',
      buildSessionClearCookie({ secure: taproot.auth.secureCookies }),
    );
    return response;
  } catch (error) {
    return mapError(error);
  }
}
