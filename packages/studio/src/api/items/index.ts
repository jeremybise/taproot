import { createItem, getContentType, listItems } from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json, readJson } from '../_shared.js';
import { seoSchema } from '../seoSchema.js';
import { canChangeStatus } from '../../runtime/guards.js';

export const GET = handle(async ({ context, taproot }) => {
  const params = new URL(context.request.url).searchParams;

  const result = await listItems(taproot.db.db, {
    contentTypeId: params.get('contentTypeId') ?? undefined,
    status: (params.get('status') as never) ?? undefined,
    search: params.get('search') ?? undefined,
    limit: Number(params.get('limit') ?? 50),
    offset: Number(params.get('offset') ?? 0),
  });

  return json(result);
});

const createSchema = z.object({
  contentTypeId: z.string().min(1),
  title: z.string().min(1).max(300),
  slug: z.string().optional(),
  parentId: z.string().nullish(),
  status: z.enum(['draft', 'in_review', 'scheduled', 'published', 'archived']).default('draft'),
  /** When a scheduled item goes live. ISO 8601. */
  publishAt: z.string().datetime().nullish(),
  data: z.record(z.string(), z.unknown()).default({}),
  seo: seoSchema.default({}),
});

export const POST = handle(
  async ({ context, taproot, user }) => {
    const input = await readJson(context.request, createSchema);

    const contentType = await getContentType(taproot.db.db, input.contentTypeId);
    if (!contentType) return apiError(404, 'Content type not found.');

    // Publishing is a higher bar than creating: a contributor can draft, an editor publishes.
    // `scheduled` counts too — see `canChangeStatus`. A new item has no previous status.
    if (!canChangeStatus(user, undefined, input.status)) {
      return apiError(403, 'That status requires the editor role or higher. Save as a draft instead.');
    }

    const item = await createItem(taproot.db, contentType, contentType.fields, {
      contentTypeId: contentType.id,
      title: input.title,
      slug: input.slug,
      parentId: input.parentId ?? null,
      status: input.status,
      publishAt: input.publishAt,
      data: input.data,
      seo: input.seo,
      userId: user.id,
    });

    return json({ item }, { status: 201 });
  },
  { role: 'contributor' },
);
