import { deleteField, fieldInputSchema, updateField } from '@taproot/core';

import { handle, json, noContent, readJson } from '../_shared.js';

// `type` is omitted: changing it would reinterpret every value already stored for the field.
// `updateField` rejects it too; leaving it out of the schema means the API says so clearly.
const patchSchema = fieldInputSchema.omit({ type: true, api_id: true }).partial();

export const PATCH = handle(
  async ({ context, taproot }) => {
    const input = await readJson(context.request, patchSchema);
    const field = await updateField(taproot.db.db, context.params.id!, input);
    return json({ field });
  },
  { role: 'admin' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    await deleteField(taproot.db.db, context.params.id!);
    return noContent();
  },
  { role: 'admin' },
);
