// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import cloudflare from '@astrojs/cloudflare';

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
 *
 * **Two targets, the same switch `apps/studio` uses.** Taproot has no stake in where a site is
 * deployed — the handbook says so, and the delivery API being plain HTTP is what makes it true — so
 * Node stays the default and nothing here is required of anybody. What a Cloudflare target buys is
 * that the caching this app declares can actually be *exercised*: `s-maxage` on an HTML response
 * does nothing until a shared cache is in front of it, and for four phases nothing here could put
 * one there. A header that has never been observed working is a header nobody has tested.
 */
const isDev = process.argv.includes('dev');
const target = process.env.TAPROOT_TARGET ?? 'node';

export default defineConfig({
  output: 'server',
  adapter: target === 'cloudflare' && !isDev ? cloudflare() : node({ mode: 'standalone' }),
  devToolbar: { enabled: false },
  vite: {
    // Fail on a busy 4323 rather than drifting to the next free port, for the reason apps/studio
    // does: the studio's TAPROOT_SITE_URL names this address, so a consumer that quietly moved is
    // an editor pressing Preview and framing nothing.
    server: { strictPort: true },
    // @taprootcms/astro is workspace source; pre-bundling it adds nothing and makes edits require a
    // dev-server restart.
    optimizeDeps: { exclude: ['@taprootcms/astro'] },
  },
});
