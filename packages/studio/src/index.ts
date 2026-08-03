import { fileURLToPath } from 'node:url';

import type { AstroIntegration } from 'astro';
import react from '@astrojs/react';
import tailwind from '@tailwindcss/vite';
import { loadEnv } from 'vite';

export interface TaprootOptions {
  /**
   * Base path the admin panel is mounted at. Defaults to `/admin`.
   *
   * Cannot be `/`. The admin claims a segment so the top level stays free — see the root redirect
   * below — and `normalizeBase` refuses rather than quietly handing back `/admin`, which is what it
   * used to do to anyone who asked for the root.
   */
  adminPath?: string;
  /**
   * Register the React renderer. Leave on unless the host app already adds `@astrojs/react`
   * itself, in which case Astro would warn about a duplicate renderer.
   */
  addReactRenderer?: boolean;
}

/**
 * The Taproot Astro integration.
 *
 * Injects the admin panel and REST API as real Astro routes. The admin is server-rendered Astro
 * pages with React only where interaction demands it, rather than a client-side SPA — that keeps
 * every screen's permission check on the server, gives each screen a real URL, and avoids
 * hand-rolling the focus management and route announcements that client-side routing needs to
 * meet WCAG AA.
 */
export default function taproot(options: TaprootOptions = {}): AstroIntegration {
  const adminPath = normalizeBase(options.adminPath ?? '/admin');
  const apiPath = '/api/taproot';

  return {
    name: '@taprootcms/studio',
    hooks: {
      'astro:config:setup': ({ injectRoute, addMiddleware, updateConfig, logger, config, command }) => {
        if (config.output !== 'server') {
          logger.warn(
            "Taproot needs server-rendered output. Set `output: 'server'` in astro.config.mjs.",
          );
        }

        // Astro exposes `.env` through `import.meta.env`, not `process.env`, but Taproot's config
        // resolvers read a plain environment record so the same code works in the Worker, in Node,
        // and in the CLI scripts. Bridging it here means a host app only needs a `.env` file.
        // Real environment variables still win, so CI and secrets managers override the file.
        const root = fileURLToPath(config.root);
        const mode = command === 'build' ? 'production' : 'development';
        for (const [key, value] of Object.entries(loadEnv(mode, root, ''))) {
          process.env[key] ??= value;
        }

        updateConfig({
          vite: {
            plugins: [tailwind()],
            // `node:sqlite` is reached only by the dev SQLite driver, through a variable specifier
            // so bundlers cannot resolve it statically. Marking it external as well keeps the
            // Workers build from warning about a builtin it does not provide.
            ssr: { external: ['node:sqlite'] },
          },
          /**
           * The bare host lands in the CMS instead of 404ing.
           *
           * Since the split this deployment serves the admin and the API and nothing else, so `/`
           * was a dead end — someone who types the hostname they were given got nothing. The admin
           * keeps its segment rather than moving to the root: root-mounting would claim the whole
           * top-level namespace (`/content`, `/media`, `/settings`…) for admin screens and leave
           * the CMS host unable to serve anything else, which is a lot to give up for one segment.
           *
           * **302, not 301.** `adminPath` is configurable, and a permanent redirect is cached by
           * browsers indefinitely — an operator who later moves the admin would have visitors
           * bouncing to a path that no longer exists, with no way to tell them to stop.
           *
           * Declared through Astro's own `redirects` rather than an injected route, so a host app
           * that wants its own `/` can define one without fighting a route it did not add.
           */
          redirects: { '/': { status: 302, destination: adminPath } },
        });

        if (options.addReactRenderer !== false) {
          updateConfig({ integrations: [react()] });
        }

        addMiddleware({ entrypoint: '@taprootcms/studio/runtime/middleware', order: 'pre' });

        // --- Admin ---------------------------------------------------------
        /**
         * Admin routes.
         *
         * Content types are their own destinations rather than filters on one list, so the
         * per-type list needs its own URL. `/content/type/{api_id}` rather than
         * `/content/{api_id}` because `/content/{id}` already means a content item, and one
         * segment cannot mean both.
         */
        const adminRoutes: [string, string][] = [
          ['', 'index'],
          ['/login', 'login'],
          ['/setup', 'setup'],
          ['/set-password', 'set-password'],
          ['/forgot-password', 'forgot-password'],
          ['/verify', 'verify'],
          ['/account', 'account'],
          ['/content', 'content/index'],
          ['/content/new', 'content/new'],
          ['/content/type/[apiId]', 'content/type/[apiId]'],
          ['/content/[id]', 'content/[id]'],
          ['/accessibility', 'accessibility'],
          ['/singleton/[apiId]', 'singleton/[apiId]'],
          ['/releases', 'releases/index'],
          ['/releases/[id]', 'releases/[id]'],
          ['/blocks', 'blocks/index'],
          ['/blocks/new', 'blocks/new'],
          ['/blocks/[id]', 'blocks/[id]'],
          ['/media', 'media/index'],
          ['/media/[id]', 'media/[id]'],
          ['/taxonomies', 'taxonomies/index'],
          ['/taxonomies/[id]', 'taxonomies/[id]'],
          ['/menus', 'menus/index'],
          ['/menus/[id]', 'menus/[id]'],
          ['/settings', 'settings/index'],
          ['/settings/types', 'settings/types/index'],
          ['/settings/types/new', 'settings/types/new'],
          ['/settings/types/[id]', 'settings/types/[id]'],
          ['/settings/blocks', 'settings/blocks/index'],
          ['/settings/blocks/new', 'settings/blocks/new'],
          ['/settings/blocks/[id]', 'settings/blocks/[id]'],
          ['/settings/branding', 'settings/branding'],
          ['/settings/redirects', 'settings/redirects'],
          ['/settings/users', 'settings/users'],
          ['/settings/api-keys', 'settings/api-keys'],
          ['/settings/audit', 'settings/audit'],
          ['/settings/system', 'settings/system'],
        ];

        for (const [suffix, file] of adminRoutes) {
          injectRoute({
            pattern: `${adminPath}${suffix}`,
            entrypoint: `@taprootcms/studio/admin/pages/${file}.astro`,
            prerender: false,
          });
        }

        // --- REST API ------------------------------------------------------
        const apiRoutes: [string, string][] = [
          ['/auth/login', 'auth/login'],
          ['/auth/setup', 'auth/setup'],
          ['/auth/set-password', 'auth/set-password'],
          ['/auth/forgot-password', 'auth/forgot-password'],
          ['/auth/change-password', 'auth/change-password'],
          ['/auth/verify', 'auth/verify'],
          ['/auth/two-factor', 'auth/two-factor'],
          ['/auth/logout', 'auth/logout'],
          ['/auth/[provider]', 'auth/[provider]'],
          ['/auth/callback/[provider]', 'auth/callback/[provider]'],
          ['/content-types', 'content-types/index'],
          ['/content-types/reorder', 'content-types/reorder'],
          ['/content-types/[id]', 'content-types/[id]'],
          ['/content-types/[id]/fields', 'content-types/[id]/fields'],
          ['/fields/[id]', 'fields/[id]'],
          ['/items', 'items/index'],
          ['/items/[id]', 'items/[id]'],
          ['/items/[id]/revisions', 'items/[id]/revisions'],
          ['/items/[id]/revisions/[revisionId]/restore', 'items/[id]/revisions/[revisionId]/restore'],
          ['/releases', 'releases/index'],
          ['/releases/[id]', 'releases/[id]'],
          ['/releases/[id]/items', 'releases/[id]/items'],
          ['/releases/[id]/items/[itemId]', 'releases/[id]/items/[itemId]'],
          ['/releases/[id]/publish', 'releases/[id]/publish'],
          ['/users', 'users/index'],
          ['/users/[id]', 'users/[id]'],
          ['/api-keys', 'api-keys/index'],
          ['/api-keys/[id]', 'api-keys/[id]'],
          ['/settings/branding', 'settings/branding'],
          ['/redirects', 'redirects/index'],
          ['/redirects/[id]', 'redirects/[id]'],
          ['/reusable-blocks', 'reusable-blocks/index'],
          ['/reusable-blocks/[id]', 'reusable-blocks/[id]'],
          ['/reusable-blocks/[id]/delete', 'reusable-blocks/[id]/delete'],
          ['/media', 'media/index'],
          ['/media/[id]', 'media/[id]'],
          ['/media/[id]/details', 'media/[id]/details'],
          ['/media/file/[...key]', 'media/file/[...key]'],
          ['/taxonomies', 'taxonomies/index'],
          ['/taxonomies/[id]', 'taxonomies/[id]'],
          ['/taxonomies/[id]/terms', 'taxonomies/[id]/terms'],
          ['/terms/[termId]', 'terms/[termId]'],
          ['/menus', 'menus/index'],
          ['/menus/[id]', 'menus/[id]'],
          ['/menus/[id]/items', 'menus/[id]/items'],
          ['/menus/[id]/reorder', 'menus/[id]/reorder'],
          ['/menu-items/[itemId]', 'menu-items/[itemId]'],
          /**
           * The delivery API — the read contract for a site on another origin.
           *
           * Namespaced away from the admin REST API above because the two are shaped for different
           * callers: those routes edit one thing at a time for a signed-in person, these answer a
           * whole page for a machine holding a scoped key.
           */
          ['/preview', 'preview'],
          ['/delivery/resolve', 'delivery/resolve'],
          ['/delivery/items', 'delivery/items'],
          ['/delivery/menu/[apiId]', 'delivery/menu/[apiId]'],
          ['/delivery/schema', 'delivery/schema'],
          ['/scheduler/run', 'scheduler/run'],
          ['/theme', 'theme'],
        ];

        for (const [suffix, file] of apiRoutes) {
          injectRoute({
            pattern: `${apiPath}${suffix}`,
            entrypoint: `@taprootcms/studio/api/${file}.ts`,
            prerender: false,
          });
        }

        /*
          There is deliberately no public catch-all here.

          A `publicRoutes` option used to inject one, and it was a leftover from before the split:
          it read the database directly — the affordance the delivery API replaced — and rendered
          every field as a heading and a paragraph, with no block resolution, no reusable-block
          dereferencing, and `item.seo` read raw so none of `resolveSeo`'s fallbacks applied. That
          is the second read path SCOPE rules out under "one contract, one set of docs, nothing to
          drift", and it had already drifted. A site renders content through `@taprootcms/astro` and
          the delivery API; `apps/web` is the worked example.
        */

        logger.info(`admin at ${adminPath}, API at ${apiPath}`);
      },

      'astro:config:done': ({ logger }) => {
        /**
         * The old warning here announced that development sign-in was enabled. It no longer says
         * anything useful — password sign-in is the normal state — so what is worth surfacing is
         * the opposite: a build that still carries the retired variable, which `resolveAuthConfig`
         * will refuse to start on. Caught at config time so it is a legible message rather than a
         * boot failure on the first request.
         */
        if (process.env.TAPROOT_DEV_AUTH !== undefined) {
          logger.warn(
            'TAPROOT_DEV_AUTH is set but no longer used. Email and password sign-in is on by ' +
              'default; use TAPROOT_PASSWORD_AUTH=0 to turn it off. Remove TAPROOT_DEV_AUTH — ' +
              'Taproot refuses to start while it is present.',
          );
        }
      },
    },
  };
}

/**
 * Refuses the root rather than quietly substituting `/admin` for it.
 *
 * `adminPath: '/'` used to come back as `/admin`, so an operator who asked for a root-mounted admin
 * got one at a different path and no indication anything had been ignored — the same shape of bug
 * as a `.strict()` message that is accepted and discarded. Throwing at config time makes it a
 * legible error before the server starts rather than a surprise in the address bar.
 */
function normalizeBase(path: string): string {
  const trimmed = `/${path}`.replace(/\/+/g, '/').replace(/\/+$/, '');

  if (trimmed === '') {
    throw new Error(
      "Taproot's `adminPath` cannot be '/'. The admin needs a path segment so the top level stays " +
        'free for the root redirect and anything else the deployment serves. Pass a path such as ' +
        "'/admin' or '/cms', or omit the option.",
    );
  }

  return trimmed;
}

export type { TaprootContext } from './runtime/context.js';
