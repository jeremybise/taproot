# create-taproot

Guidance for Claude Code working in `packages/create-taproot`. See the repository root
[CLAUDE.md](../../CLAUDE.md) for everything that applies across Taproot.

**`create-taproot` scaffolds the server and only the server.** A website is a separate project that
installs `@taprootcms/astro`; generating one here would mean scaffolding somebody's front end, which
is the same reason Taproot ships no block templates. Three things about it:
- **Plain `.mjs` with no dependencies**, because it runs through `npx` on a machine that has
  installed nothing — it cannot have a build step and cannot afford an install before it starts.
- **Every prompt has a flag** (`--starter`, `--local`, `--yes`), which is what lets `create.test.ts`
  drive the real generator as a subprocess instead of testing a re-wired copy of it.
- **Six files are byte-identical to `apps/studio`** — `src/worker.ts`, the three `scripts/`, the
  Astro config, and the tsconfig — and `create.test.ts` asserts it. Nothing else would notice them
  diverging, because the scaffolded copies are the ones nobody in this repo runs. If that test
  fails, copy the file across rather than editing the expectation.

**`--local` needs `install-links=true`, and the failure without it names nothing useful.** A `file:`
dependency is symlinked, and npm then skips *its* dependencies — so React, `@astrojs/react`,
Tailwind, Radix, and TipTap exist only in the Taproot checkout, and the scaffolded build dies on
`Rolldown failed to resolve import "@astrojs/react/server.js"`. The scaffolder writes an `.npmrc`
for local mode and not for an ordinary one, where a published install hoists those itself.
