import { BrandingError, MAX_TITLE_LENGTH, getBranding, updateBranding } from '@taprootcms/core';
import { z } from 'zod';

import { apiError, handle, json, readJson } from '../_shared.js';

export const GET = handle(
  async ({ taproot }) => json({ branding: await getBranding(taproot.db.db) }),
  { role: 'admin' },
);

/**
 * A hex colour, or null to go back to the built-in accent.
 *
 * Checked here as well as in `updateBranding`, because these values end up inside a `<style>`
 * element: the boundary refusing anything that is not six hex digits is what makes "interpolate it
 * into CSS" a safe thing for the layout to do. Three-digit shorthand is accepted because a colour
 * input never emits it but a person editing the field by hand will.
 */
const hex = z
  .string()
  .regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex color such as #2f9e68.')
  .nullish();

const putSchema = z.strictObject({
  title: z.string().max(MAX_TITLE_LENGTH).nullish(),
  logoMediaId: z.string().nullish(),
  accentLight: hex,
  accentDark: hex,
});

/**
 * PUT rather than PATCH, and the whole shape every time.
 *
 * The screen is one form with four controls and a single Save; a partial update would mean the
 * island tracking which fields it had touched, and "clear the logo" and "leave the logo alone"
 * arriving as the same request. Every field is nullable and null means the default, so a full
 * replacement can say everything the form can say.
 *
 * Admin only: this changes what the CMS looks like for everybody who signs in, which is the same
 * bar as editing the content model.
 */
export const PUT = handle(
  async ({ context, taproot, user }) => {
    const input = await readJson(context.request, putSchema);

    try {
      return json({ branding: await updateBranding(taproot.db.db, input, user.id) });
    } catch (cause) {
      if (cause instanceof BrandingError) return apiError(422, cause.message);
      throw cause;
    }
  },
  { role: 'admin' },
);
