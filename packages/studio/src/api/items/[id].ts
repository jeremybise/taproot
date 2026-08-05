import {
  deleteItem,
  getContentType,
  getItem,
  itemWriteTags,
  recordAuditEntry,
  updateItem,
} from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, noContent, readJson } from '../_shared.js';
import { seoSchema } from '../seoSchema.js';
import { canChangeStatus } from '../../runtime/guards.js';

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
  /** When a scheduled item goes live. ISO 8601. Cleared automatically when status leaves scheduled. */
  publishAt: z.string().datetime().nullish(),
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

    /**
     * The previous status matters as much as the new one: moving *off* `published` unpublishes,
     * which is an editor's call even though the status being moved to is only a draft.
     */
    if (!canChangeStatus(user, existing.status, input.status)) {
      return apiError(
        403,
        'Changing this item to or from a published status requires the editor role or higher.',
      );
    }

    const item = await updateItem(taproot.db, contentType, contentType.fields, existing.id, {
      title: input.title,
      slug: input.slug,
      parentId: input.parentId,
      status: input.status,
      publishAt: input.publishAt,
      data: input.data,
      seo: input.seo,
      userId: user.id,
    });

    /**
     * Only status changes are logged, not every save.
     *
     * Every save already appends a revision with its author, which is a finer record than an audit
     * entry could be. What revisions do not answer is "who put this in front of the public, and
     * when" — a question asked after the fact, across items, by someone who was not involved.
     * Logging saves as well would bury exactly that in noise.
     */
    if (input.status && input.status !== existing.status) {
      await recordAuditEntry(taproot.db.db, {
        action: `item.${input.status}`,
        subjectType: 'item',
        subjectId: item.id,
        subjectLabel: item.title,
        actor: user,
        detail: { from: existing.status, to: input.status, path: item.path },
      });
    }

    taproot.invalidate(itemWriteTags(item.id, contentType.api_id));

    return json({ item });
  },
  { role: 'contributor' },
);

/**
 * POST carries the delete, because an HTML form can only GET or POST.
 *
 * Same shape as the content-type delete: `_method=delete` keeps it working without JavaScript, and
 * the typed confirmation is checked here rather than by disabling a submit button, which turning
 * JavaScript off would bypass.
 */
export const POST = handle(
  async ({ context, taproot, user }) => {
    const id = context.params.id!;
    const item = await getItem(taproot.db.db, id);
    if (!item) return apiError(404, 'Content item not found.');

    const form = await context.request.formData();
    if (form.get('_method') !== 'delete') return apiError(400, 'Unsupported form action.');

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/content/${id}?${new URLSearchParams(params)}`, 303);

    if (String(form.get('confirm') ?? '').trim() !== item.slug) {
      return back({ error: `Type ${item.slug} exactly to confirm. Nothing was deleted.` });
    }

    try {
      await deleteItem(taproot.db, id);
    } catch (error) {
      return back({
        error: error instanceof Error ? error.message : 'Could not delete that item.',
      });
    }

    await recordAuditEntry(taproot.db.db, {
      action: 'item.deleted',
      subjectType: 'item',
      subjectId: id,
      subjectLabel: item.title,
      actor: user,
      detail: { path: item.path, status: item.status },
    });

    /**
     * Back to the item's own type rather than to "All content".
     *
     * The list they were working in is the one that should now be missing a row; sending them
     * somewhere else makes them find their way back to check.
     */
    const contentType = await getContentType(taproot.db.db, item.content_type_id);
    const destination = contentType ? `/admin/content/type/${contentType.api_id}` : '/admin/content';

    if (contentType) taproot.invalidate(itemWriteTags(id, contentType.api_id));

    return context.redirect(
      `${destination}?${new URLSearchParams({ deleted: item.title })}`,
      303,
    );
  },
  { role: 'editor' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    /**
     * Read before deleting, so the tags survive the row.
     *
     * `itemWriteTags` needs the content type's `api_id`, and after `deleteItem` there is nothing
     * left to look it up from. Same shape as the audit log copying `subject_label` at write time
     * rather than joining: what a record needs about a deleted thing has to be taken while it
     * exists.
     */
    const doomed = await getItem(taproot.db.db, context.params.id!);
    const contentType = doomed
      ? await getContentType(taproot.db.db, doomed.content_type_id)
      : undefined;

    try {
      await deleteItem(taproot.db, context.params.id!);
    } catch (error) {
      // The guard lives in core so this route and the admin screen cannot disagree about whether
      // a delete would succeed. Surfaced as 409 rather than 500: the request was well-formed and
      // the refusal is about state, not about the request.
      return apiError(409, error instanceof Error ? error.message : 'Could not delete that item.');
    }

    if (doomed && contentType) {
      taproot.invalidate(itemWriteTags(doomed.id, contentType.api_id));
    }

    return noContent();
  },
  { role: 'editor' },
);
