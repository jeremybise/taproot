import { createTerm, getTaxonomy, listTerms } from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json } from '../../_shared.js';

export const GET = handle(async ({ context, taproot }) => {
  const taxonomy = await getTaxonomy(taproot.db.db, context.params.id!);
  if (!taxonomy) return apiError(404, 'Taxonomy not found.');

  return json({ terms: await listTerms(taproot.db.db, taxonomy.id) });
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(120).optional(),
  parentId: z.string().nullish(),
  description: z.string().max(500).nullish(),
});

/**
 * Accepts either JSON or a form post.
 *
 * The term editor is a server-rendered page, so its "Add term" form submits as
 * `application/x-www-form-urlencoded` and the browser follows the redirect back. Programmatic
 * callers send JSON and get the term. One handler rather than two keeps the validation identical.
 */
export const POST = handle(
  async ({ context, taproot }) => {
    const taxonomyId = context.params.id!;
    const isForm = !(context.request.headers.get('content-type') ?? '').includes('application/json');

    const raw = isForm
      ? Object.fromEntries((await context.request.formData()).entries())
      : await context.request.json();

    const parsed = createSchema.safeParse({
      ...raw,
      // A <select> with no parent chosen submits an empty string, which must mean "root", not "".
      parentId: (raw as Record<string, unknown>).parentId || null,
    });

    const backToTaxonomy = (params: Record<string, string>) =>
      context.redirect(`/admin/taxonomies/${taxonomyId}?${new URLSearchParams(params)}`, 303);

    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'That term could not be created.';
      return isForm ? backToTaxonomy({ error: message }) : apiError(422, message);
    }

    // Same reason as the taxonomy create route: a domain error (bad parent, nesting in a flat
    // taxonomy) must come back as a readable message, not a JSON body rendered in the browser.
    if (isForm) {
      try {
        const term = await createTerm(taproot.db.db, taxonomyId, parsed.data);
        return backToTaxonomy({ added: term.name });
      } catch (error) {
        return backToTaxonomy({
          error: error instanceof Error ? error.message : 'Could not add that term.',
        });
      }
    }

    return json({ term: await createTerm(taproot.db.db, taxonomyId, parsed.data) }, { status: 201 });
  },
  { role: 'editor' },
);
