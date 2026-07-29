import type { SeoData } from '@taproot/core';
import { z } from 'zod';

/**
 * The SEO payload accepted on item create and update.
 *
 * Previously `z.record(z.string(), z.unknown())`, which accepted anything and stored it — a typo'd
 * key would round-trip into the item forever without ever being read. Strict, so a misspelled
 * `metaDesc` is a 422 an editor can act on rather than a value silently ignored.
 *
 * The `max()` bounds are storage sanity, not SEO advice: they sit far above the ~60/~160
 * characters the editor warns at, because search engines truncate by pixel width and a long title
 * is a quality judgement for a human, not something a server should refuse. See SEO_GUIDANCE in
 * @taproot/core.
 */
const shape = {
  metaTitle: z.string().max(300).optional(),
  metaDescription: z.string().max(1000).optional(),
  // `null` is accepted as "clear it", which is the natural thing for an API client to send.
  ogImageId: z.string().nullish(),
  noIndex: z.boolean().optional(),
};

export const seoSchema = z
  .strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? 'Unknown SEO field. Expected metaTitle, metaDescription, ogImageId, or noIndex.'
        : undefined,
  })
  /**
   * Normalise on the way in, so "unset" has exactly one spelling in storage.
   *
   * A blank string, a null, and a missing key all mean the same thing to `resolveSeo`, but
   * persisting all three would make every reader handle all three — and would show a cleared
   * field as a real change in the revision diff. The editor prunes client-side for the same
   * reason; doing it here as well is what makes it true for API clients too.
   *
   * The transform sits on the object rather than on each field because a per-field `.transform()`
   * wraps the field in a pipe, which stops it being optional and would force every client to send
   * every key.
   */
  .transform((seo): SeoData => {
    const normalised: SeoData = {};

    if (seo.metaTitle?.trim()) normalised.metaTitle = seo.metaTitle.trim();
    if (seo.metaDescription?.trim()) normalised.metaDescription = seo.metaDescription.trim();
    if (seo.ogImageId) normalised.ogImageId = seo.ogImageId;
    if (seo.noIndex) normalised.noIndex = true;

    return normalised;
  });
