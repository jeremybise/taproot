import { SITE_TAG, deleteTaxonomy, getTaxonomy, listTerms, updateTaxonomy } from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, noContent, readJson } from '../_shared.js';

export const GET = handle(async ({ context, taproot }) => {
  const taxonomy = await getTaxonomy(taproot.db.db, context.params.id!);
  if (!taxonomy) return apiError(404, 'Taxonomy not found.');

  return json({ taxonomy, terms: await listTerms(taproot.db.db, taxonomy.id) });
});

/**
 * `api_id` is absent deliberately: it is the stable machine name that field configs and API
 * consumers reference, so renaming it would break them silently. `.strict()` turns an attempt into
 * an explicit error rather than a change that appears to work.
 */
const patchSchema = z.strictObject(
  {
    name: z.string().min(1).max(120).optional(),
    name_plural: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullish(),
    hierarchical: z.boolean().optional(),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? "A taxonomy's API id is fixed after creation, because field configs reference it. " +
          'Only name, name_plural, description, and hierarchical can be changed.'
        : undefined,
  },
);

export const PATCH = handle(
  async ({ context, taproot }) => {
    const input = await readJson(context.request, patchSchema);
    const taxonomy = await updateTaxonomy(taproot.db.db, context.params.id!, input);

    /**
     * `SITE_TAG`, because a taxonomy has no tag of its own and its reach is genuinely wide.
     *
     * A renamed vocabulary surfaces in every item payload's `terms` map, in any menu entry
     * targeting one of its terms, and in the facet list a filter UI is built from. Inventing a
     * `taxonomy:` tag would mean emitting it from three response shapes to save a purge that
     * happens when an administrator edits the content model — which is rare by construction.
     */
    taproot.invalidate([SITE_TAG]);

    return json({ taxonomy });
  },
  { role: 'admin' },
);

export const DELETE = handle(
  async ({ context, taproot }) => {
    await deleteTaxonomy(taproot.db.db, context.params.id!);
    taproot.invalidate([SITE_TAG]);

    return noContent();
  },
  { role: 'admin' },
);
