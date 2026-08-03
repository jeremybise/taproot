import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { LocalStorageAdapter } from './local.js';
import { R2StorageAdapter, type R2BucketLike } from './r2.js';
import { buildStorageKey, contentTypeFromFilename, sanitizeFilename } from './types.js';
import { storageFromEnv } from './index.js';

/**
 * The storage adapters, which had no tests.
 *
 * `imageSize.ts` was covered and these were not, which is the wrong way round for the two: header
 * parsing is pure and fails loudly, whereas these write files to paths built partly from
 * user-supplied names. The traversal defence in particular is a security control that nothing
 * asserted.
 *
 * Both adapters are exercised against real behaviour — a temp directory for local, a small
 * in-memory bucket for R2 — rather than through mocks of their own methods.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'taproot-storage-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const bytes = (...values: number[]) => new Uint8Array(values);

describe('LocalStorageAdapter', () => {
  const adapter = () => new LocalStorageAdapter({ directory: dir, publicPath: '/uploads' });

  it('writes, reads back, and reports the size', async () => {
    const storage = adapter();
    const stored = await storage.put('2026/07/abc/photo.png', bytes(1, 2, 3, 4));

    expect(stored).toEqual({ key: '2026/07/abc/photo.png', size: 4, contentType: 'image/png' });
    expect(await storage.get('2026/07/abc/photo.png')).toEqual(bytes(1, 2, 3, 4));
  });

  it('creates intermediate directories', async () => {
    // Keys are date-prefixed, so almost every upload writes into a directory that does not exist.
    const storage = adapter();
    await storage.put('a/b/c/d/deep.txt', bytes(9));
    expect(await readFile(join(dir, 'a', 'b', 'c', 'd', 'deep.txt'))).toEqual(
      Buffer.from([9]),
    );
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', async () => {
    const storage = adapter();
    const stored = await storage.put('x.bin', new Uint8Array([7, 7, 7]).buffer);
    expect(stored.size).toBe(3);
  });

  it('takes the content type from the key when none is given, and the option when it is', async () => {
    const storage = adapter();
    expect((await storage.put('a.pdf', bytes(1))).contentType).toBe('application/pdf');
    expect((await storage.put('b.bin', bytes(1), { contentType: 'image/webp' })).contentType).toBe(
      'image/webp',
    );
  });

  it('returns undefined for a missing key rather than throwing', async () => {
    // A deleted asset whose row survives is a broken image, not a 500.
    expect(await adapter().get('nothing/here.png')).toBeUndefined();
  });

  it('deletes, and tolerates deleting twice', async () => {
    const storage = adapter();
    await storage.put('gone.txt', bytes(1));

    await storage.delete('gone.txt');
    expect(await storage.exists('gone.txt')).toBe(false);
    // The media delete route removes the row first, so a retry must not fail on the second pass.
    await expect(storage.delete('gone.txt')).resolves.toBeUndefined();
  });

  it('reports existence without reading the file', async () => {
    const storage = adapter();
    expect(await storage.exists('nope.txt')).toBe(false);
    await storage.put('yes.txt', bytes(1));
    expect(await storage.exists('yes.txt')).toBe(true);
  });

  it('builds a public URL without doubling the slash', async () => {
    expect(
      new LocalStorageAdapter({ directory: dir, publicPath: '/uploads/' }).publicUrl('a/b.png'),
    ).toBe('/uploads/a/b.png');
  });

  describe('refusing to escape the upload directory', () => {
    /**
     * The security control. `sanitizeFilename` strips traversal from a *filename*, but a key is
     * assembled from stored values too, so this is the backstop that makes a bad key a thrown
     * error rather than a write anywhere the process can reach.
     *
     * The backslash case is the one that matters here, and it passed for the wrong reason for a
     * long time: on Windows `\` separates paths, so `path.resolve` escaped the directory and the
     * guard caught it. On Linux and macOS it is an ordinary filename character, nothing escaped,
     * and the upload succeeded — so this suite only ever passed on the one platform Taproot is not
     * deployed to, and said nothing until it first ran in CI. The adapter now refuses backslashes
     * outright, on every platform, because a stored key can be read back on a different one.
     */
    for (const key of [
      '../escaped.txt',
      '../../etc/passwd',
      'a/../../escaped.txt',
      '..\\escaped.txt',
      'a\\..\\..\\escaped.txt',
    ]) {
      it(`refuses ${JSON.stringify(key)}`, async () => {
        const storage = adapter();
        await expect(storage.put(key, bytes(1))).rejects.toThrow(/outside the upload directory/);
      });
    }

    it('refuses to read outside it too, not just write', async () => {
      // Reads matter as much: an unchecked `get` turns the media route into arbitrary file
      // disclosure for anyone who can influence a stored key.
      const outside = join(dir, '..', `taproot-outside-${process.pid}.txt`);
      await writeFile(outside, 'secret');
      try {
        await expect(adapter().get(`../${outside.split(sep).pop()}`)).rejects.toThrow(
          /outside the upload directory/,
        );
      } finally {
        await rm(outside, { force: true });
      }
    });

    it('refuses existence checks outside it as well', async () => {
      await expect(adapter().exists('../../elsewhere.txt')).rejects.toThrow(
        /outside the upload directory/,
      );
    });

    it('allows a key that merely starts with the same characters as a sibling directory', async () => {
      // The prefix trap: `/uploads-old` must not count as inside `/uploads`, and the check uses a
      // separator rather than `startsWith` alone. Here the inverse — a legitimate nested key that a
      // naive check might reject.
      const storage = adapter();
      await expect(storage.put('uploads-extra/file.txt', bytes(1))).resolves.toBeDefined();
    });
  });
});

