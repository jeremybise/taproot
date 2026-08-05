import { describe, expect, it } from 'vitest';

import { DEFAULT_CACHE_CONTROL, applyDefaultCacheControl } from './responseCache.js';

describe('applyDefaultCacheControl', () => {
  it('marks a response that expressed no preference unstorable', () => {
    // The admin case: every screen is rendered after an auth check and sets no header of its own.
    const response = applyDefaultCacheControl(new Response('<html>admin</html>'));

    expect(response.headers.get('cache-control')).toBe(DEFAULT_CACHE_CONTROL);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('marks a redirect unstorable too', () => {
    // The 302 an unauthenticated request gets. A cached redirect is a smaller problem than cached
    // admin HTML and still not one worth having.
    const response = applyDefaultCacheControl(
      new Response(null, { status: 302, headers: { location: '/admin/login' } }),
    );

    expect(response.headers.get('cache-control')).toBe(DEFAULT_CACHE_CONTROL);
  });

  it('leaves the delivery API to its own caching', () => {
    // The whole point of the `has` check: delivery responses are supposed to be stored, and
    // overwriting them would silently undo the caching work this default exists to protect.
    const response = applyDefaultCacheControl(
      new Response('{}', {
        headers: { 'cache-control': 'public, max-age=0, s-maxage=60', vary: 'authorization' },
      }),
    );

    expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  });

  it('leaves an immutable media response alone', () => {
    const response = applyDefaultCacheControl(
      new Response('bytes', {
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
      }),
    );

    expect(response.headers.get('cache-control')).toContain('immutable');
  });

  it('marks an immutable-headers redirect by rebuilding it', () => {
    /**
     * `Response.redirect()` is the real thing, not a stand-in: its headers carry the spec's
     * immutable guard, so `set` throws `TypeError: immutable`. Astro builds configured redirects
     * this way. A version of this function that mutated in place would throw here and fail the
     * request from middleware; one that skipped on failure would leave the response unmarked.
     */
    const original = Response.redirect('https://cms.example/admin/login', 302);
    expect(() => original.headers.set('cache-control', 'x')).toThrow();

    const response = applyDefaultCacheControl(original);

    expect(response.headers.get('cache-control')).toBe(DEFAULT_CACHE_CONTROL);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://cms.example/admin/login');
    // And the rebuilt one accepts the session cookie the middleware appends next.
    expect(() => response.headers.append('set-cookie', 'taproot_session=x')).not.toThrow();
  });

  it('leaves an explicit no-store alone rather than doubling it', () => {
    const response = applyDefaultCacheControl(
      new Response('{}', { headers: { 'cache-control': 'no-store' } }),
    );

    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
