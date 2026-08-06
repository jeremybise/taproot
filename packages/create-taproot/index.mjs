#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * `npm create taproot` — scaffold a Taproot CMS server.
 *
 * **What this makes is the server**, not a website: the deployment that owns the database, the
 * admin, and the API. The site that shows the content is a separate Astro project that installs
 * `@taprootcms/astro` and reads over HTTP, and the handbook's "Building a site" section walks
 * through it. Generating both from here would mean scaffolding somebody's front end, and Taproot
 * ships no templates for the same reason it ships no block components.
 *
 * No dependencies and no build step, because this runs through `npx` on a machine that has
 * installed nothing yet.
 */

/*
  Colour first, because `main()` is invoked at module scope and uses it. Declared lower down it sits
  in the temporal dead zone when the first line prints, which fails with "Cannot access 'bold'
  before initialization" — a startup crash rather than an unstyled string.

  Only when something is likely to interpret it: a CI log full of escape codes is worse than a
  plain one.
*/
const colour = stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (text) => (colour ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = wrap('1');
const dim = wrap('2');
const red = wrap('31');
const green = wrap('32');

const HERE = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await readFile(join(HERE, 'package.json'), 'utf8'));

/**
 * The three packages release together, so the scaffold asks for the range matching this
 * scaffolder's own version rather than a hardcoded one that would drift the first time it is
 * published without them.
 */
const DEP_RANGE = `^${version}`;

const STARTERS = {
  blank: {
    label: 'Blank',
    hint: 'Nothing but the database. You define your first content type in the admin.',
  },
  minimal: {
    label: 'Minimal starter',
    hint: 'A Page type with a few fields, a home page, and a main menu — so there is something to look at.',
  },
};

