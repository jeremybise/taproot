import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `npm create taproot`.
 *
 * These run the real generator as a subprocess rather than importing its internals, because what is
 * worth testing is the thing a user actually invokes — every prompt has a flag precisely so that is
 * possible.
 *
 * The other half is the drift guard at the bottom. The template shares six files with `apps/studio`
 * byte for byte, and nothing else would notice them diverging: a fix made to the app's migrate
 * script would silently miss every project scaffolded afterwards.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'index.mjs');
const REPO = join(HERE, '..', '..');

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'taproot-create-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function run(args: string[], options: { cwd?: string } = {}): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? workspace,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function read(project: string, file: string): string {
  return readFileSync(join(workspace, project, file), 'utf8');
}

function pkg(project: string): Record<string, any> {
  return JSON.parse(read(project, 'package.json'));
}

describe('what it writes', () => {
  it('scaffolds a server, not a website', () => {
    run(['my-cms', '--starter=blank', '--yes']);

    for (const file of [
      'package.json',
      'astro.config.mjs',
      'tsconfig.json',
      'wrangler.jsonc',
      '.env.example',
      '.gitignore',
      'README.md',
      'src/worker.ts',
      'scripts/migrate.ts',
      'scripts/_db.ts',
      'scripts/_env.ts',
    ]) {
      expect(existsSync(join(workspace, 'my-cms', file)), file).toBe(true);
    }

    // No src/pages and no consumer half. A site is a separate project that installs
    // @taprootcms/astro; generating one here would mean scaffolding somebody's front end.
    expect(existsSync(join(workspace, 'my-cms', 'src/pages'))).toBe(false);
    expect(pkg('my-cms').dependencies['@taprootcms/astro']).toBeUndefined();
  });

  it('renames gitignore, which npm would otherwise strip', () => {
    // A published tarball silently drops a file named `.gitignore`, so the template carries it
    // under a name npm keeps. Without the rename a scaffolded project commits its .env and its
    // database on the first `git add .`.
    run(['my-cms', '--yes']);

    expect(existsSync(join(workspace, 'my-cms', '.gitignore'))).toBe(true);
    expect(existsSync(join(workspace, 'my-cms', 'gitignore'))).toBe(false);
    expect(read('my-cms', '.gitignore')).toContain('.env');
  });

  it('asks for the package versions it was published alongside', () => {
    // Read from the CLI's own package.json rather than hardcoded, so a release cannot ship a
    // scaffolder that asks for a version of core that does not exist yet.
    const version = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;
    run(['my-cms', '--yes']);

    expect(pkg('my-cms').dependencies['@taprootcms/core']).toBe(`^${version}`);
    expect(pkg('my-cms').dependencies['@taprootcms/studio']).toBe(`^${version}`);
  });

  it('names the project after its directory, made legal', () => {
    // `My CMS!` is a normal thing to type and not a legal npm name. Lowercased, illegal runs
    // collapsed to a hyphen, and the trailing separator that leaves is stripped — a name ending in
    // `-` is legal but looks like a typo somebody made.
    run(['My CMS!', '--yes']);
    expect(pkg('My CMS!').name).toBe('my-cms');
  });
});

describe('starters', () => {
  it('blank has no seed at all', () => {
    run(['my-cms', '--starter=blank', '--yes']);

    // The first-run setup screen creates the administrator, which is what it is for. A seed that
    // made an account with a known password would put the same one in every scaffolded project.
    expect(existsSync(join(workspace, 'my-cms', 'scripts/seed.ts'))).toBe(false);
    expect(pkg('my-cms').scripts['db:seed']).toBeUndefined();
    expect(pkg('my-cms').scripts['db:migrate']).toBeDefined();
  });

  it('minimal adds a seed and the script that runs it', () => {
    run(['my-cms', '--starter=minimal', '--yes']);

    expect(existsSync(join(workspace, 'my-cms', 'scripts/seed.ts'))).toBe(true);
    expect(pkg('my-cms').scripts['db:seed']).toContain('seed.ts');
  });

  it('creates no user in either starter', () => {
    run(['my-cms', '--starter=minimal', '--yes']);
    const seed = read('my-cms', 'scripts/seed.ts');

    expect(seed).not.toContain('createUser');
    expect(seed).not.toContain('setPassword');
  });

  it('refuses a starter it does not have', () => {
    expect(() => run(['my-cms', '--starter=kitchen-sink', '--yes'])).toThrow();
  });
});

