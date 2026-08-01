import { RedirectError, createRedirect, listRedirects } from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, readJson } from '../_shared.js';

export const GET = handle(async ({ context, taproot }) => {
  const params = new URL(context.request.url).searchParams;

  return json(
    await listRedirects(taproot.db.db, {
      search: params.get('q') ?? undefined,
      limit: Number(params.get('limit') ?? 100),
      offset: Number(params.get('offset') ?? 0),
    }),
  );
});

const createSchema = z.strictObject(
  {
    fromPath: z.string().min(1).max(2000),
    toPath: z.string().min(1).max(2000),
    statusCode: z.union([z.literal(301), z.literal(302)]).optional(),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? { message: `Unknown field(s): ${issue.keys.join(', ')}.` }
        : undefined,
  },
);

/**
 * Create a redirect, from JSON or from the settings screen's form.
 *
 * The form path exists for the same reason every other admin write has one: the admin is
 * server-rendered so it keeps working without JavaScript, and a screen that only submits JSON
 * would quietly depend on it.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const isForm = (context.request.headers.get('content-type') ?? '').includes('form');

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/settings/redirects?${new URLSearchParams(params)}`, 303);

    let input: z.infer<typeof createSchema>;

    if (isForm) {
      const form = await context.request.formData();
      input = {
        fromPath: String(form.get('fromPath') ?? ''),
        toPath: String(form.get('toPath') ?? ''),
        statusCode: form.get('statusCode') === '302' ? 302 : 301,
      };
    } else {
      input = await readJson(context.request, createSchema);
    }

    try {
      const redirect = await createRedirect(taproot.db.db, input);
      return isForm
        ? back({ created: redirect.from_path })
        : json({ redirect }, { status: 201 });
    } catch (error) {
      if (!(error instanceof RedirectError)) throw error;
      // 409 for a duplicate, 400 for anything else: a clash is about state, the rest about input.
      return isForm
        ? back({ error: error.message })
        : apiError(error.code === 'conflict' ? 409 : 400, error.message);
    }
  },
  { role: 'admin' },
);
