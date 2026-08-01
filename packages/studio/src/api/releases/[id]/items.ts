import { getRelease, stageItem, unstageItem, restageItem } from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, readJson } from '../../_shared.js';

const stageSchema = z.strictObject(
  { contentItemId: z.string().min(1) },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? { message: `Unknown field(s): ${issue.keys.join(', ')}.` }
        : undefined,
  },
);

/**
 * Put an item into a release, or take one out again.
 *
 * Contributor, not editor. Staging is queuing work — a staged version reaches nobody until an
 * editor publishes the release — so gating it at editor would mean the people who write the content
 * could not assemble the launch it is for. See `canStageToRelease`.
 *
 * The unstage and restage actions ride on POST rather than living at their own DELETE, because the
 * release screen is a server-rendered form and an HTML form can only GET or POST. The JSON caller
 * gets the same three through `_method`.
 */
export const POST = handle(
  async ({ context, taproot, user }) => {
    const releaseId = context.params.id!;
    const isForm = (context.request.headers.get('content-type') ?? '').includes('form');

    const release = await getRelease(taproot.db.db, releaseId);
    if (!release) return apiError(404, 'Release not found.');

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/releases/${releaseId}?${new URLSearchParams(params)}`, 303);

    if (isForm) {
      const form = await context.request.formData();
      const method = String(form.get('_method') ?? 'stage');
      const contentItemId = String(form.get('contentItemId') ?? '');

      if (!contentItemId) return back({ error: 'No content item was named.' });

      try {
        if (method === 'unstage') {
          await unstageItem(taproot.db.db, releaseId, contentItemId, { actor: user });
          return back({ unstaged: '1' });
        }

        if (method === 'restage') {
          await restageItem(taproot.db.db, releaseId, contentItemId);
          return back({ restaged: '1' });
        }

        const staged = await stageItem(taproot.db.db, releaseId, contentItemId, { actor: user });
        return back({ staged: staged.title });
      } catch (error) {
        return back({
          error: error instanceof Error ? error.message : 'Could not change that release.',
        });
      }
    }

    const input = await readJson(context.request, stageSchema);
    const staged = await stageItem(taproot.db.db, releaseId, input.contentItemId, { actor: user });
    return json({ staged }, { status: 201 });
  },
  { role: 'contributor' },
);
