import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal `.env` loading for the CLI scripts.
 *
 * Hand-rolled rather than pulling in `dotenv`: the scripts need six lines of parsing, and keeping
 * the dependency out means `npm install` stays lean. Astro loads `.env` itself for the dev server;
 * this is only for the standalone scripts.
 */
export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(): Record<string, string | undefined> {
  for (const file of ['.env', '.env.local']) {
    let contents: string;
    try {
      contents = readFileSync(resolve(appRoot, file), 'utf8');
    } catch {
      continue;
    }

    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      // Real environment variables win over the file, so CI can override without editing it.
      process.env[key] ??= value;
    }
  }

  return process.env;
}

/** Resolve the local SQLite path relative to the app, so scripts work from any cwd. */
export function sqlitePath(env: Record<string, string | undefined>): string {
  return resolve(appRoot, env.TAPROOT_SQLITE_PATH ?? './data/taproot.sqlite');
}