describe('local mode', () => {
  it('points at a checkout and turns off symlinking', () => {
    /**
     * `install-links` is the whole reason local mode works. A `file:` dependency is symlinked by
     * default and npm then skips its dependencies, so React and @astrojs/react exist only in the
     * checkout — and the build fails with `Rolldown failed to resolve import
     * "@astrojs/react/server.js"`, which names none of that.
     */
    run(['my-cms', '--yes', '--local', REPO]);

    expect(pkg('my-cms').dependencies['@taprootcms/core']).toMatch(/^file:/);
    expect(read('my-cms', '.npmrc')).toContain('install-links=true');
  });

  it('writes no .npmrc for an ordinary scaffold', () => {
    // A published install hoists those dependencies itself; the flag would be noise.
    run(['my-cms', '--yes']);
    expect(existsSync(join(workspace, 'my-cms', '.npmrc'))).toBe(false);
  });
});

describe('refusing to overwrite', () => {
  it('stops when the directory has files in it', () => {
    run(['my-cms', '--yes']);
    expect(() => run(['my-cms', '--yes'])).toThrow(/already has files/);
  });

  it('tolerates a bare git repository', () => {
    // Scaffolding into a repo somebody just created is normal; refusing would send them to a temp
    // directory and a `mv`.
    const target = join(workspace, 'fresh');
    execFileSync('git', ['init', '-q', target], { encoding: 'utf8' });

    expect(() => run(['fresh', '--yes'])).not.toThrow();
    expect(existsSync(join(target, 'package.json'))).toBe(true);
  });
});

describe('the template stays in step with apps/studio', () => {
  /**
   * Six files are byte-identical by intent — the app in this repo and a scaffolded project are the
   * same thing, and `apps/studio` is where they get exercised. Nothing else would catch them
   * diverging: a fix to the app's migrate script would silently miss every project scaffolded
   * afterwards, and the scaffolded ones are the copies nobody here runs.
   *
   * If this fails, copy the file across rather than editing the expectation.
   */
  const SHARED = [
    'src/worker.ts',
    'scripts/migrate.ts',
    'scripts/_db.ts',
    'scripts/_env.ts',
    'astro.config.mjs',
    'tsconfig.json',
  ];

  it.each(SHARED)('%s matches', (file) => {
    const template = readFileSync(join(HERE, 'template', file), 'utf8');
    const app = readFileSync(join(REPO, 'apps', 'studio', file), 'utf8');

    expect(template.replace(/\r\n/g, '\n')).toBe(app.replace(/\r\n/g, '\n'));
  });

  it('keeps the wrangler config’s load-bearing parts, which cannot be a byte comparison', () => {
    /**
     * This is the one shared file that is generated rather than copied — the Worker name, the D1
     * database, and the bucket are all named after the user's project. What has to survive is the
     * part that is not theirs to choose: `main` pointing at source (naming anything under dist/
     * makes `astro dev` fail before it starts), and the two binding names core looks for.
     */
    run(['my-cms', '--yes']);
    const generated = read('my-cms', 'wrangler.jsonc');
    const app = readFileSync(join(REPO, 'apps', 'studio', 'wrangler.jsonc'), 'utf8');

    for (const fragment of ['"main": "./src/worker.ts"', '"binding": "DB"', '"binding": "MEDIA"']) {
      expect(generated, fragment).toContain(fragment);
      expect(app, fragment).toContain(fragment);
    }

    expect(generated).toContain('"name": "my-cms"');
    expect(generated).toContain('"bucket_name": "my-cms-media"');
    // The cron trigger is what a scheduled *release* needs; a scheduled page goes live without it.
    expect(generated).toContain('"crons"');
  });
});