main().catch((error) => {
  console.error(`\n${red('Could not scaffold the project.')}\n${error?.message ?? error}`);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) return usage();

  console.log(`\n${bold('Taproot')} — scaffolding a CMS server.\n`);

  const rl = args.interactive ? createInterface({ input: stdin, output: stdout }) : null;

  try {
    const dir = args.dir ?? (await askDirectory(rl));
    const target = resolve(process.cwd(), dir);
    await assertEmpty(target);

    const starter = args.starter ?? (await askStarter(rl));

    await scaffold({ target, starter, local: args.local });

    report({ target, starter, local: args.local });
  } finally {
    rl?.close();
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * Every prompt has a flag, so the whole thing is scriptable.
 *
 * That is not a nicety: it is what lets the test suite run the real generator end to end instead of
 * testing a copy of it wired up differently.
 */
function parseArgs(argv) {
  const args = { dir: null, starter: null, local: null, interactive: true, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--yes' || arg === '-y') args.interactive = false;
    else if (arg.startsWith('--starter=')) args.starter = readStarter(arg.slice(10));
    else if (arg === '--starter') args.starter = readStarter(argv[++i]);
    else if (arg.startsWith('--local=')) args.local = arg.slice(8);
    else if (arg === '--local') args.local = argv[++i];
    else if (!arg.startsWith('-')) args.dir ??= arg;
  }

  // `--yes` with no starter takes the safe default rather than prompting anyway.
  if (!args.interactive) args.starter ??= 'blank';
  if (!args.interactive) args.dir ??= 'taproot-cms';

  return args;
}

function readStarter(value) {
  if (!Object.hasOwn(STARTERS, value ?? '')) {
    throw new Error(`Unknown starter "${value}". Expected one of: ${Object.keys(STARTERS).join(', ')}.`);
  }
  return value;
}

function usage() {
  console.log(`
${bold('npm create taproot')} [directory] [options]

Scaffolds a Taproot CMS server — the deployment that owns the database, the
admin panel, and the API. The website that reads from it is a separate project.

Options:
  --starter <blank|minimal>  What the CMS starts with. Default: blank
  --local <path>             Depend on a local Taproot checkout via file:
                             instead of the published packages
  -y, --yes                  Take defaults, ask nothing
  -h, --help                 This

Starters:
${Object.entries(STARTERS)
  .map(([key, { label, hint }]) => `  ${key.padEnd(9)} ${label} — ${hint}`)
  .join('\n')}
`);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

async function askDirectory(rl) {
  if (!rl) return 'taproot-cms';
  const answer = (await rl.question(`Directory ${dim('(taproot-cms)')}: `)).trim();
  return answer || 'taproot-cms';
}

async function askStarter(rl) {
  if (!rl) return 'blank';

  console.log('\nWhat should it start with?\n');
  const keys = Object.keys(STARTERS);
  keys.forEach((key, index) => {
    console.log(`  ${index + 1}) ${bold(STARTERS[key].label)} — ${dim(STARTERS[key].hint)}`);
  });

  while (true) {
    const answer = (await rl.question(`\nChoose ${dim('(1)')}: `)).trim() || '1';
    const chosen = keys[Number(answer) - 1] ?? (Object.hasOwn(STARTERS, answer) ? answer : null);
    if (chosen) {
      console.log('');
      return chosen;
    }
    console.log(red('  Pick a number from the list.'));
  }
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

async function assertEmpty(target) {
  if (!existsSync(target)) return;

  const entries = await readdir(target);
  // `.git` alone is fine: scaffolding into a repository somebody just created is a normal thing to
  // want, and refusing it would send them to a temp directory and a `mv`.
  const blocking = entries.filter((entry) => entry !== '.git');

  if (blocking.length > 0) {
    throw new Error(
      `${target} already has files in it (${blocking.slice(0, 3).join(', ')}${blocking.length > 3 ? ', …' : ''}).\n` +
        'Choose an empty directory — this refuses rather than merging, because a half-overwritten ' +
        'project is harder to recover from than a second attempt.',
    );
  }
}

async function scaffold({ target, starter, local }) {
  await mkdir(target, { recursive: true });
  await cp(join(HERE, 'template'), target, { recursive: true });

  if (starter === 'minimal') {
    await cp(join(HERE, 'template-minimal'), target, { recursive: true });
  }

  const name = sanitizeName(basename(target));

  await writeFile(join(target, 'package.json'), packageJson({ name, starter, local }));
  await writeFile(join(target, 'wrangler.jsonc'), wranglerConfig(name));
  await writeFile(join(target, '.env.example'), envExample());
  await writeFile(join(target, 'README.md'), readme({ name, starter }));

  /**
   * npm silently drops a file named `.gitignore` from a published tarball, so the template carries
   * it as `gitignore` and it is renamed on the way out. A scaffolded project without one commits
   * its `.env` and its SQLite database on the first `git add .`.
   */
  await rename(join(target, 'gitignore'), join(target, '.gitignore'));

  if (local) await writeFile(join(target, '.npmrc'), npmrc());
}

/**
 * Only written for `--local`, and it is what makes that mode work at all.
 *
 * A `file:` dependency is *symlinked* by default, and npm then does not install that package's own
 * dependencies into the project — it assumes they resolve from where the link points. For
 * `@taprootcms/studio` that means React, `@astrojs/react`, Tailwind, Radix and TipTap exist only in
 * the Taproot checkout's `node_modules`, which the scaffolded project's bundler does not search. The
 * build fails with `Rolldown failed to resolve import "@astrojs/react/server.js"`, which names none
 * of that.
 *
 * `install-links=true` makes npm treat a `file:` dependency like a real package — copied in, with
 * its dependencies installed alongside — which is exactly what a published install does. A normal
 * scaffold needs none of this, which is why the file is not written for one.
 */
function npmrc() {
  return `# Taproot is linked from a local checkout, so file: dependencies are installed as real
# packages rather than symlinked. Without this npm skips their dependencies — React and
# @astrojs/react among them — and the build fails on an import it cannot resolve.
install-links=true
`;
}

/** A directory name is not necessarily a legal npm name — `My CMS` is a normal thing to type. */
function sanitizeName(raw) {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');

  return cleaned || 'taproot-cms';
}

function packageJson({ name, starter, local }) {
  /**
   * `--local` points the three packages at a checkout instead of the registry.
   *
   * It exists because the alternative is a generator nobody can run until the packages are
   * published — including whoever is developing it. It is also the right thing for anyone hacking
   * on Taproot itself against a real scaffolded project.
   */
  const dep = (pkg) => (local ? `file:${posix(join(local, 'packages', pkg))}` : DEP_RANGE);

  const scripts = {
    dev: 'astro dev',
    build: 'astro build',
    preview: 'astro build && wrangler dev',
    astro: 'astro',
    'db:migrate': 'node --experimental-strip-types ./scripts/migrate.ts',
    'db:migrate:remote': 'node --experimental-strip-types ./scripts/migrate.ts --remote',
    // Needed once after migration 0019 on a database that already holds content — see the
    // generated README. Without it a scaffolded project has no way to complete a documented
    // upgrade step, which is the sort of gap only a scaffolded project ever hits.
    'db:reindex': 'node --experimental-strip-types ./scripts/reindex.ts',
    ...(starter === 'minimal'
      ? { 'db:seed': 'node --experimental-strip-types ./scripts/seed.ts' }
      : {}),
    deploy: 'astro build && wrangler deploy',
  };

  return `${JSON.stringify(
    {
      name,
      version: '0.0.0',
      private: true,
      type: 'module',
      description: 'A Taproot CMS server',
      engines: { node: '>=22.12.0' },
      scripts,
      dependencies: {
        '@astrojs/cloudflare': '^14.1.5',
        '@astrojs/node': '^11.0.3',
        '@taprootcms/core': dep('core'),
        '@taprootcms/studio': dep('studio'),
        astro: '^7.1.4',
      },
      devDependencies: { wrangler: '^4.114.0' },
    },
    null,
    2,
  )}\n`;
}

/** `file:` specifiers want forward slashes even on Windows. */
function posix(path) {
  return path.replace(/\\/g, '/');
}

function wranglerConfig(name) {
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": ${JSON.stringify(name)},

  // \`main\` is a source file, never a path under ./dist — that file does not exist until after a
  // build, and naming it makes \`astro dev\` fail before it starts. @astrojs/cloudflare fills this in
  // only when it is absent, and the entry it supplies is nothing but \`{ fetch: handle }\`.
  // src/worker.ts re-exports that same \`handle\` and adds \`scheduled\`, which is the only way the
  // cron trigger below can reach the publishing sweep.
  "main": "./src/worker.ts",

  // --- Scheduled publishing --------------------------------------------------
  // Every five minutes, which is the resolution scheduled publishing actually has.
  //
  // A scheduled *page* goes live without this: visibility is computed when the page is requested.
  // A scheduled *release* does not — its content has to be applied, which no page request can do.
  // Remove this trigger and releases stop publishing on schedule.
  "triggers": {
    "crons": ["*/5 * * * *"]
  },

  // --- Caching ---------------------------------------------------------------
  // Cloudflare checks the cache *before* invoking this Worker, so a hit costs no CPU, no
  // subrequests and no D1 reads — the Worker never runs. This is what makes the \`Cache-Control\`
  // the delivery API sends actually do something: Cloudflare does not cache JSON or HTML by
  // default, so without this the headers are correct HTTP that nothing acts on.
  //
  // Admin screens (\`Set-Cookie\`) and previews (\`no-store\`) bypass it automatically.
  "cache": {
    "enabled": true
  },

  // Placed near D1 rather than near the visitor: resolving a page is a chain of dependent queries,
  // and D1 lives in one region while the eyeball does not.
  "placement": {
    "mode": "smart"
  },

  "compatibility_date": "2026-07-01",

  // Gives the Worker the Node built-ins Astro's server runtime expects.
  "compatibility_flags": ["nodejs_compat"],

  "observability": {
    "enabled": true
  },

  // --- D1 -------------------------------------------------------------------
  // Run \`npx wrangler d1 create ${name}\` and paste the id it prints.
  // The binding name \`DB\` is what @taprootcms/core looks for — see dbConfigFromEnv.
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": ${JSON.stringify(name)},
      "database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"
    }
  ],

  // --- KV -------------------------------------------------------------------
  // Taproot does not use Astro's session API — sign-in sessions are rows in the database.
  // @astrojs/cloudflare injects a \`SESSION\` KV binding anyway, and injects it with no id, which
  // makes \`wrangler deploy\` create a namespace as a side effect. Declaring it keeps that visible,
  // and keeps a failed deploy retryable: a deploy that dies after auto-provisioning cannot be run
  // again, because the second attempt asks for a title that now exists (error 10014).
  //
  // Run \`npx wrangler kv namespace create ${name}-session\` and paste the id it prints.
  "kv_namespaces": [
    {
      "binding": "SESSION",
      "id": "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
    }
  ],

  // --- R2 -------------------------------------------------------------------
  // Run \`npx wrangler r2 bucket create ${name}-media\`.
  // The binding name \`MEDIA\` is what storageFromEnv looks for.
  "r2_buckets": [
    {
      "binding": "MEDIA",
      "bucket_name": ${JSON.stringify(`${name}-media`)}
    }
  ],

  // --- Images ----------------------------------------------------------------
  // Resizes media on the way out, so a visitor on a phone is not sent a 2000px photograph.
  // Nothing to create — the binding is the whole setup, and it works on a workers.dev subdomain
  // with no domain of your own. Cloudflare's free allowance is 5,000 unique transformations a
  // month, counted per image per size, and a cached one is not re-billed.
  //
  // Safe to delete. The media route serves the stored original whenever this is absent, so removing
  // it costs bytes and never correctness — which is also why a Node deployment needs nothing here.
  "images": {
    "binding": "IMAGES"
  },

  "vars": {
    "NODE_ENV": "production"
  }
}
`;
}

function envExample() {
  return `# Taproot needs none of this to run locally. Copy to .env and fill in what you want.
#
# Local development uses a SQLite file and the local disk for uploads, so \`npm run dev\` works
# with this file absent entirely.

# Where the CMS is served from. Used to build OAuth redirect URIs, so it has to match reality.
# TAPROOT_ORIGIN=http://localhost:4321

# Path to the local SQLite database. Defaults to ./data/taproot.sqlite
# TAPROOT_SQLITE_PATH=./data/taproot.sqlite

# --- Optional: OAuth, alongside email and password -------------------------------
# Register the app with the provider, using
# <TAPROOT_ORIGIN>/api/taproot/auth/callback/<github|google|microsoft> as the redirect URI.
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=

# Turns email and password sign-in off, for a deployment that wants OAuth exclusively.
# Taproot refuses to start if this is 0 and no provider is configured — a locked building is
# better reported at startup than at a sign-in page with no buttons on it.
# TAPROOT_PASSWORD_AUTH=0

# --- Optional: password-reset email ----------------------------------------------
# With nothing set the mailer writes to the server log and the "Forgot your password?" link is
# hidden, because a form whose success message is a lie is worse than no form.
# Delivery is a webhook taking flat JSON — no vendor SDK.
# TAPROOT_MAIL_WEBHOOK_URL=
# TAPROOT_MAIL_FROM=

# --- Optional: clearing a site's cache when content changes ------------------------
# Cloudflare scopes cache purging to the Worker that owns the cache, so this deployment purging its
# own cached JSON cannot touch the HTML a site rendered from it. This callback is the only thing
# that can; without it a published page reaches visitors when the site's own cache lifetime lapses.
#
# Both or neither — a URL with no secret is treated as no configuration rather than as a broken
# setup. The secret must match \`TAPROOT_PURGE_SECRET\` on the site, which mounts
# \`createTaprootPurgeHandler\` from @taprootcms/astro.
# TAPROOT_SITE_PURGE_URL=https://www.example.edu/taproot/purge
# TAPROOT_SITE_PURGE_SECRET=

# --- Optional: media served from a bucket custom domain ---------------------------
# Without this, images are served through /api/taproot/media/file/…, which works but wakes a
# Worker per image.
# TAPROOT_MEDIA_URL=https://media.example.edu

# --- Deploying to Cloudflare D1 ---------------------------------------------------
# Only needed for \`npm run db:migrate:remote\`, which runs on THIS machine and talks to
# Cloudflare's REST API. So these belong in this file even when deploying to production —
# they are not \`wrangler secret put\` values, and the deployed Worker never reads them.
#
# TAPROOT_CF_D1_ID is the database_id you already put in wrangler.jsonc. The token is a
# custom token carrying Account > D1 > Edit; Read is not enough, because the endpoint that
# applies migrations is a query endpoint that writes.
# TAPROOT_CF_ACCOUNT_ID=
# TAPROOT_CF_D1_ID=
# TAPROOT_CF_API_TOKEN=
`;
}

function readme({ name, starter }) {
  return `# ${name}

A [Taproot](https://github.com/jeremybise/taproot) CMS server: the admin panel, the REST API, and
the delivery API that a website reads content from.

**This is not the website.** Taproot is two deployments — this one owns the database and is where
content is written, and a separate Astro project installs \`@taprootcms/astro\`, holds an API key,
and renders the pages visitors see. Keeping them apart is why editing a page cannot take the site
down, and why the site can be rebuilt without touching what you have written.

## Getting started

\`\`\`bash
npm install
npm run db:migrate${starter === 'minimal' ? '\nnpm run db:seed' : ''}
npm run dev
\`\`\`

Then open <http://localhost:4321>. There are no accounts yet, so it takes you to a one-time setup
screen that creates the first administrator${
    starter === 'minimal' ? ' — the starter content is already there waiting' : ''
  }.

> Complete that setup before putting this anywhere public. Until an account exists, whoever reaches
> the URL first becomes the administrator.

## Commands

| Command | What it does |
|---|---|
| \`npm run dev\` | The CMS at <http://localhost:4321> |
| \`npm run db:migrate\` | Apply pending migrations to the local database |${
    starter === 'minimal' ? '\n| `npm run db:seed` | Create the starter content. Safe to re-run |' : ''
  }
| \`npm run db:migrate:remote\` | Apply them to your deployed D1 database |
| \`npm run db:reindex\` | Rebuild the listing index. Run once after a migration says to; safe to re-run |
| \`npm run preview\` | Build and serve through \`wrangler dev\` — the real Workers runtime |
| \`npm run deploy\` | Build and \`wrangler deploy\` |

## This folder is yours — put it in version control

It looks like scaffolding output, but it is your deployment. The CMS arrives through
\`node_modules\`; what is here is the part that cannot be regenerated — the Cloudflare resource ids
in \`wrangler.jsonc\`, the build configuration, the Worker entry, and the lockfile recording exactly
which version of Taproot is deployed.

\`\`\`bash
git init && git add . && git commit -m "New Taproot server"
\`\`\`

\`.gitignore\` already excludes \`.env\` and the local database, which are the two things that must
never be committed — \`.env\` holds your Cloudflare API token. Everything else is safe to commit,
including the resource ids: they are identifiers rather than credentials, which is why secrets go
through \`wrangler secret put\` instead.

## Upgrading

\`\`\`bash
npm install @taprootcms/core@latest @taprootcms/studio@latest
npm run db:migrate:remote
npm run deploy
\`\`\`

The two packages share a version and move together. Migrate **before** deploying: migrations are
additive, so old code tolerates the new schema, while new code cannot run against the old one.

## Deploying

The target is Cloudflare Workers + D1 + R2. In short: create the D1 database, the R2 bucket, and the
KV namespace, paste their ids into \`wrangler.jsonc\`, run \`npm run db:migrate:remote\`, then
\`npm run deploy\`. The handbook has the full sequence, including the API key your website will
need.

## Building the website

A second project, which installs the client and reads from this one:

\`\`\`bash
npm install @taprootcms/astro
\`\`\`

It needs two environment variables — the URL this server is deployed at, and an API key you issue
from **Settings → API keys**. The handbook's "Building a site" section covers rendering a page,
blocks, images, and menus.
`;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function report({ target, starter, local }) {
  const where = relative(process.cwd(), target) || '.';

  console.log(`${green('Created')} ${bold(where)} — a Taproot CMS server.\n`);
  console.log('Next:\n');
  console.log(`  cd ${where}`);
  console.log('  npm install');
  console.log('  npm run db:migrate');
  if (starter === 'minimal') console.log('  npm run db:seed');
  console.log('  npm run dev\n');
  console.log(`Then open ${bold('http://localhost:4321')} and create the first administrator.\n`);

  if (local) {
    console.log(dim(`Linked to the Taproot checkout at ${local} through file: specifiers.`));
    console.log(
      dim(
        'An .npmrc sets install-links=true — without it npm skips those packages’ own\n' +
          'dependencies and the build fails on an import it cannot resolve.\n',
      ),
    );
  } else {
    console.log(
      dim(
        'The website that shows this content is a separate project — it installs\n' +
          '@taprootcms/astro and reads over HTTP. See the handbook.\n',
      ),
    );
  }
}
