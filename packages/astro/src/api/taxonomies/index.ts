import { createTaxonomy, listTaxonomies } from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json } from '../_shared.js';

export const GET = handle(async ({ taproot }) => {
  return json({ taxonomies: await listTaxonomies(taproot.db.db) });
});

const createSchema = z.object({
  api_id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  name_plural: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  hierarchical: z.boolean(),
});

/**
 * Accepts either JSON or a form post, so the server-rendered admin form works without JavaScript.
 *
 * The checkbox needs care that JSON does not: an unchecked box submits **nothing at all**, so a
 * schema default of `true` would make "flat taxonomy" impossible to express from the form. Presence
 * is therefore the signal, and the JSON branch keeps an explicit default instead.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const isForm = !(context.request.headers.get('content-type') ?? '').includes('application/json');

    const input = isForm
      ? await (async () => {
          const form = await context.request.formData();
          return {
            api_id: String(form.get('api_id') ?? ''),
            name: String(form.get('name') ?? ''),
            name_plural: String(form.get('name_plural') ?? ''),
            description: (form.get('description') as string | null) || null,
            hierarchical: form.get('hierarchical') !== null,
          };
        })()
      : { hierarchical: true, ...((await context.request.json()) as Record<string, unknown>) };

    const parsed = createSchema.safeParse(input);
    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/taxonomies?${new URLSearchParams(params)}`, 303);

    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'That taxonomy could not be created.';
      return isForm ? back({ error: message }) : apiError(422, message);
    }

    /**
     * A duplicate api_id throws a TaxonomyError, which the shared handler would turn into a 409
     * JSON body — correct for an API client, but a browser following a form post would just be
     * shown the raw JSON. Caught here so the form branch redirects back with a readable message.
     */
    if (isForm) {
      try {
        const taxonomy = await createTaxonomy(taproot.db.db, parsed.data);
        return back({ created: taxonomy.name });
      } catch (error) {
        return back({ error: error instanceof Error ? error.message : 'Could not create that.' });
      }
    }

    return json({ taxonomy: await createTaxonomy(taproot.db.db, parsed.data) }, { status: 201 });
  },
  // Taxonomies are schema, like content types — an editor tags with them, an admin defines them.
  { role: 'admin' },
);
