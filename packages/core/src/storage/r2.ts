import {
  contentTypeFromFilename,
  type PutOptions,
  type StorageAdapter,
  type StoredObject,
} from './types.js';

/**
 * Structural type for the R2 Workers binding — only the surface actually used, declared locally so
 * `@taproot/core` does not need `@cloudflare/workers-types` to be installed downstream.
 */
export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<unknown | null>;
}

export interface R2StorageConfig {
  bucket: R2BucketLike;
  /**
   * Public base URL the bucket is served from — either an R2 custom domain or a Worker route that
   * proxies it. Without one, uploaded media has no reachable URL.
   */
  publicBaseUrl: string;
}

/** R2-backed storage for the Cloudflare Workers deployment target. */
export class R2StorageAdapter implements StorageAdapter {
  readonly name = 'r2' as const;
  readonly #config: R2StorageConfig;

  constructor(config: R2StorageConfig) {
    this.#config = config;
  }

  async put(
    key: string,
    body: Uint8Array | ArrayBuffer,
    options: PutOptions = {},
  ): Promise<StoredObject> {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    const contentType = options.contentType ?? contentTypeFromFilename(key);

    await this.#config.bucket.put(key, bytes, {
      httpMetadata: {
        contentType,
        // Media is content-addressed by key, so it can be cached hard and effectively forever.
        cacheControl: options.cacheControl ?? 'public, max-age=31536000, immutable',
      },
    });

    return { key, size: bytes.byteLength, contentType };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const object = await this.#config.bucket.get(key);
    if (!object) return undefined;
    return new Uint8Array(await object.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.#config.bucket.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.#config.bucket.head(key)) !== null;
  }

  publicUrl(key: string): string {
    return `${this.#config.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }
}
