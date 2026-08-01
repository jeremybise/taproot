/**
 * Make `.astro` imports resolve for tsc.
 *
 * The same shim `@taprootcms/studio` carries, and with the same caveat: this makes the *import*
 * resolve so the surrounding TypeScript gets checked, and does **not** check the `.astro` file's own
 * contents. Astro's own tooling does that.
 */
declare module '*.astro' {
  const component: (props: Record<string, unknown>) => unknown;
  export default component;
}