describe('R2StorageAdapter', () => {
  /** A bucket with just the surface `R2BucketLike` declares. */
  function fakeBucket() {
    const objects = new Map<string, { bytes: Uint8Array; options?: unknown }>();
    const bucket: R2BucketLike = {
      async put(key, value, options) {
        objects.set(key, {
          bytes: value instanceof Uint8Array ? value : new Uint8Array(value),
          options,
        });
        return undefined;
      },
      async get(key) {
        const object = objects.get(key);
        if (!object) return null;
        return {
          async arrayBuffer() {
            return object.bytes.slice().buffer as ArrayBuffer;
          },
        };
      },
      async delete(key) {
        objects.delete(key);
      },
      async head(key) {
        return objects.has(key) ? {} : null;
      },
    };
    return { bucket, objects };
  }

  const adapter = (bucket: R2BucketLike) =>
    new R2StorageAdapter({ bucket, publicBaseUrl: 'https://media.example.edu' });

  it('round-trips bytes through the bucket', async () => {
    const { bucket } = fakeBucket();
    const storage = adapter(bucket);

    await storage.put('a/b.png', bytes(5, 6, 7));
    expect(await storage.get('a/b.png')).toEqual(bytes(5, 6, 7));
  });

  it('stores an immutable cache-control alongside the object', async () => {
    // Media is addressed by a key containing its id, so it can be cached effectively forever —
    // and this is the only thing that sets that header on the R2 path.
    const { bucket, objects } = fakeBucket();
    await adapter(bucket).put('a/b.png', bytes(1));

    expect(objects.get('a/b.png')?.options).toEqual({
      httpMetadata: {
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });
  });

  it('lets a caller override the cache-control', async () => {
    const { bucket, objects } = fakeBucket();
    await adapter(bucket).put('a/b.png', bytes(1), { cacheControl: 'no-store' });

    expect((objects.get('a/b.png')?.options as { httpMetadata: { cacheControl: string } })
      .httpMetadata.cacheControl).toBe('no-store');
  });

  it('returns undefined for a missing key', async () => {
    const { bucket } = fakeBucket();
    expect(await adapter(bucket).get('nope')).toBeUndefined();
  });

  it('reports existence through head rather than fetching the body', async () => {
    const { bucket } = fakeBucket();
    const storage = adapter(bucket);

    expect(await storage.exists('a')).toBe(false);
    await storage.put('a', bytes(1));
    expect(await storage.exists('a')).toBe(true);
  });

  it('builds a public URL against the configured base', async () => {
    const { bucket } = fakeBucket();
    expect(
      new R2StorageAdapter({ bucket, publicBaseUrl: 'https://media.example.edu/' }).publicUrl(
        'a/b.png',
      ),
    ).toBe('https://media.example.edu/a/b.png');
  });

  it('agrees with the local adapter about what it stores', async () => {
    /**
     * The portability claim in one assertion. Both adapters sit behind one interface, and the
     * hosting decision is only reversible while they agree on the shape they return.
     */
    const { bucket } = fakeBucket();
    const r2 = await adapter(bucket).put('a/b.png', bytes(1, 2));
    const local = await new LocalStorageAdapter({ directory: dir, publicPath: '/u' }).put(
      'a/b.png',
      bytes(1, 2),
    );

    expect(r2).toEqual(local);
  });
});

describe('key construction', () => {
  it('date-prefixes and includes the id, so two files of the same name never collide', async () => {
    const a = buildStorageKey('id-one', 'photo.png');
    const b = buildStorageKey('id-two', 'photo.png');

    expect(a).not.toBe(b);
    expect(a).toMatch(/^\d{4}\/\d{2}\/id-one\/photo\.png$/);
  });

  describe('sanitizeFilename', () => {
    it('strips directory components', () => {
      expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
      expect(sanitizeFilename('C:\\Windows\\system32\\config')).toBe('config');
    });

    it('collapses repeated dots so an extension cannot be smuggled', () => {
      expect(sanitizeFilename('report..pdf')).toBe('report.pdf');
    });

    it('drops leading dots and dashes, which make a file hidden or read as a flag', () => {
      expect(sanitizeFilename('.htaccess')).toBe('htaccess');
      expect(sanitizeFilename('-rf')).toBe('rf');
    });

    it('replaces anything outside the safe set rather than dropping it silently', () => {
      expect(sanitizeFilename('my photo (1).png')).toBe('my-photo-1-.png');
    });

    it('truncates rather than accepting an unbounded name', () => {
      expect(sanitizeFilename(`${'a'.repeat(500)}.png`).length).toBeLessThanOrEqual(120);
    });

    it('never returns an empty string', () => {
      // An empty key would resolve to the upload directory itself.
      expect(sanitizeFilename('...')).toBe('file');
      expect(sanitizeFilename('/////')).toBe('file');
    });
  });

  describe('contentTypeFromFilename', () => {
    it('maps common types case-insensitively', () => {
      expect(contentTypeFromFilename('A.PNG')).toBe('image/png');
      expect(contentTypeFromFilename('doc.PDF')).toBe('application/pdf');
    });

    it('falls back to octet-stream for anything unknown', () => {
      expect(contentTypeFromFilename('archive.xyz')).toBe('application/octet-stream');
      expect(contentTypeFromFilename('noextension')).toBe('application/octet-stream');
    });
  });
});

describe('storageFromEnv', () => {
  it('chooses R2 when the binding is present', () => {
    const { bucket } = { bucket: {} as R2BucketLike };
    const storage = storageFromEnv({ TAPROOT_MEDIA_URL: 'https://media.example.edu' }, {
      MEDIA: bucket,
    });

    expect(storage.name).toBe('r2');
  });

  it('falls back to local disk with no binding', () => {
    const storage = storageFromEnv({
      TAPROOT_UPLOAD_DIR: resolve(dir),
      TAPROOT_MEDIA_URL: '/uploads',
    });

    expect(storage.name).toBe('local');
  });
});
