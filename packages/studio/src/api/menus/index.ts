import { createMenu, listMenus } from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json } from '../_shared.js';

export const GET = handle(async ({ taproot }) => {
  return json({ menus: await listMenus(taproot.db.db) });
});

const createSchema = z.object({
  api_id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
});

/** Accepts JSON or a form post, so the server-rendered admin form works without JavaScript. */
export const POST = handle(
  async ({ context, taproot }) => {
    const isForm = !(context.request.headers.get('content-type') ?? '').includes('application/json');

    const input = isForm
      ? await (async () => {
          const form = await context.request.formData();
          return {
            api_id: String(form.get('api_id') ?? ''),
            name: String(form.get('name') ?? ''),
            description: (form.get('description') as string | null) || null,
          };
        })()
      : ((await context.request.json()) as Record<string, unknown>);

    const parsed = createSchema.safeParse(input);
    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/menus?${new URLSearchParams(params)}`, 303);

    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'That menu could not be created.';
      return isForm ? back({ error: message }) : apiError(422, message);
    }

    // A duplicate api_id throws, and the shared handler would answer with a JSON body — right for
    // an API client, but a browser following a form post would be shown the raw JSON.
    if (isForm) {
      try {
        const menu = await createMenu(taproot.db.db, parsed.data);
        return context.redirect(`/admin/menus/${menu.id}?created=1`, 303);
      } catch (error) {
        return back({ error: error instanceof Error ? error.message : 'Could not create that.' });
      }
    }

    return json({ menu: await createMenu(taproot.db.db, parsed.data) }, { status: 201 });
  },
  // Menus are site structure — the same level as defining content types.
  { role: 'admin' },
);
