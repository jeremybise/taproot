import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Runtime code must read configuration from `readRuntimeEnv`, never from `process.env`.
 *
 * `readRuntimeEnv` reads the `cloudflare:workers` env — where a Worker's vars and secrets actually
 * live — and folds `process.env` in only as a Node fallback, so it is right on both runtimes.
 * `process.env` alone happens to work on Workers because `nodejs_compat` populates it from the
 * bindings, which is a compatibility behaviour rather than a contract this project relies on.
 *
 * One source, enforced, so a deployment cannot end up configured in a way only half the code can
 * see — and so the next person does not have to work out which of the two is authoritative.
 *
 * A source scan rather than a behavioural test, following `sourceEncoding.test.ts`: the mistake is
 * *which variable was passed*, which type-checks either way. Scanning is the only thing that sees
 * it.
 */

// `fileURLToPath`, not `.pathname`, which is what `sourceEncoding.test.ts` already does: on Windows
// a file URL's pathname is `/C:/…`, and `readdir` resolves that leading slash against the drive to
// `C:\C:\…`. Passes on Unix either way, which is how the wrong one gets written.
const RUNTIME = fileURLToPath(new URL('.', import.meta.url));

/**
 * Files allowed to touch `process.env` directly.
 *
 * `context.ts` is the one that *defines* the fallback, so it must. Nothing else in `runtime/` has a
 * reason to: everything there runs per request on Workers.
 */
const ALLOWED = new Set(['context.ts']);

async function runtimeSources(): Promise<string[]> {
  const entries = await readdir(RUNTIME, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => e.name);
}

describe('runtime configuration reads', () => {
  it('never reads process.env outside the one file that defines the fallback', async () => {
    const offenders: string[] = [];

    for (const name of await runtimeSources()) {
      if (ALLOWED.has(name)) continue;

      const source = await readFile(join(RUNTIME, name), 'utf8');

      // Strip block comments, so the paragraphs explaining this rule do not trip it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      if (/\bprocess\.env\b/.test(code)) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });
});
