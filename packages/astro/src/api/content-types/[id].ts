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

export const DELETE = handle(
  async ({ context, taproot }) => {
    await deleteContentType(taproot.db.db, context.params.id!);
    return noContent();
  },
  { role: 'admin' },
);
