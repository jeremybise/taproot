import { fileURLToPath } from 'node:url';

import type { AstroIntegration } from 'astro';
import react from '@astrojs/react';
import tailwind from '@tailwindcss/vite';
import { loadEnv } from 'vite';

export interface TaprootOptions {
  /** Base path the admin panel is mounted at. Defaults to `/admin`. */
  adminPath?: string;
  /**
   * Inject the public catch-all route that resolves content items by path.
   *
   * Off by default: most sites want their own `[...path].astro` so they control the templates.
   * `apps/web` does exactly that. Turn this on for a site with no custom rendering at all.
   */
  publicRoutes?: boolean;
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
    name: '@taproot/astro',
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
        });

        if (options.addReactRenderer !== false) {
          updateConfig({ integrations: [react()] });
        }

        addMiddleware({ entrypoint: '@taproot/astro/runtime/middleware', order: 'pre' });

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
          ['/content', 'content/index'],
          ['/content/new', 'content/new'],
          ['/content/type/[apiId]', 'content/type/[apiId]'],
          ['/content/[id]', 'content/[id]'],
          ['/singleton/[apiId]', 'singleton/[apiId]'],
          ['/blocks', 'blocks/index'],
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
          ['/settings/redirects', 'settings/redirects'],
          ['/settings/users', 'settings/users'],
          ['/settings/system', 'settings/system'],
        ];

        for (const [suffix, file] of adminRoutes) {
          injectRoute({
            pattern: `${adminPath}${suffix}`,
            entrypoint: `@taproot/astro/admin/pages/${file}.astro`,
            prerender: false,
          });
        }

        // --- REST API ------------------------------------------------------
        const apiRoutes: [string, string][] = [
          ['/auth/login', 'auth/login'],
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
          ['/reusable-blocks', 'reusable-blocks/index'],
          ['/reusable-blocks/[id]', 'reusable-blocks/[id]'],
          ['/reusable-blocks/[id]/delete', 'reusable-blocks/[id]/delete'],
          ['/media', 'media/index'],
          ['/media/[id]', 'media/[id]'],
          ['/media/[id]/details', 'media/[id]/details'],
          ['/taxonomies', 'taxonomies/index'],
          ['/taxonomies/[id]', 'taxonomies/[id]'],
          ['/taxonomies/[id]/terms', 'taxonomies/[id]/terms'],
          ['/terms/[termId]', 'terms/[termId]'],
          ['/menus', 'menus/index'],
          ['/menus/[id]', 'menus/[id]'],
          ['/menus/[id]/items', 'menus/[id]/items'],
          ['/menus/[id]/reorder', 'menus/[id]/reorder'],
          ['/menu-items/[itemId]', 'menu-items/[itemId]'],
        ];

        for (const [suffix, file] of apiRoutes) {
          injectRoute({
            pattern: `${apiPath}${suffix}`,
            entrypoint: `@taproot/astro/api/${file}.ts`,
            prerender: false,
          });
        }

        if (options.publicRoutes) {
          injectRoute({
            pattern: '/[...path]',
            entrypoint: '@taproot/astro/admin/pages/public-catchall.astro',
            prerender: false,
          });
        }

        logger.info(`admin at ${adminPath}, API at ${apiPath}`);
      },

      'astro:config:done': ({ logger }) => {
        if (process.env.NODE_ENV !== 'production' && process.env.TAPROOT_DEV_AUTH === '1') {
          logger.warn(
            'Development credential sign-in is ENABLED (TAPROOT_DEV_AUTH=1). This is local-only; ' +
              'the app refuses to boot with it set outside development.',
          );
        }
      },
    },
  };
}

function normalizeBase(path: string): string {
  const trimmed = `/${path}`.replace(/\/+/g, '/').replace(/\/+$/, '');
  return trimmed === '' ? '/admin' : trimmed;
}

export type { TaprootContext } from './runtime/context.js';
