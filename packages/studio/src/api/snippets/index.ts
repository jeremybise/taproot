import { createSnippet, listSnippets } from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json } from '../_shared.js';

export const GET = handle(async ({ taproot }) => {
  return json({ snippets: await listSnippets(taproot.db.db) });
});

/**
 * `api_id` is validated to the same shape a field's is, and for a stronger reason.
 *
 * A field's `api_id` is a key in stored JSON. A snippet's is what every `{{ token }}` in every page's
 * prose names, and the token grammar only matches this character set — so an `api_id` outside it
 * would produce a snippet that exists, is listed, and can never be referenced by anything.
 */
const apiIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Must start with a letter and use only lowercase letters, numbers and underscores.',
  );

const bodySchema = z.object({
  api_id: apiIdSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(500).nullish(),
  kind: z.enum(['text', 'number', 'date']),
  value: z.string().max(2000),
  display: z.string().max(200).nullish(),
});

/**
 * Accepts a form POST as well as JSON, following the menu-items route.
 *
 * The admin screen is server-rendered with a real `<form>`, so it works with JavaScript off — the
 * property the menus screen also holds. Both shapes go through one schema, so there is no second
 * definition of what a valid snippet is.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const isForm = !(context.request.headers.get('content-type') ?? '').includes('application/json');

    const raw = isForm
      ? await (async () => {
          const form = await context.request.formData();
          return {
            api_id: String(form.get('api_id') ?? '').trim(),
            name: String(form.get('name') ?? '').trim(),
            description: (form.get('description') as string | null)?.trim() || null,
            kind: String(form.get('kind') ?? 'text'),
            value: String(form.get('value') ?? ''),
            // An empty display box means "derive it", not "render nothing".
            display: (form.get('display') as string | null)?.trim() || null,
          };
        })()
      : ((await context.request.json()) as Record<string, unknown>);

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/snippets/new?${new URLSearchParams(params)}`, 303);

    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'That snippet could not be created.';
      return isForm ? back({ error: message }) : apiError(422, message);
    }
    const input = parsed.data;

    /*
     * Checked here rather than left to the unique index, so the editor gets a sentence naming the
     * problem instead of a constraint violation. The index is still what makes it true — this is a
     * message, not the guarantee.
     */
    const clash = (await listSnippets(taproot.db.db)).some((s) => s.api_id === input.api_id);
    if (clash) {
      const message = `A snippet with the id “${input.api_id}” already exists.`;
      return isForm ? back({ error: message }) : apiError(409, message);
    }

    const snippet = await createSnippet(taproot.db.db, input);

    if (isForm) {
      return context.redirect(
        `/admin/snippets?${new URLSearchParams({ created: snippet.name })}`,
        303,
      );
    }

    /*
     * No invalidation on create, matching the reusable-block route above it.
     *
     * A snippet nothing references yet changes no page, so a purge here would clear nothing — the
     * "purge that succeeds, reports success, and does nothing" mistake `SITE_TAG` shipped with. The
     * write that makes it visible is the page edit that adds the token, and that one purges.
     */
    return json({ snippet }, { status: 201 });
  },
  { role: 'editor' },
);

export { apiIdSchema, bodySchema };
