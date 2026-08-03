import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The admin's source files are UTF-8, and stay UTF-8.
 *
 * Two source files were once saved through a Windows-1252 misdecode, which put sixteen wrong
 * characters into shipped UI: the block editor's move buttons rendered `â†‘` and `â†“` instead of
 * arrows, an inserted library entry read `open â€œVisit promptâ€`, and the reusable-block editor's
 * save button said `Savingâ€¦`. The files were *valid* UTF-8 the whole time — they simply contained
 * the wrong characters — so nothing at runtime could have caught it.
 *
 * Nothing else could either, and that is the point of this file. `BlockListEditor.test.tsx` renders
 * those exact buttons and asserts against their `aria-label`, never their glyph, so it passed
 * throughout. A test that does not look at a character cannot see a broken one.
 *
 * Checked here rather than in `scripts/a11y-audit.mjs` because it is a fact about the repository
 * rather than about a rendered page, and it needs no server.
 */

const ADMIN = fileURLToPath(new URL('.', import.meta.url));

/**
 * `â` followed by something only a cp1252 misdecode produces.
 *
 * The signature is the *characters*, not the bytes: the corruption is one round of UTF-8 read as
 * cp1252 and re-encoded, so the file is well-formed UTF-8 containing `â` `€` `œ` and friends. A
 * scan for double-encoded bytes — which is the obvious thing to write — finds nothing at all, and
 * that false clean is how this went unnoticed once already.
 *
 * `U+009D` earns its place: cp1252 has no glyph there, so a `”` misdecode round-trips through that
 * control character and through no other route. Its presence is close to proof.
 */
const MOJIBAKE =
  /â[-¿€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/;

/**
 * This file is skipped, and it has to be: the comments above quote the corruption they describe, so
 * the scan finds itself. The alternative is writing those examples as escape sequences, which would
 * make the one place explaining what the bug *looks like* the one place you cannot see it.
 */
const SELF = 'sourceEncoding.test.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (entry === SELF) return [];
    return /\.(ts|tsx|astro|css)$/.test(entry) ? [full] : [];
  });
}

describe('admin source encoding', () => {
  const files = sourceFiles(ADMIN);

  it('finds files to check', () => {
    // A traversal that silently matched nothing would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(40);
  });

  it('contains no cp1252 mojibake', () => {
    const bad = files
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter(({ text }) => MOJIBAKE.test(text))
      .map(({ file, text }) => {
        const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l)) + 1;
        return `${file.slice(ADMIN.length)}:${line}`;
      });

    expect(bad).toEqual([]);
  });

  it('carries no byte-order marks', () => {
    // The same event left a BOM on both files it corrupted — it is the fingerprint of the tool, and
    // cheap to keep watching for even though a BOM alone breaks nothing here.
    const withBom = files
      .filter((file) => {
        const bytes = readFileSync(file);
        return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      })
      .map((file) => file.slice(ADMIN.length));

    expect(withBom).toEqual([]);
  });
});
