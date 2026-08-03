// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
import starlight from '@astrojs/starlight';

/**
 * The Taproot handbook.
 *
 * A separate app rather than pages inside `apps/web`, because the demo site is a *demo* — it is
 * what a Taproot deployment looks like, and stapling the product's documentation into it would
 * make the reference consumer stop being one. It also means the handbook builds and deploys on its
 * own, with no database and no admin panel.
 *
 * Static by default (no `output: 'server'`), which is the point of the split: documentation has no
 * request-time behaviour and should cost nothing to serve.
 */
export default defineConfig({
  /**
   * No `site` is set, and the build says so on every run:
   * `[@astrojs/sitemap] The Sitemap integration requires the site astro.config option. Skipping.`
   *
   * That warning is expected rather than outstanding. A sitemap has to name absolute URLs, and this
   * handbook ships with the CMS rather than with any one installation of it — guessing a domain
   * would produce a sitemap pointing at somebody else's site, which is worse than no sitemap.
   * Whoever publishes the handbook sets `site` to their own origin and the warning goes with it.
   */

  /**
   * The passthrough image service, deliberately.
   *
   * Astro's default image service is `sharp`, which is a native dependency — and "zero native
   * dependencies" is a standing constraint of this repo, not a preference: `npm install` must never
   * need a C++ toolchain. The handbook's images are screenshots and diagrams that need no
   * request-time transform, so passthrough costs nothing and keeps `npm install` toolchain-free for
   * everybody who clones this to read the docs.
   */
  image: { service: passthroughImageService() },

  integrations: [
    starlight({
      title: 'Taproot',
      description:
        'A DB-backed, Astro-native CMS. How to write content in it, administer it, and run it.',
      /**
       * No `editLink`, `social`, or `favicon` here on purpose.
       *
       * Those all name a specific deployment — a repository URL, an organisation's accounts — and
       * this handbook ships with the CMS rather than with any one installation of it. A link to
       * somebody else's GitHub is worse than no link.
       */
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What Taproot is', slug: 'index' },
            { label: 'Signing in', slug: 'start/signing-in' },
            { label: 'Finding your way around', slug: 'start/the-admin' },
            { label: 'What your role can do', slug: 'start/roles' },
          ],
        },
        {
          label: 'Writing content',
          items: [
            { label: 'Content items', slug: 'content/items' },
            { label: 'The fields you will meet', slug: 'content/fields' },
            { label: 'Rich text', slug: 'content/rich-text' },
            { label: 'Blocks', slug: 'content/blocks' },
            { label: 'Reusable blocks', slug: 'content/reusable-blocks' },
            { label: 'Images and files', slug: 'content/media' },
            { label: 'Tags and categories', slug: 'content/taxonomies' },
            { label: 'Search engines and social cards', slug: 'content/seo' },
            { label: 'Accessibility', slug: 'content/accessibility' },
            { label: 'Revision history', slug: 'content/revisions' },
          ],
        },
        {
          label: 'Publishing',
          items: [
            { label: 'The publishing workflow', slug: 'publishing/workflow' },
            { label: 'Scheduling a page', slug: 'publishing/scheduling' },
            { label: 'Releases', slug: 'publishing/releases' },
            { label: 'URLs and redirects', slug: 'publishing/urls' },
          ],
        },
        {
          /**
           * The developer half, added after the standalone split.
           *
           * The handbook was originally scoped at editors, admins, and operators — correct while
           * Taproot was one embedded app with no consumer to build. Once the delivery API became
           * the product's whole external surface, the half nobody could use from the docs was this
           * one.
           */
          label: 'Building a site',
          items: [
            { label: 'Getting started', slug: 'build/getting-started' },
            { label: 'The client', slug: 'build/the-client' },
            { label: 'Rendering a page', slug: 'build/rendering-a-page' },
            { label: 'Blocks', slug: 'build/blocks' },
            { label: 'Images and media', slug: 'build/images' },
            { label: 'Menus and term URLs', slug: 'build/menus' },
            { label: 'Preview and types', slug: 'build/preview-and-types' },
          ],
        },
        {
          label: 'Running the site',
          items: [
            { label: 'Content types', slug: 'admin/content-types' },
            { label: 'Block types', slug: 'admin/block-types' },
            { label: 'Menus', slug: 'admin/menus' },
            { label: 'Branding', slug: 'admin/branding' },
            { label: 'People and access', slug: 'admin/users' },
            { label: 'API keys', slug: 'admin/api-keys' },
            { label: 'Two-factor authentication', slug: 'admin/two-factor' },
            { label: 'The audit log', slug: 'admin/audit-log' },
          ],
        },
        {
          label: 'Operating Taproot',
          items: [
            { label: 'Installing it', slug: 'operate/install' },
            { label: 'Settings and environment', slug: 'operate/configuration' },
            { label: 'Email', slug: 'operate/email' },
            { label: 'The scheduler', slug: 'operate/scheduler' },
            { label: 'Deploying', slug: 'operate/deploying' },
            { label: 'Backups and recovery', slug: 'operate/backups' },
          ],
        },
        { label: 'When something is wrong', slug: 'troubleshooting' },
      ],
    }),
  ],
});
