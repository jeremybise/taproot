/**
 * Media storage.
 *
 * One interface, three implementations: local disk in development, R2 on Cloudflare, and any
 * S3-compatible bucket for Node deployments. Keeping the interface this small is what makes the
 * hosting decision reversible — nothing above this layer knows which one is in use.
 */

export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
}

export interface PutOptions {
  contentType?: string;
  /** Cache-Control for backends that store it alongside the object. */
  cacheControl?: string;
}

export interface StorageAdapter {
  readonly name: 'local' | 'r2' | 's3';

  put(key: string, body: Uint8Array | ArrayBuffer, options?: PutOptions): Promise<StoredObject>;

  get(key: string): Promise<Uint8Array | undefined>;

  delete(key: string): Promise<void>;

  exists(key: string): Promise<boolean>;

  /**
   * The URL a browser should fetch this object from.
   *
   * Synchronous and non-signed by design: media in a CMS is public, and generating signed URLs
   * per render would defeat edge caching. Private assets would need a different method.
   */
  publicUrl(key: string): string;
}

/**
 * Build the storage key for an upload.
 *
 * Date-prefixed so a bucket listing stays browsable as it grows, and the id is included so two
 * files with the same name never collide.
 */
export function buildStorageKey(id: string, filename: string): string {
  const date = new Date();
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}/${month}/${id}/${sanitizeFilename(filename)}`;
}

/**
 * Make a filename safe for a storage key.
 *
 * Path separators and traversal sequences are removed rather than escaped — on the local-disk
 * adapter a key like `../../etc/passwd` would otherwise resolve outside the upload directory.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
  return cleaned || 'file';
}

/** Guess a content type from a filename, for backends that do not infer one. */
export function contentTypeFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
