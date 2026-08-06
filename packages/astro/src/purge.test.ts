import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTaprootPurgeHandler } from './purge.js';
import { PURGE_SECRET_HEADER } from '@taprootcms/core/pure';

/**
 * The consumer's half of the purge loop.
 *
 * Cloudflare scopes purging to the Worker that owns the cache, so this endpoint is the only way the
 * CMS can reach a site's rendered HTML. It is also an unauthenticated-by-default surface that
 * flushes a whole cache, which is why the secret handling gets more tests than the purge does.
 */

const SECRET = 'a-shared-secret-value';

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://site.example/taproot/purge', {
    method: 'POST',
    headers,
    body: JSON.stringify({ tags: ['item:a'] }),
  });
}

function localsWith(purge: ReturnType<typeof vi.fn>): unknown {
  return { cfContext: { cache: { purge } } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createTaprootPurgeHandler', () => {
  it('flushes the whole cache when the secret matches', async () => {
    const purge = vi.fn().mockResolvedValue({});
    const POST = createTaprootPurgeHandler({ secret: SECRET });

    const response = await POST({
      request: request({ [PURGE_SECRET_HEADER]: SECRET }),
      locals: localsWith(purge),
    });

    expect(response.status).toBe(204);
    /**
     * Everything, not the tags in the body. A site cannot derive its own dependencies — only
     * `resolve` exposes `cacheTags`, so a listing page has no way to know what it depended on, and
     * tag-precise purging would silently never invalidate the index that should show a new item.
     */
    expect(purge).toHaveBeenCalledWith({ purgeEverything: true });
  });

  it('refuses a wrong secret without purging', async () => {
    const purge = vi.fn();
    const POST = createTaprootPurgeHandler({ secret: SECRET });

    const response = await POST({
      request: request({ [PURGE_SECRET_HEADER]: 'not-the-secret-value' }),
      locals: localsWith(purge),
    });

    expect(response.status).toBe(401);
    expect(purge).not.toHaveBeenCalled();
  });

  it('refuses a request carrying no secret at all', async () => {
    const purge = vi.fn();
    const POST = createTaprootPurgeHandler({ secret: SECRET });

    const response = await POST({ request: request(), locals: localsWith(purge) });

    expect(response.status).toBe(401);
    expect(purge).not.toHaveBeenCalled();
  });

  /**
   * 404 rather than 401 when unconfigured, which is the difference between "there is nothing here"
   * and "there is something here worth guessing at". A site that never set the secret should not
   * advertise an endpoint that flushes its cache.
   */
  it('looks like no route at all when no secret is configured', async () => {
    const purge = vi.fn();
    const POST = createTaprootPurgeHandler();

    const response = await POST({
      request: request({ [PURGE_SECRET_HEADER]: SECRET }),
      locals: localsWith(purge),
    });

    expect(response.status).toBe(404);
    expect(purge).not.toHaveBeenCalled();
  });

  /**
   * A prefix of the real secret must not pass. The comparison is constant-time and length-checked;
   * a `startsWith` or a truncating compare would let a caller walk the secret one character at a
   * time.
   */
  it('does not accept a prefix or an extension of the secret', async () => {
    const POST = createTaprootPurgeHandler({ secret: SECRET });

    for (const candidate of [SECRET.slice(0, -1), `${SECRET}x`, '']) {
      const response = await POST({
        request: request({ [PURGE_SECRET_HEADER]: candidate }),
        locals: localsWith(vi.fn()),
      });
      expect(response.status).toBe(401);
    }
  });

  /**
   * The `npm run dev` shape, and any deployment without `"cache": { "enabled": true }`. Answering
   * an error would make the CMS retry eight times and then report a problem on a site that is
   * behaving correctly.
   */
  it('succeeds when the runtime exposes no cache to purge', async () => {
    const POST = createTaprootPurgeHandler({ secret: SECRET });

    const response = await POST({
      request: request({ [PURGE_SECRET_HEADER]: SECRET }),
      locals: {},
    });

    expect(response.status).toBe(204);
  });

  /**
   * Deliberately unlike every purge path inside the CMS, which never throws because the write it
   * describes has already committed. Here the caller is the retry queue, and the only way it can
   * ever replay this is if the response says it failed.
   */
  it('reports a real failure so the CMS retries it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const purge = vi.fn().mockRejectedValue(new Error('cache unavailable'));
    const POST = createTaprootPurgeHandler({ secret: SECRET });

    const response = await POST({
      request: request({ [PURGE_SECRET_HEADER]: SECRET }),
      locals: localsWith(purge),
    });

    expect(response.status).toBe(500);
  });

  it('is never cacheable, being an authenticated write surface', async () => {
    const POST = createTaprootPurgeHandler({ secret: SECRET });

    const response = await POST({
      request: request({ [PURGE_SECRET_HEADER]: SECRET }),
      locals: localsWith(vi.fn()),
    });

    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
