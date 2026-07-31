import { RedirectError, deleteRedirect, getRedirectById, updateRedirect } from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json, noContent, readJson } from '../_shared.js';

export const GET = handle(async ({ context, taproot }) => {
  const redirect = await getRedirectById(taproot.db.db, context.params.id!);
  if (!redirect) return apiError(404, 'Redirect not found.');
  return json({ redirect });
});

const patchSchema = z.strictObject(
  {
    fromPath: z.string().min(1).max(2000).optional(),
    toPath: z.string().min(1).max(2000).optional(),
    statusCode: z.union([z.literal(301), z.literal(302)]).optional(),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? { message: `Unknown field(s): ${issue.keys.join(', ')}.` }
        : undefined,
  },
);

export const PATCH = handle(
  async ({ context, taproot }) => {
    const input = await readJson(context.request, patchSchema);
    try {
      const redirect = await updateRedirect(taproot.db.db, context.params.id!, input);
      return json({ redirect });
    } catch (error) {
      if (!(error instanceof RedirectError)) throw error;
      return apiError(
        error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400,
        error.message,
      );
    }
  },
  { role: 'admin' },
);

/**
 * POST carries edits and deletes from the settings screen's forms.
 *
 * Same `_method` shape as the other admin deletes — see `content-types/[id].ts`. There is no typed
 * confirmation here: a redirect holds no content, and re-adding one is a two-field form, so a
 * confirmation step would be friction without a matching risk.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const id = context.params.id!;
    const form = await context.request.formData();

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/settings/redirects?${new URLSearchParams(params)}`, 303);

    const existing = await getRedirectById(taproot.db.db, id);
    if (!existing) return apiError(404, 'Redirect not found.');

    try {
      if (form.get('_method') === 'delete') {
        await deleteRedirect(taproot.db.db, id);
        return back({ deleted: existing.from_path });
      }

      const updated = await updateRedirect(taproot.db.db, id, {
        fromPath: String(form.get('fromPath') ?? existing.from_path),
        toPath: String(form.get('toPath') ?? existing.to_path),
        statusCode: form.get('statusCode') === '302' ? 302 : 301,
      });

      return back({ updated: updated.from_path });
    } catch (error) {
      if (!(error instanceof RedirectError)) throw error;
      return back({ error: error.message });
    }
  },
  { role: 'admin' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    await deleteRedirect(taproot.db.db, context.params.id!);
    return noContent();
  },
  { role: 'admin' },
);
