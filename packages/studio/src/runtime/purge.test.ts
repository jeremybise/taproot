import { afterEach, describe, expect, it, vi } from 'vitest';

import { purgeInvalidated } from './purge.js';

/**
 * Locals shaped exactly as `@astrojs/cloudflare` builds them.
 *
 * Copied from the adapter's `createLocals` (`dist/utils/cf-helpers.js`) rather than approximated,
 * because the whole defect lives in the difference: `runtime` is a **non-enumerable property whose
 * `ctx` getter throws**, not a missing one. A hand-written `{ runtime: {} }` stands in for it in
 * every way except the one that mattered — the old `locals.runtime?.ctx?.cache` reads as safe
 * against that fake and passes, which is how a test could have existed and still missed this.
 */
function adapterLocals(cfContext: unknown): unknown {
  const locals: Record<string, unknown> = { cfContext };

  Object.defineProperty(locals, 'runtime', {
    enumerable: false,
    value: {
      get ctx(): never {
        throw new Error(
          `Astro.locals.runtime.ctx has been removed in Astro v6. Use 'Astro.locals.cfContext' instead.`,
        );
      },
    },
  });

  return locals;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('purgeInvalidated', () => {
  it('purges through cfContext without touching the removed runtime.ctx', async () => {
    const purge = vi.fn().mockResolvedValue({});

    await expect(
      purgeInvalidated(adapterLocals({ cache: { purge } }), new Set(['item:a', 'type:page'])),
    ).resolves.toBeUndefined();

    expect(purge).toHaveBeenCalledWith({ tags: ['item:a', 'type:page'] });
  });

  it('does not fail the request when no execution context is exposed', async () => {
    // The shape a deployment has when only the removed accessor is present: reaching for it throws,
    // and the save that already committed must not be reported as a failure because of it.
    await expect(
      purgeInvalidated(adapterLocals(undefined), new Set(['item:a'])),
    ).resolves.toBeUndefined();
  });

  it('does not fail the request when the purge itself rejects', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const purge = vi.fn().mockRejectedValue(new Error('purge unavailable'));

    await expect(
      purgeInvalidated(adapterLocals({ cache: { purge } }), new Set(['item:a'])),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalled();
  });

  it('does nothing at all when nothing was invalidated', async () => {
    const purge = vi.fn();

    await purgeInvalidated(adapterLocals({ cache: { purge } }), new Set());

    expect(purge).not.toHaveBeenCalled();
  });
});
