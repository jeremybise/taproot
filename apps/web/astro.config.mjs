// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

/**
 * The reference consumer.
 *
 * Note what is *not* here: no Taproot integration, no database adapter, no D1 or R2 binding, no
 * admin panel. This app holds an API key and reads content over HTTP, which is the whole of the
 * contract — and it lives in this monorepo so a drift between the two halves fails `npm test` here
 * rather than surfacing in somebody else's project.
 *
 * `output: 'server'` because content is resolved per request against the CMS. A site wanting a
 * static build would fetch at build time instead; the client is the same either way, which is the
 * point of the delivery API being plain HTTP.
 */
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  devToolbar: { enabled: false },
  vite: {
    // @taprootcms/astro is workspace source; pre-bundling it adds nothing and makes edits require a
    // dev-server restart.
    optimizeDeps: { exclude: ['@taprootcms/astro'] },
  },
});
