import {
  contentTypeInputSchema,
  deleteContentType,
  getContentType,
  updateContentType,
} from '@taproot/core';

import { apiError, handle, json, noContent, readJson } from '../_shared.js';

export const GET = handle(async ({ context, taproot }) => {
  const contentType = await getContentType(taproot.db.db, context.params.id!);
  if (!contentType) return apiError(404, 'Content type not found.');
  return json({ contentType });
});

// `api_id` is omitted: it is the stable machine name that code and integrations reference, so it
// is fixed at creation. The display name is what authors rename.
const patchSchema = contentTypeInputSchema.omit({ api_id: true }).partial();

export const PATCH = handle(
  async ({ context, taproot }) => {
    const input = await readJson(context.request, patchSchema);
    const contentType = await updateContentType(taproot.db.db, context.params.id!, input);
    return json({ contentType });
  },
  { role: 'admin' },
);

/**
 * POST carries the delete, because an HTML form can only GET or POST.
 *
 * `_method=delete` keeps the settings screen's delete working without JavaScript, the same reason
 * the admin is server-rendered at all — and it puts the typed confirmation on the server, where a
 * disabled submit button would have been bypassed by turning JavaScript off.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const id = context.params.id!;
    const contentType = await getContentType(taproot.db.db, id);
    if (!contentType) return apiError(404, 'Content type not found.');

    const form = await context.request.formData();
    if (form.get('_method') !== 'delete') return apiError(400, 'Unsupported form action.');

    // Block types are managed on their own screen, so a refusal has to go back to the one the
    // form was submitted from rather than to whichever list sorts first.
    const section = contentType.kind === 'block' ? 'blocks' : 'types';
    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/settings/${section}/${id}?${new URLSearchParams(params)}`, 303);

    if (String(form.get('confirm') ?? '').trim() !== contentType.api_id) {
      return back({ error: `Type ${contentType.api_id} exactly to confirm. Nothing was deleted.` });
    }

    try {
      await deleteContentType(taproot.db.db, id);
    } catch (error) {
      return back({
        error: error instanceof Error ? error.message : 'Could not delete that type.',
      });
    }

    return context.redirect(
      `/admin/settings/${section}?${new URLSearchParams({ deleted: contentType.name })}`,
      303,
    );
  },
  { role: 'admin' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    await deleteContentType(taproot.db.db, context.params.id!);
    return noContent();
  },
  { role: 'admin' },
);
