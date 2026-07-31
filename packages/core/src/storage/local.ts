import {
  buildStorageKey,
  contentTypeFromFilename,
  type PutOptions,
  type StorageAdapter,
  type StoredObject,
} from './types.js';

export interface LocalStorageConfig {
  /** Directory uploads are written to, e.g. `./public/uploads`. */
  directory: string;
  /** URL prefix the directory is served from, e.g. `/uploads`. */
  publicPath: string;
}

/**
 * Local-disk storage for development.
 *
 * Node modules are imported lazily through a variable specifier so this file can be part of a
 * bundle that also targets Workers without the bundler trying to resolve `node:fs`.
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly name = 'local' as const;
  readonly #config: LocalStorageConfig;

  constructor(config: LocalStorageConfig) {
    this.#config = config;
  }

  async put(
    key: string,
    body: Uint8Array | ArrayBuffer,
    options: PutOptions = {},
  ): Promise<StoredObject> {
    const { fs, path } = await nodeModules();
    const target = this.#resolve(key, path);

    await fs.mkdir(path.dirname(target), { recursive: true });
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    await fs.writeFile(target, bytes);

    return {
      key,
      size: bytes.byteLength,
      contentType: options.contentType ?? contentTypeFromFilename(key),
    };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const { fs, path } = await nodeModules();
    /**
     * Resolved outside the `try` on purpose.
     *
     * The catch below exists for one case — the file is not there — and a key that escapes the
     * upload directory is a different thing entirely. Resolving inside it reported an attempted
     * traversal as a plain miss, which is safe (nothing is read) but silent, and left `get`
     * disagreeing with `put` and `delete`, which both throw for the same key.
     */
    const target = this.#resolve(key, path);
    try {
      return new Uint8Array(await fs.readFile(target));
    } catch {
      return undefined;
    }
  }

  async delete(key: string): Promise<void> {
    const { fs, path } = await nodeModules();
    await fs.rm(this.#resolve(key, path), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    const { fs, path } = await nodeModules();
    // Resolved outside the `try` for the same reason as `get`: "outside the directory" is not
    // "absent", and only the second one is this method's answer to give.
    const target = this.#resolve(key, path);
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  publicUrl(key: string): string {
    return `${this.#config.publicPath.replace(/\/$/, '')}/${key}`;
  }

  /**
   * Resolve a key to an absolute path, refusing anything that escapes the upload directory.
   *
   * `sanitizeFilename` already strips traversal from the filename, but keys are also built from
   * stored values, so this is the backstop that makes a bad key a thrown error rather than a write
   * anywhere on disk.
   */
  #resolve(key: string, path: NodePath): string {
    const root = path.resolve(this.#config.directory);
    const target = path.resolve(root, key);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`Refusing to access "${key}", which resolves outside the upload directory.`);
    }
    return target;
  }
}

interface NodePath {
  resolve(...segments: string[]): string;
  dirname(p: string): string;
  readonly sep: string;
}

interface NodeFs {
  mkdir(p: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(p: string, data: Uint8Array): Promise<void>;
  readFile(p: string): Promise<Uint8Array>;
  rm(p: string, options: { force: boolean }): Promise<void>;
  access(p: string): Promise<void>;
}

async function nodeModules(): Promise<{ fs: NodeFs; path: NodePath }> {
  const fsSpecifier = 'node:fs/promises';
  const pathSpecifier = 'node:path';
  const [fs, path] = await Promise.all([
    import(/* @vite-ignore */ fsSpecifier) as Promise<NodeFs>,
    import(/* @vite-ignore */ pathSpecifier) as Promise<{ default: NodePath } & NodePath>,
  ]);
  return { fs, path: (path as { default?: NodePath }).default ?? path };
}

export { buildStorageKey };
