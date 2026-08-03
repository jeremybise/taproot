// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import cloudflare from '@astrojs/cloudflare';
import taproot from '@taprootcms/studio';

/**
 * The CMS deployment.
 *
 * This app owns the database, the admin panel, the REST API, the delivery API, and the scheduler.
 * It is the thing an operator deploys and upgrades; the site that shows the content is `apps/web`,
 * which holds an API key and talks to this over HTTP.
 *
 * Adapter split: Node for `astro dev`, Cloudflare for builds and deploys.
 *
 * `@astrojs/cloudflare` v14 runs SSR inside workerd during dev via @cloudflare/vite-plugin. That is
 * excellent for parity, but workerd has no `node:sqlite`, so the local database would have to be
 * Miniflare's emulated D1 — whose file lives at an undocumented internal path that the seed and
 * migrate scripts cannot reliably write to. That would mean no `npm run db:seed` without a running
 * dev server, which breaks the zero-setup requirement.
 *
 * So: develop against Node + a plain SQLite file, deploy to Workers + D1. The data layer is
 * portable by design and both dialects are unit-tested, so this split costs less than it looks.
 * `npm run preview` builds with the Cloudflare adapter and serves it through wrangler when you want
 * the real runtime.
 */
const isDev = process.argv.includes('dev');
const target = process.env.TAPROOT_TARGET ?? (isDev ? 'node' : 'cloudflare');

export default defineConfig({
  output: 'server',
  adapter: target === 'node' ? node({ mode: 'standalone' }) : cloudflare(),
  integrations: [taproot()],
  devToolbar: { enabled: false },
  vite: {
    // Kysely and the core package are workspace source; pre-bundling them adds nothing and makes
    // edits require a dev-server restart.
    optimizeDeps: { exclude: ['@taprootcms/core', '@taprootcms/studio'] },
    build: {
      rollupOptions: {
        output: {
          /**
           * Keep all of Kysely in one chunk.
           *
           * Left to itself the bundler splits Kysely's SQLite dialect away from its core and the
           * two chunks import each other — `sqlite-adapter` needs `DefaultQueryCompiler` and
           * `DialectAdapterBase`, while the core chunk needs `SqliteAdapter` back. Node tolerates
           * that cycle; workerd evaluates it in an order where the base class is still undefined
           * when its subclass is declared, and refuses the upload with
           * `Class extends value undefined is not a constructor or null` (error 10021) — at
           * deploy time, after a build that reported success.
           *
           * One chunk means no inter-chunk cycle to order wrongly. This is why `npm run preview`
           * exists: it is the only local command that evaluates the bundle in the real runtime.
           */
          manualChunks(id) {
            if (id.includes('node_modules/kysely')) return 'kysely';
          },
        },
      },
    },
  },
});
