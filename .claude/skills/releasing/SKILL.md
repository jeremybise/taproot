---
name: releasing
description: Package naming, npm scope, and the publishing rules for @taprootcms/core, @taprootcms/studio, @taprootcms/astro, and create-taproot. Use when publishing or versioning a Taproot package, changing a package name or npm scope, or editing the `files` allowlist in any package.json.
---

# Releasing Taproot packages

**A release is a tag. Nobody runs `npm publish`, and nobody logs into npm.**
[`.github/workflows/release.yml`](../../../.github/workflows/release.yml) fires on a `v*` tag,
re-runs `npm run typecheck` and `npm test`, refuses a tag that disagrees with the four
`package.json` versions, and publishes all four in dependency order. Authentication is **npm trusted
publishing over OIDC** — the job mints a short-lived credential npm verifies against each package's
trusted-publisher configuration, tied to this repository, this workflow filename, and the `release`
environment. There is deliberately no `NPM_TOKEN` anywhere, so there is nothing to leak or rotate,
and provenance is attached automatically.

So the whole release is:

```bash
git tag -a v0.1.49 -m "Version 0.1.49"   # annotated, matching every previous tag
git push origin v0.1.49
```

Three things follow, and the first is the one that wastes time:

- **A local `npm whoami` returning 401 means nothing.** Local npm credentials are not part of this
  process and are expected to be absent or stale. Asking somebody to `npm login` is asking them to
  set up an authentication path the release deliberately does not use. If a publish needs
  diagnosing, the evidence is the workflow run, not the laptop.
- **The version bump is its own commit, and it lands before the tag.** The workflow compares the tag
  to `packages/*/package.json` and fails the run rather than publishing a version no tag describes —
  the registry being the one copy nobody can correct afterwards.
- **A failed run is resumable.** Already-published versions are skipped rather than reattempted, so
  a run that got core out and died on studio can simply be re-run; without that, npm's immutability
  would make the retry die on core and burn a version number.

**The names are the architecture.** `@taprootcms/astro` is what a *site* installs, matching Wolly's
`@wollycms/astro`; the server is `@taprootcms/studio` and a site never installs it. Having those the
wrong way round was the Phase 0 misreading, and the 3.75b rename is what corrected it.

**The npm scope is `@taprootcms`, and the scaffolder is unscoped `create-taproot`.** Not `@taproot`:
the Bitcoin protocol upgrade of the same name crowds npm and GitHub search with `taproot-*`
cryptocurrency libraries, so `@taprootcms/core` is unmistakably this project where `@taproot/core`
is a guess until you look — and a scope only disambiguates once you can see the `@`, which search
results and word of mouth do not carry. The unscoped `taproot` was never available anyway (a
tree-manipulation library has held it since 2012). `create-taproot` is deliberately **unscoped**,
because `npm create taproot` resolves to `create-<name>`; scoping it would make the documented
command `npm create @taprootcms`. All three published packages share one version and release
together — `@taprootcms/studio` imports core's internals, so a mismatched pair is a broken install
rather than a supported combination.

**`files` in each published package is an allowlist with exceptions, and the exceptions are
load-bearing.** `@taprootcms/studio` and `@taprootcms/astro` ship *source*, so `!src/**/*.test.ts`
is what stops 22 test files reaching consumers with imports (`vitest`, `@testing-library/*`) that
are devDependencies nobody installs — an unresolvable import sitting in `node_modules` waiting for a
bundler that walks everything. `@taprootcms/core` excludes only `*.tsbuildinfo`, a build cache that
embeds absolute paths from whichever machine built it.

**Core's `.map` files ship, and `inlineSources` is what makes that safe.** They were excluded once,
on the reasoning that a map naming `../src/x.ts` is useless without a `src/` this package does not
send. That was true and incomplete: `sourceMap` stayed on, so every `dist/*.js` still carried a
`sourceMappingURL` comment naming a file the tarball had deliberately removed, and a consumer's Vite
chased it and warned once per module on every dev server start. `inlineSources` embeds the
TypeScript in `sourcesContent`, so each map resolves on its own with no `src/` in the package. Two
things follow: **excluding them again means also turning off `sourceMap`**, or the dangling comments
come straight back; and **`declarationMap` is off for core**, because a `.d.ts.map` has no
`sourcesContent` equivalent and is the one kind that is wrong whether you ship it or not.

The cost was weighed rather than waved through: core's tarball went 228 KB → 479 KB, making it the
largest of the four. It buys a readable stack trace from a deployed Worker, where the alternative is
an offset into a minified chunk.

Check with `npm pack --dry-run` after touching any of this.
