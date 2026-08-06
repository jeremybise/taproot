import { afterEach, describe, expect, it, vi } from 'vitest';

import { PURGE_SECRET_HEADER } from '@taprootcms/core';

import { purgeSite, sitePurgeConfig } from './sitePurge.js';

/**
 * The CMS's half of the purge loop.
 *
 * Cloudflare scopes purging to the Worker that owns the cache, so this HTTP call is the only thing
 * that can clear a consumer's rendered HTML. Everything here is about failing safely: an
 * unreachable site must never turn a committed save into an error, and a *silently* dropped purge
 * must never happen either, because at a long TTL that is a page which stays wrong.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const CONFIG = { url: 'https://site.example/_taproot/purge', secret: 'shhh' };

describe('sitePurgeConfig', () => {
  it('needs both halves, so a partial setup behaves like no setup', async () => {
    expect(sitePurgeConfig({})).toBeUndefined();
    expect(sitePurgeConfig({ TAPROOT_SITE_PURGE_URL: 'https://site.example/x' })).toBeUndefined();
    expect(sitePurgeConfig({ TAPROOT_SITE_PURGE_SECRET: 'shhh' })).toBeUndefined();

    expect(
      sitePurgeConfig({
        TAPROOT_SITE_PURGE_URL: 'https://site.example/x',
        TAPROOT_SITE_PURGE_SECRET: 'shhh',
      }),
    ).toEqual({ url: 'https://site.example/x', secret: 'shhh' });
  });

  /** Blank strings are how an unset variable arrives from a `.env` that mentions it. */
  it('treats blank values as absent', async () => {
    expect(
      sitePurgeConfig({ TAPROOT_SITE_PURGE_URL: '  ', TAPROOT_SITE_PURGE_SECRET: 'shhh' }),
    ).toBeUndefined();
  });
});

describe('purgeSite', () => {
  it('sends the tags with the secret in a header, never in the URL', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    const outcome = await purgeSite(CONFIG, ['item:a', 'site'], { fetch: fetch as never });

    expect(outcome.ok).toBe(true);

    const [url, init] = fetch.mock.calls[0]!;
    // A URL lands in access logs, which is why the credential travels as a header.
    expect(url).toBe(CONFIG.url);
    expect((init.headers as Record<string, string>)[PURGE_SECRET_HEADER]).toBe('shhh');
    expect(JSON.parse(init.body as string)).toEqual({ tags: ['item:a', 'site'] });
  });

  /** No consumer configured is the ordinary single-deployment case, not a failure. */
  it('does nothing at all when no site is configured', async () => {
    const fetch = vi.fn();

    const outcome = await purgeSite(undefined, ['item:a'], { fetch: fetch as never });

    expect(outcome.ok).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never throws when the site cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const outcome = await purgeSite(CONFIG, ['item:a'], { fetch: fetch as never });

    // The editor's save already committed and was already reported successful.
    expect(outcome.ok).toBe(false);
  });

  /**
   * A 401 is the misconfiguration case: the two secrets disagree and no retry will fix it. Treating
   * only network errors as failures would let a permanently broken secret look like a working purge
   * forever, which is the exact class of bug `SITE_TAG` shipped with.
   */
  it('treats a non-2xx as a failure, not as a delivered purge', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));

    const outcome = await purgeSite(CONFIG, ['item:a'], { fetch: fetch as never });

    expect(outcome.ok).toBe(false);
    expect((outcome.error as Error).message).toContain('401');
  });
});
