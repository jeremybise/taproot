import type { ContentItem, ContentTypeRow, FieldRow, MediaRow } from '@taproot/core';

/**
 * A typed client for the Taproot REST API.
 *
 * Used by the admin islands and available to host applications that want to read or write content
 * from outside the Astro request context. Inside a route, prefer `Astro.locals.taproot` — it talks
 * to the database directly and skips an HTTP round trip.
 */

export interface TaprootClientOptions {
  /** Origin the API is served from. Defaults to same-origin. */
  baseUrl?: string;
  /** Extra headers, e.g. an API key once Phase 5 adds them. */
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export class TaprootApiError extends Error {
  override name = 'TaprootApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly fields: Record<string, string[]> = {},
  ) {
    super(message);
  }
}

export function createClient(options: TaprootClientOptions = {}) {
  const base = `${(options.baseUrl ?? '').replace(/\/$/, '')}/api/taproot`;
  const doFetch = options.fetch ?? globalThis.fetch;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...options.headers,
        ...(init.headers ?? {}),
      },
    });

    if (response.status === 204) return undefined as T;

    const body = (await response.json().catch(() => null)) as
      | (T & { error?: string; fields?: Record<string, string[]> })
      | null;

    if (!response.ok) {
      throw new TaprootApiError(
        body?.error ?? `Request failed with ${response.status}.`,
        response.status,
        body?.fields ?? {},
      );
    }

    return body as T;
  }

  return {
    contentTypes: {
      list: () => request<{ contentTypes: ContentTypeRow[] }>('/content-types'),
      get: (id: string) =>
        request<{ contentType: ContentTypeRow & { fields: FieldRow[] } }>(`/content-types/${id}`),
      create: (input: unknown) =>
        request<{ contentType: ContentTypeRow }>('/content-types', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      update: (id: string, input: unknown) =>
        request<{ contentType: ContentTypeRow }>(`/content-types/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      remove: (id: string) => request<void>(`/content-types/${id}`, { method: 'DELETE' }),
    },

    fields: {
      list: (contentTypeId: string) =>
        request<{ fields: FieldRow[] }>(`/content-types/${contentTypeId}/fields`),
      create: (contentTypeId: string, input: unknown) =>
        request<{ field: FieldRow }>(`/content-types/${contentTypeId}/fields`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      reorder: (contentTypeId: string, fieldIds: string[]) =>
        request<void>(`/content-types/${contentTypeId}/fields`, {
          method: 'PATCH',
          body: JSON.stringify({ fieldIds }),
        }),
      update: (id: string, input: unknown) =>
        request<{ field: FieldRow }>(`/fields/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      remove: (id: string) => request<void>(`/fields/${id}`, { method: 'DELETE' }),
    },

    items: {
      list: (query: Record<string, string | number | undefined> = {}) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
          if (value !== undefined) params.set(key, String(value));
        }
        const suffix = params.toString() ? `?${params}` : '';
        return request<{ items: ContentItem[]; total: number }>(`/items${suffix}`);
      },
      get: (id: string) => request<{ item: ContentItem }>(`/items/${id}`),
      create: (input: unknown) =>
        request<{ item: ContentItem }>('/items', { method: 'POST', body: JSON.stringify(input) }),
      update: (id: string, input: unknown) =>
        request<{ item: ContentItem }>(`/items/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      remove: (id: string) => request<void>(`/items/${id}`, { method: 'DELETE' }),
    },

    media: {
      list: () => request<{ media: (MediaRow & { url: string })[] }>('/media'),
      upload: (file: File, meta: { alt?: string; title?: string } = {}) => {
        const form = new FormData();
        form.set('file', file);
        if (meta.alt) form.set('alt', meta.alt);
        if (meta.title) form.set('title', meta.title);
        // Content-type is omitted deliberately so the browser sets the multipart boundary.
        return request<{ media: MediaRow & { url: string } }>('/media', {
          method: 'POST',
          body: form,
          headers: {},
        });
      },
      remove: (id: string) => request<void>(`/media/${id}`, { method: 'DELETE' }),
    },
  };
}

export type TaprootClient = ReturnType<typeof createClient>;
