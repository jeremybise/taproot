import { deleteItem, getContentType, getItem, updateItem } from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json, noContent, readJson } from '../_shared.js';
import { seoSchema } from '../seoSchema.js';
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
  // Written explicitly as `.optional()` on the shared schema rather than derived with
  // `.partial()`, which does not strip a `.default()` and would send `{}` on every request that
  // omitted the key — wiping any stored SEO overrides. That exact bug has already cost a real one
  // here with field config.
  seo: seoSchema.optional(),
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
