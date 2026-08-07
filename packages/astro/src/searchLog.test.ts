import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTaprootSearchLogHandler } from './searchLog.js';

/**
 * The consumer's search-log endpoint: a forwarder that exists so the API key never reaches a
 * browser.
 *
 * What is defended here is that it cannot be made to fail loudly. It is telemetry called from a
 * page the visitor has already been served, so every bad input is a 204 and a console line — a
 * client with error handling on this call would be a client handling errors nobody can act on.
 */

const post = (body: unknown) => ({
  request: new Request('https://site.test/api/search-log', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }),
});

function clientSpy() {
  return { logSearch: vi.fn(async () => {}) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createTaprootSearchLogHandler', () => {
  it('forwards a well-formed report', async () => {
    const client = clientSpy();
    const response = await createTaprootSearchLogHandler({ client })(
      post({ query: 'nursing', resultCount: 4, source: 'page' }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(client.logSearch).toHaveBeenCalledWith({
      query: 'nursing',
      resultCount: 4,
      source: 'page',
    });
  });

  it('trims the query, so one search is not two rows', async () => {
    const client = clientSpy();
    await createTaprootSearchLogHandler({ client })(
      post({ query: '  nursing  ', resultCount: 1, source: 'suggest' }),
    );

    expect(client.logSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'nursing' }));
  });

  it('drops a query below minLength rather than recording a phantom failure', async () => {
    /**
     * Below the floor no search was run, so a row would claim zero results for a question nobody
     * asked — and land at the top of the "found nothing" report, which is the one report that is
     * supposed to name real gaps.
     */
    const client = clientSpy();
    await createTaprootSearchLogHandler({ client, minLength: 3 })(
      post({ query: 'ai', resultCount: 0, source: 'abandoned' }),
    );

    expect(client.logSearch).not.toHaveBeenCalled();
  });

  it('refuses a source it does not recognise', async () => {
    // The three sources are read apart in the report; a fourth would be counted by nothing.
    const client = clientSpy();
    await createTaprootSearchLogHandler({ client })(
      post({ query: 'nursing', resultCount: 1, source: 'guess' }),
    );

    expect(client.logSearch).not.toHaveBeenCalled();
  });

  it('refuses a result count that is not a number', async () => {
    const client = clientSpy();
    await createTaprootSearchLogHandler({ client })(
      post({ query: 'nursing', resultCount: 'lots', source: 'page' }),
    );

    expect(client.logSearch).not.toHaveBeenCalled();
  });

  it('answers 204 for a malformed body instead of erroring', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = clientSpy();

    const response = await createTaprootSearchLogHandler({ client })(post('not json at all'));

    expect(response.status).toBe(204);
    expect(client.logSearch).not.toHaveBeenCalled();
  });

  it('answers 204 even when the CMS is unreachable', async () => {
    /**
     * The line this holds, and where it differs from the purge handler deliberately: there the
     * caller is a retry queue whose only way to replay is a response saying it failed. Here the
     * caller is a page the visitor has already been served.
     */
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = {
      logSearch: vi.fn(async () => {
        throw new Error('CMS unreachable');
      }),
    };

    const response = await createTaprootSearchLogHandler({ client })(
      post({ query: 'nursing', resultCount: 1, source: 'page' }),
    );

    expect(response.status).toBe(204);
  });
});
