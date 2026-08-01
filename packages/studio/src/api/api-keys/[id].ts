import { getApiKey, recordAuditEntry, revokeApiKey } from '@taprootcms/core';

import { apiError, handle, json } from '../_shared.js';

/**
 * Revoking a key.
 *
 * There is no delete and no update. A key's label and scopes are what it was created with — editing
 * them would change what a credential already in somebody's deployment can do, without that
 * deployment being told, which is worse than making them create a new one. And revocation is not a
 * delete because audit entries name the key by id; removing the row would leave them pointing at
 * nothing.
 *
 * Both verbs are here for the same reason as elsewhere: POST carries the form, since an HTML form
 * can only GET or POST, and DELETE is the JSON caller's route.
 */
export const POST = handle(
  async ({ context, taproot, user }) => {
    const id = context.params.id!;
    const key = await getApiKey(taproot.db.db, id);
    if (!key) return apiError(404, 'API key not found.');

    const form = await context.request.formData();
    if (form.get('_method') !== 'revoke') return apiError(400, 'Unsupported form action.');

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/settings/api-keys?${new URLSearchParams(params)}`, 303);

    /**
     * Confirmed by typing the key's visible prefix, and checked on the server.
     *
     * The prefix is exactly the identifier shown next to it in the list, which is what makes this a
     * confirmation rather than a memory test — and revoking the wrong key takes a live site down
     * until somebody notices.
     */
    if (String(form.get('confirm') ?? '').trim() !== key.token_prefix) {
      return back({ error: `Type ${key.token_prefix} exactly to confirm. Nothing was revoked.` });
    }

    if (key.revoked_at) return back({ error: 'That key was already revoked.' });

    await revokeApiKey(taproot.db.db, id);

    await recordAuditEntry(taproot.db.db, {
      action: 'api_key.revoked',
      subjectType: 'api_key',
      subjectId: key.id,
      subjectLabel: key.label,
      actor: user,
      detail: { prefix: key.token_prefix, lastUsedAt: key.last_used_at },
    });

    return back({ revoked: key.label });
  },
  { role: 'admin' },
);

export const DELETE = handle(
  async ({ context, taproot, user }) => {
    const key = await getApiKey(taproot.db.db, context.params.id!);
    if (!key) return apiError(404, 'API key not found.');

    const revoked = await revokeApiKey(taproot.db.db, key.id);

    await recordAuditEntry(taproot.db.db, {
      action: 'api_key.revoked',
      subjectType: 'api_key',
      subjectId: key.id,
      subjectLabel: key.label,
      actor: user,
      detail: { prefix: key.token_prefix, lastUsedAt: key.last_used_at },
    });

    // 200 with the revoked row rather than 204: the caller wants `revoked_at`, and a key that is
    // still listable is not the same outcome as a delete.
    return json({ apiKey: revoked });
  },
  { role: 'admin' },
);
