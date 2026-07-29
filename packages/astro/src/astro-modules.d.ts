/**
 * Ambient declaration for `.astro` imports.
 *
 * This package ships `.astro` source rather than a build (see package.json), so `BlockRenderer`
 * is imported from `./BlockRenderer.astro`. Plain `tsc` has no `.astro` resolver — only Vite via
 * the Astro plugin, or the Astro language server, understand that extension — so without this the
 * package's `typecheck` script fails on the import alone and the TypeScript around it never gets
 * checked at all.
 *
 * The trade-off is deliberate and narrow: this makes the *import* resolve so the `.ts`/`.tsx` in
 * this package is type-checked. It does not type-check the contents of the `.astro` files
 * themselves — that happens in the consuming app, where Astro's own toolchain runs over them.
 */
declare module '*.astro' {
  import type { AstroComponentFactory } from 'astro/runtime/server/index.js';

  const Component: AstroComponentFactory;
  export default Component;
}
