export * from './types.js';
export * from './imageSize.js';
export { LocalStorageAdapter } from './local.js';
export type { LocalStorageConfig } from './local.js';
export { R2StorageAdapter } from './r2.js';
export type { R2StorageConfig, R2BucketLike } from './r2.js';

import { LocalStorageAdapter } from './local.js';
import { R2StorageAdapter, type R2BucketLike } from './r2.js';
import type { StorageAdapter } from './types.js';

/**
 * Pick a storage adapter from the environment.
 *
 * Mirrors `dbConfigFromEnv`: an R2 binding wins when present, because in a Workers deployment it
 * is the only thing that can work. Otherwise local disk, so development needs no configuration.
 *
 * An S3 adapter for non-Cloudflare Node deployments is a small addition against the same
 * interface; it is not implemented in Phase 0 because nothing tested exercises it.
 */
export function storageFromEnv(
  env: Record<string, string | undefined>,
  bindings?: { MEDIA?: R2BucketLike },
): StorageAdapter {
  if (bindings?.MEDIA) {
    return new R2StorageAdapter({
      bucket: bindings.MEDIA,
      publicBaseUrl: env.TAPROOT_MEDIA_URL ?? '/media',
    });
  }

  return new LocalStorageAdapter({
    directory: env.TAPROOT_UPLOAD_DIR ?? './public/uploads',
    publicPath: env.TAPROOT_MEDIA_URL ?? '/uploads',
  });
}
