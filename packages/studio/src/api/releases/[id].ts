import {
  deleteRelease,
  getRelease,
  getReleaseWithItems,
  releasePreflight,
  setReleaseStatus,
  slugify,
  updateRelease,
} from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json, noContent, readJson } from '../_shared.js';

export const GET = handle(async ({ context, taproot }) => {
  const result = await getReleaseWithItems(taproot.db.db, context.params.id!);
  if (!result) return apiError(404, 'Release not found.');

  return json({ ...result, preflight: await releasePreflight(taproot.db.db, result.release.id) });
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullish(),
  /**
   * `published` is deliberately absent. Publishing is not a status you set — it applies content,
   * cascades paths, and writes redirects — so it has its own endpoint and its own pre-flight.
   * Offering it here would be a second way in, with no check behind it.
   */
  status: z.enum(['open', 'scheduled', 'blocked']).optional(),
  publishAt: z.string().datetime().nullish(),
});

export const PATCH = handle(
  async ({ context, taproot, user }) => {
    const id = context.params.id!;
    const input = await readJson(context.request, patchSchema);

    const existing = await getRelease(taproot.db.db, id);
    if (!existing) return apiError(404, 'Release not found.');

    if (input.name !== undefined || input.description !== undefined) {
      await updateRelease(taproot.db.db, id, {
        name: input.name,
        description: input.description,
      });
    }

    if (input.status !== undefined) {
      await setReleaseStatus(taproot.db.db, id, input.status, {
        publishAt: input.publishAt ?? null,
        actor: user,
      });
    }

    return json({ release: await getRelease(taproot.db.db, id) });
  },
  { role: 'editor' },
);

/**
 * POST carries the form actions, because an HTML form can only GET or POST.
 *
 * Same shape as the content-item and content-type deletes: `_method` names the act, and a typed
 * confirmation is checked on the server rather than by disabling a submit button, which turning
 * JavaScript off would bypass.
 */
export const POST = handle(
  async ({ context, taproot, user }) => {
    const id = context.params.id!;
    const release = await getRelease(taproot.db.db, id);
    if (!release) return apiError(404, 'Release not found.');

    const form = await context.request.formData();
    const method = String(form.get('_method') ?? '');

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/releases/${id}?${new URLSearchParams(params)}`, 303);

    if (method === 'update') {
      await updateRelease(taproot.db.db, id, {
        name: String(form.get('name') ?? release.name),
        description: String(form.get('description') ?? '') || null,
      });
      return back({ saved: '1' });
    }

    if (method === 'schedule') {
      const publishAt = String(form.get('publishAt') ?? '').trim();
      if (!publishAt) return back({ error: 'Pick when this release should go live.' });

      const moment = new Date(publishAt);
      if (Number.isNaN(moment.getTime())) {
        return back({ error: 'That is not a date and time Taproot could read.' });
      }

      await setReleaseStatus(taproot.db.db, id, 'scheduled', {
        publishAt: moment.toISOString(),
        actor: user,
      });
      return back({ scheduled: moment.toISOString() });
    }

    if (method === 'reopen') {
      await setReleaseStatus(taproot.db.db, id, 'open', { actor: user });
      return back({ reopened: '1' });
    }

    if (method === 'delete') {
      /**
       * Checked against the slug of the name, matching what the screen asks for.
       *
       * A release has no `api_id`, and a raw display name carrying apostrophes and parentheses
       * turns a confirmation into a typing test. Derived in both places from the same function so
       * the two cannot disagree — and checked here rather than by disabling a button, which turning
       * JavaScript off would bypass.
       */
      const expected = slugify(release.name) || release.id.slice(0, 8);
      if (String(form.get('confirm') ?? '').trim() !== expected) {
        return back({ error: `Type ${expected} exactly to confirm. Nothing was deleted.` });
      }

      try {
        await deleteRelease(taproot.db.db, id);
      } catch (error) {
        return back({
          error: error instanceof Error ? error.message : 'Could not delete that release.',
        });
      }

      return context.redirect(
        `/admin/releases?${new URLSearchParams({ deleted: release.name })}`,
        303,
      );
    }

    return apiError(400, 'Unsupported form action.');
  },
  { role: 'editor' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    try {
      await deleteRelease(taproot.db.db, context.params.id!);
    } catch (error) {
      // The guard lives in core so this route and the admin screen cannot disagree about whether a
      // delete would succeed.
      return apiError(
        409,
        error instanceof Error ? error.message : 'Could not delete that release.',
      );
    }
    return noContent();
  },
  { role: 'editor' },
);
