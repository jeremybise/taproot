import {
  contentTypeInputSchema,
  createContentType,
  listContentTypes,
} from '@taprootcms/core';

import { handle, json, readJson } from '../_shared.js';

export const GET = handle(async ({ taproot }) => {
  return json({ contentTypes: await listContentTypes(taproot.db.db) });
});

export const POST = handle(
  async ({ context, taproot }) => {
    const input = await readJson(context.request, contentTypeInputSchema);
    const contentType = await createContentType(taproot.db.db, input);
    return json({ contentType }, { status: 201 });
  },
  { role: 'admin' },
);
