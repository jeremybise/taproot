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
      /**
       * The default points at the route that actually serves R2 objects.
       *
       * It used to be `/media`, which nothing served — so a deployment without a custom domain on
       * the bucket produced uploads that succeeded and images that 404'd, a configuration gap
       * presenting as a broken picture. This couples core to the integration's fixed API prefix,
       * which is a small ugliness in exchange for a default that works.
       *
       * Setting `TAPROOT_MEDIA_URL` to a custom domain still wins, and is still the faster answer:
       * it serves from Cloudflare's edge without waking a Worker per image.
       */
      publicBaseUrl: env.TAPROOT_MEDIA_URL ?? '/api/taproot/media/file',
    });
  }

  return new LocalStorageAdapter({
    directory: env.TAPROOT_UPLOAD_DIR ?? './public/uploads',
    publicPath: env.TAPROOT_MEDIA_URL ?? '/uploads',
  });
}
