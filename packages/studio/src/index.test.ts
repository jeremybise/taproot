import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { AstroIntegration } from 'astro';

import taproot from './index.js';

/**
 * The integration entry: what Taproot mounts, and where.
 *
 * Routes are injected rather than being files on disk, so this table *is* the route map — there is
 * no directory listing that would show a missing screen. These tests hold the two properties that
 * are easy to break by accident and invisible when broken: that the admin stays under its own
 * segment, and that nothing serves public content from the CMS deployment.
 */

interface Injected {
  pattern: string;
  entrypoint: string;
}

/**
 * Run `astro:config:setup` against a stub and collect what it did.
 *
 * Astro is not involved — the hook only reads `config.root`, `config.output`, and `command`, and
 * everything else it receives it merely calls. A real Astro build to observe a route table would be
 * slower and would test Astro.
 */
function setup(options: Parameters<typeof taproot>[0] = {}) {
  const integration: AstroIntegration = taproot(options);
  const routes: Injected[] = [];
  const configs: Record<string, unknown>[] = [];
  const middleware: string[] = [];

  const hook = integration.hooks['astro:config:setup'];
  if (!hook) throw new Error('The integration registered no config hook.');

  (hook as (args: Record<string, unknown>) => void)({
    injectRoute: (route: Injected) => routes.push(route),
    addMiddleware: ({ entrypoint }: { entrypoint: string }) => middleware.push(entrypoint),
    updateConfig: (config: Record<string, unknown>) => configs.push(config),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    /**
     * Any real absolute directory will do — the hook reads `.env` files from it and tolerates their
     * absence. Built with `pathToFileURL` rather than a literal `file:///…`, because on Windows a
     * path without a drive letter is not absolute and `fileURLToPath` rejects it.
     */
    config: { root: pathToFileURL(`${process.cwd()}/`), output: 'server' },
    command: 'dev',
  });

  return { routes, configs, middleware };
}

describe('adminPath', () => {
  it('defaults every admin screen to /admin', () => {
    const { routes } = setup();
    const admin = routes.filter((route) => !route.entrypoint.includes('/api/'));

    expect(admin.length).toBeGreaterThan(20);
    expect(admin.every((route) => route.pattern === '/admin' || route.pattern.startsWith('/admin/'))).toBe(true);
  });

  it('moves them together when it is changed', () => {
    const { routes } = setup({ adminPath: '/cms' });
    const admin = routes.filter((route) => !route.entrypoint.includes('/api/'));

    expect(admin.every((route) => route.pattern === '/cms' || route.pattern.startsWith('/cms/'))).toBe(true);
    // The API does not follow it. It is a separate contract with its own callers, and moving it
    // would break every consumer whose key is already configured.
    expect(routes.some((route) => route.pattern.startsWith('/api/taproot/'))).toBe(true);
  });

  it('refuses the root instead of quietly substituting /admin', () => {
    // The old behaviour handed back `/admin` for `'/'`, so an operator who asked for a root-mounted
    // admin got a different path and no sign anything had been ignored.
    expect(() => taproot({ adminPath: '/' })).toThrow(/cannot be '\/'/);
    expect(() => taproot({ adminPath: '///' })).toThrow(/cannot be '\/'/);
  });

  it('tolerates a trailing slash and doubled separators', () => {
    const { routes } = setup({ adminPath: '//cms//' });
    expect(routes.some((route) => route.pattern === '/cms')).toBe(true);
    expect(routes.some((route) => route.pattern.startsWith('/cms//'))).toBe(false);
  });
});

describe('the root', () => {
  it('redirects to the admin rather than 404ing', () => {
    const { configs } = setup();
    const redirects = configs.find((config) => config.redirects)?.redirects;

    expect(redirects).toEqual({ '/': { status: 302, destination: '/admin' } });
  });

  it('follows adminPath', () => {
    const { configs } = setup({ adminPath: '/cms' });
    const redirects = configs.find((config) => config.redirects)?.redirects as Record<string, unknown>;

    expect(redirects['/']).toEqual({ status: 302, destination: '/cms' });
  });

  it('is a 302, because adminPath can change', () => {
    // A 301 is cached by browsers indefinitely. An operator who later moved the admin would have
    // visitors bouncing to a path that no longer exists, with no way to tell them to stop.
    const { configs } = setup();
    const redirects = configs.find((config) => config.redirects)?.redirects as Record<
      string,
      { status: number }
    >;

    expect(redirects['/']!.status).toBe(302);
  });
});

describe('public content', () => {
  it('is served by nothing here', () => {
    /**
     * The CMS deployment serves the admin and the API. A `publicRoutes` option used to inject a
     * catch-all that read the database directly and rendered fields as headings and paragraphs —
     * no blocks, no reusable-block dereferencing, and `item.seo` raw so no SEO fallbacks applied.
     * That is the second read path SCOPE rules out, and it had already drifted from the first.
     */
    const { routes } = setup();

    expect(routes.some((route) => route.pattern.includes('[...path]'))).toBe(false);
    expect(routes.every((route) => route.pattern.startsWith('/admin') || route.pattern.startsWith('/api/taproot'))).toBe(true);
  });

  it('is not resurrected by an unknown option', () => {
    // `publicRoutes: true` is not in `TaprootOptions` any more; a config still carrying it should
    // be inert rather than finding a code path that still honours it.
    const { routes } = setup({ publicRoutes: true } as Parameters<typeof taproot>[0]);

    expect(routes.some((route) => route.pattern.includes('[...path]'))).toBe(false);
  });
});

describe('the delivery API', () => {
  it('is mounted under its own namespace, apart from the admin REST API', () => {
    // Different callers: the admin routes edit one thing at a time for a signed-in person, these
    // answer a whole page for a machine holding a scoped key.
    const { routes } = setup();
    const delivery = routes.filter((route) => route.pattern.startsWith('/api/taproot/delivery/'));

    expect(delivery.map((route) => route.pattern).sort()).toEqual([
      '/api/taproot/delivery/items',
      '/api/taproot/delivery/menu/[apiId]',
      '/api/taproot/delivery/resolve',
      '/api/taproot/delivery/schema',
    ]);
  });
});
