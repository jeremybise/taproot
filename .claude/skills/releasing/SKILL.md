---
name: releasing
description: Package naming, npm scope, and the publishing rules for @taprootcms/core, @taprootcms/studio, @taprootcms/astro, and create-taproot. Use when publishing or versioning a Taproot package, changing a package name or npm scope, or editing the `files` allowlist in any package.json.
---

# Releasing Taproot packages

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
bundler that walks everything. `@taprootcms/core` excludes `*.map` and `*.tsbuildinfo`: the maps
point at a `src/` it does not ship, and the buildinfo embeds absolute paths from whichever machine
built it. Check with `npm pack --dry-run` after touching any of this.
