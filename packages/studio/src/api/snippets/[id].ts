import { deleteSnippet, getSnippet, snippetTag, updateSnippet } from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, noContent, readJson } from '../_shared.js';

/**
 * `api_id` is absent from this schema on purpose, not merely optional.
 *
 * It is what every stored `{{ token }}` names, so changing it breaks content on pages nothing here
 * touches and no screen would show as broken. `updateSnippet` excludes it from its input type for
 * the same reason — the refusal lives in the type system rather than in a runtime check somebody can
 * forget to write.
 */
const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).nullish(),
  kind: z.enum(['text', 'number', 'date']).optional(),
  value: z.string().max(2000).optional(),
  display: z.string().max(200).nullish(),
});

/**
 * Editing a snippet is the invalidation with no backstop behind it.
 *
 * It changes what every page using it renders while touching none of their rows, so no validator
 * built from `updated_at` can notice — and a 304 *renews* a cached copy's freshness, which makes
 * that unbounded staleness rather than one TTL's worth. `contentLibraryVersion` folds a stamp into
 * the ETag for exactly that reason; this purge is what makes the change visible immediately rather
 * than at the next revalidation.
 *
 * Tagged by `api_id` rather than purging `SITE_TAG`, because pages record which snippets they used —
 * so precision is free here in a way it is not for a branding change.
 */
export const PATCH = handle(
  async ({ context, taproot }) => {
    const input = await readJson(context.request, patchSchema);
    const updated = await updateSnippet(taproot.db.db, context.params.id!, input);
    if (!updated) return apiError(404, 'That snippet no longer exists.');

    taproot.invalidate([snippetTag(updated.api_id)]);
    return json({ snippet: updated });
  },
  { role: 'editor' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    const id = context.params.id!;
    const existing = await getSnippet(taproot.db.db, id);

    const result = await deleteSnippet(taproot.db.db, id);
    if (!result.deleted) return apiError(409, result.blocker ?? 'That snippet cannot be deleted.');

    // Refused while anything still references it, so nothing here can strand a page — but the
    // snippet's own screens are cached too, and the entry has to leave them.
    if (existing) taproot.invalidate([snippetTag(existing.api_id)]);

    return noContent();
  },
  { role: 'editor' },
);

/**
 * The edit screen's form target.
 *
 * A browser `<form>` can send neither PATCH nor DELETE, so the server-rendered screen posts here and
 * names the act in `_method`. That is the ordinary way to keep a no-JavaScript form working against
 * a REST shape, and it is what lets this screen avoid being an island — it has nothing that needs
 * one, and `packages/studio/CLAUDE.md` is clear that a React island is reached for when interaction
 * genuinely demands it rather than by default.
 *
 * Every branch answers with a 303 redirect carrying a message, because the caller is a browser
 * following a form post and a JSON body would render as text on a blank page.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const id = context.params.id!;
    const form = await context.request.formData();

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/snippets/${id}?${new URLSearchParams(params)}`, 303);
    const toList = (params: Record<string, string>) =>
      context.redirect(`/admin/snippets?${new URLSearchParams(params)}`, 303);

    if (String(form.get('_method') ?? '') === 'delete') {
      const existing = await getSnippet(taproot.db.db, id);
      const result = await deleteSnippet(taproot.db.db, id);

      // The blocker is a sentence naming how many items still use it, so it belongs on the screen
      // the editor is already looking at rather than as a status code.
      if (!result.deleted) return back({ error: result.blocker ?? 'Could not delete that snippet.' });

      if (existing) taproot.invalidate([snippetTag(existing.api_id)]);
      return toList({ deleted: existing?.name ?? 'snippet' });
    }

    const parsed = patchSchema.safeParse({
      name: String(form.get('name') ?? '').trim(),
      description: (form.get('description') as string | null)?.trim() || null,
      kind: String(form.get('kind') ?? 'text'),
      value: String(form.get('value') ?? ''),
      // An empty display box means "derive it", not "render nothing".
      display: (form.get('display') as string | null)?.trim() || null,
    });

    if (!parsed.success) {
      return back({ error: parsed.error.issues[0]?.message ?? 'That snippet could not be saved.' });
    }

    const updated = await updateSnippet(taproot.db.db, id, parsed.data);
    if (!updated) return toList({ error: 'That snippet no longer exists.' });

    taproot.invalidate([snippetTag(updated.api_id)]);
    return toList({ updated: updated.name });
  },
  { role: 'editor' },
);
