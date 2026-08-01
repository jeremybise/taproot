import {
  API_KEY_SCOPES,
  createApiKey,
  listApiKeys,
  recordAuditEntry,
  type ApiKeyScope,
} from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, readJson } from '../_shared.js';
import { revealCookie } from './revealCookie.js';

/**
 * API keys.
 *
 * Admin-only in both directions. Creating one hands out read access to every published item on the
 * site, and listing them names what integrations exist — which is the sort of inventory worth
 * keeping to the people who administer the place.
 *
 * The list never contains a token. There is nowhere to read one from: `id` is the hash, and the
 * raw value existed only in the response that created it.
 */
export const GET = handle(
  async ({ taproot }) => json({ apiKeys: await listApiKeys(taproot.db.db) }),
  { role: 'admin' },
);

const createSchema = z.strictObject(
  {
    label: z.string().min(1).max(200),
    scopes: z.array(z.enum(API_KEY_SCOPES as unknown as [ApiKeyScope, ...ApiKeyScope[]])).min(1),
    expiresAt: z.string().datetime().nullish(),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? { message: `Unknown field(s): ${issue.keys.join(', ')}.` }
        : undefined,
  },
);

export const POST = handle(
  async ({ context, taproot, user }) => {
    const isForm = (context.request.headers.get('content-type') ?? '').includes('form');

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/settings/api-keys?${new URLSearchParams(params)}`, 303);

    let input: z.infer<typeof createSchema>;

    if (isForm) {
      const form = await context.request.formData();
      const label = String(form.get('label') ?? '').trim();
      if (!label) return back({ error: 'A key needs a label, so you can tell it from the others.' });

      const expires = String(form.get('expiresAt') ?? '').trim();
      let expiresAt: string | null = null;
      if (expires) {
        const moment = new Date(expires);
        if (Number.isNaN(moment.getTime())) {
          return back({ error: 'That is not a date Taproot could read.' });
        }
        expiresAt = moment.toISOString();
      }

      // Scopes come from checkboxes. `getAll` rather than `get`, or a key with several scopes
      // would silently be created with one.
      const scopes = form.getAll('scopes').map(String) as ApiKeyScope[];
      const unknown = scopes.filter((scope) => !API_KEY_SCOPES.includes(scope));
      if (scopes.length === 0 || unknown.length > 0) {
        return back({ error: 'Choose at least one scope.' });
      }

      input = { label, scopes, expiresAt };
    } else {
      input = await readJson(context.request, createSchema);
    }

    const { key, token } = await createApiKey(taproot.db.db, {
      label: input.label,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      userId: user.id,
    });

    await recordAuditEntry(taproot.db.db, {
      action: 'api_key.created',
      subjectType: 'api_key',
      subjectId: key.id,
      subjectLabel: key.label,
      actor: user,
      detail: { scopes: key.scopes, prefix: key.token_prefix, expiresAt: key.expires_at },
    });

    if (isForm) {
      /**
       * The token travels back in a short-lived, HttpOnly cookie rather than the query string.
       *
       * A URL lands in history, in `Referer`, and in access logs, and this one carries a live
       * credential. The screen reads the cookie once and clears it in the same response.
       */
      const response = context.redirect('/admin/settings/api-keys?created=1', 303);
      response.headers.append(
        'set-cookie',
        revealCookie({ label: key.label, token }, { secure: taproot.auth.secureCookies }),
      );
      return response;
    }

    // The one and only time the token is returned. Nothing stores it; there is no read-back.
    return json({ apiKey: key, token }, { status: 201 });
  },
  { role: 'admin' },
);
