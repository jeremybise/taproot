import { handle } from '@astrojs/cloudflare/handler';
import { scheduled } from '@taproot/astro/runtime/worker';

/**
 * The deployed Worker.
 *
 * `@astrojs/cloudflare` supplies its own entry when the wrangler config names no `main`, and that
 * entry is exactly `{ fetch: handle }` — nothing more. Naming this file as `main` therefore costs
 * the adapter's behaviour nothing and buys a `scheduled` export, which is the only way a Cloudflare
 * cron trigger can reach the scheduled-publishing sweep.
 *
 * Without it the sweep needs a second Worker and `TAPROOT_CRON_SECRET` to authenticate the hop
 * between them. `POST /api/taproot/scheduler/run` still exists for platforms that have no cron of
 * their own, but nothing on Cloudflare needs it.
 */
export default { fetch: handle, scheduled };
