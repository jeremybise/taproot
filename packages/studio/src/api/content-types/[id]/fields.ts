import {
  createField,
  fieldInputSchema,
  getContentType,
  listFields,
  reorderFields,
  typeTag,
} from '@taprootcms/core';
import type { Kysely } from 'kysely';
import type { Database } from '@taprootcms/core';
import { z } from 'zod';

import { handle, json, noContent, readJson } from '../../_shared.js';

/**
 * The owning type's tag, which is what a field change invalidates.
 *
 * A field belongs to a content type and every item of that type renders it, so `type:` reaches
 * exactly the cached responses that changed — a reorder moves the fields array in every payload,
 * and a new or deleted field changes its shape. The tag is spelled with `api_id` and the route has
 * an id, hence the lookup; `api_id` is immutable, so it cannot go stale between here and the purge.
 */
async function typeTags(db: Kysely<Database>, contentTypeId: string): Promise<string[]> {
  const contentType = await getContentType(db, contentTypeId);
  return contentType ? [typeTag(contentType.api_id)] : [];
}

export const GET = handle(async ({ context, taproot }) => {
  return json({ fields: await listFields(taproot.db.db, context.params.id!) });
});

export const POST = handle(
  async ({ context, taproot }) => {
    const input = await readJson(context.request, fieldInputSchema);
    const field = await createField(taproot.db.db, context.params.id!, input);
    taproot.invalidate(await typeTags(taproot.db.db, context.params.id!));

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
    taproot.invalidate(await typeTags(taproot.db.db, context.params.id!));

    return noContent();
  },
  { role: 'admin' },
);
