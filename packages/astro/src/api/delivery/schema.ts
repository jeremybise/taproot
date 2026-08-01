import { deliverySchema } from '@taproot/core';

import { handleScoped, json } from '../_shared.js';

/**
 * The content model, for generating a consumer's types.
 *
 * SCOPE calls type generation "the point of the split rather than a nicety", and this is what it
 * reads. See `deliverySchema` in core for the shape and why block types come along.
 *
 * Deliberately uncached. It is read by a build-time CLI rather than on a request path, and a stale
 * schema would generate types that disagree with the content the same deployment is serving —
 * which is the one kind of wrong this endpoint exists to prevent.
 */
export const GET = handleScoped(
  async ({ taproot }) => json(await deliverySchema(taproot.db.db), {
    headers: { 'cache-control': 'no-store' },
  }),
  { scope: 'content:read' },
);
