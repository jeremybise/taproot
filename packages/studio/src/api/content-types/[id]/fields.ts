import { createField, fieldInputSchema, listFields, reorderFields } from '@taproot/core';
import { z } from 'zod';

import { handle, json, noContent, readJson } from '../../_shared.js';

export const GET = handle(async ({ context, taproot }) => {
  return json({ fields: await listFields(taproot.db.db, context.params.id!) });
});

export const POST = handle(
  async ({ context, taproot }) => {
    const input = await readJson(context.request, fieldInputSchema);
    const field = await createField(taproot.db.db, context.params.id!, input);
    return json({ field }, { status: 201 });
  },
  { role: 'admin' },
);

const reorderSchema = z.object({ fieldIds: z.array(z.string()).min(1) });

/** Persist a new field order after a drag-and-drop reorder in the builder. */
export const PATCH = handle(
  async ({ context, taproot }) => {
    const { fieldIds } = await readJson(context.request, reorderSchema);
    await reorderFields(taproot.db.db, context.params.id!, fieldIds);
    return noContent();
  },
  { role: 'admin' },
);
