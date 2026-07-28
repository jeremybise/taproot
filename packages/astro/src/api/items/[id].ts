import { deleteItem, getContentType, getItem, updateItem } from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json, noContent, readJson } from '../_shared.js';
import { canPublishContent } from '../../runtime/guards.js';

export const GET = handle(async ({ context, taproot }) => {
  const item = await getItem(taproot.db.db, context.params.id!);
  if (!item) return apiError(404, 'Content item not found.');
  return json({ item });
});

const patchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  slug: z.string().optional(),
  parentId: z.string().nullish(),
  status: z.enum(['draft', 'in_review', 'scheduled', 'published', 'archived']).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  seo: z.record(z.string(), z.unknown()).optional(),
});

export const PATCH = handle(
  async ({ context, taproot, user }) => {
    const input = await readJson(context.request, patchSchema);

    const existing = await getItem(taproot.db.db, context.params.id!);
    if (!existing) return apiError(404, 'Content item not found.');

    const contentType = await getContentType(taproot.db.db, existing.content_type_id);
    if (!contentType) return apiError(404, 'Content type not found.');

    if (input.status === 'published' && !canPublishContent(user)) {
      return apiError(403, 'Publishing requires the editor role or higher.');
    }

    const item = await updateItem(taproot.db, contentType, contentType.fields, existing.id, {
      title: input.title,
      slug: input.slug,
      parentId: input.parentId,
      status: input.status,
      data: input.data,
      seo: input.seo,
      userId: user.id,
    });

    return json({ item });
  },
  { role: 'contributor' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    await deleteItem(taproot.db, context.params.id!);
    return noContent();
  },
  { role: 'editor' },
);
