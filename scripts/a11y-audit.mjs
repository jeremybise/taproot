/**
 * Accessibility audit for the admin screens.
 *
 * The scope doc treats admin-UI accessibility as a per-phase acceptance criterion, so this is a
 * script rather than a one-off check — it should be re-run as each phase adds screens.
 *
 * Runs axe-core against the server-rendered HTML of every admin route. Structural rules (labels,
 * landmarks, heading order, table semantics, ARIA validity) are what this catches, and those are
 * the ones hand-built admin UI actually fails.
 *
 * Two known limits, stated rather than hidden:
 *  - Colour contrast is skipped: jsdom does not compute layout or resolve CSS custom properties,
 *    so axe cannot measure it here. `npm run a11y:contrast` checks the design tokens directly.
 *  - React islands are audited in their server-rendered state. Their post-hydration behaviour
 *    (focus moves, live-region announcements) needs a real browser and is verified by hand.
 *
 * Usage: node scripts/a11y-audit.mjs [baseUrl]
 * Requires a running dev server and the seeded admin credentials.
 */
import { JSDOM } from 'jsdom';
import axe from 'axe-core';

const base = process.argv[2] ?? 'http://localhost:4321';

/** Routes audited signed out. The login page redirects to the dashboard if a session exists. */
const ANONYMOUS_ROUTES = ['/admin/login'];

const ROUTES = [
  '/admin',
  '/admin/content',
  '/admin/content/new',
  '/admin/types',
  '/admin/types/new',
  '/admin/media',
  '/admin/taxonomies',
  '/admin/redirects',
  '/admin/settings',
];

// Sign in so the authenticated screens can be fetched.
const loginResponse = await fetch(`${base}/api/taproot/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
  body: new URLSearchParams({
    email: 'admin@example.com',
    password: 'taproot',
    redirectTo: '/admin',
  }),
  redirect: 'manual',
});

const cookie = (loginResponse.headers.get('set-cookie') ?? '').split(';')[0];
if (!cookie.startsWith('taproot_session=')) {
  console.error('Could not sign in. Is the dev server running and the database seeded?');
  process.exit(1);
}

// Add the dynamic content and type editors, which only exist once there is data to point at.
const itemsResponse = await fetch(`${base}/api/taproot/items?limit=1`, { headers: { cookie } });
const { items } = await itemsResponse.json();
if (items?.[0]) ROUTES.push(`/admin/content/${items[0].id}`);

const typesResponse = await fetch(`${base}/api/taproot/content-types`, { headers: { cookie } });
const { contentTypes } = await typesResponse.json();
if (contentTypes?.[0]) ROUTES.push(`/admin/types/${contentTypes[0].id}`);

// The term editor is the densest screen in the admin — a repeated form per row — so it is the one
// most worth auditing, and it only exists once a taxonomy does.
const taxonomiesResponse = await fetch(`${base}/api/taproot/taxonomies`, { headers: { cookie } });
const { taxonomies } = await taxonomiesResponse.json();
if (taxonomies?.[0]) ROUTES.push(`/admin/taxonomies/${taxonomies[0].id}`);

let totalViolations = 0;
const summary = [];

for (const route of [...ANONYMOUS_ROUTES, ...ROUTES]) {
  const anonymous = ANONYMOUS_ROUTES.includes(route);
  const response = await fetch(`${base}${route}`, {
    headers: anonymous ? {} : { cookie },
  });
  const html = await response.text();

  const dom = new JSDOM(html, {
    url: `${base}${route}`,
    pretendToBeVisual: true,
    // `outside-only` gives us `window.eval` to inject axe, without executing the page's own
    // scripts — we want to audit the server-rendered markup, not a half-hydrated React tree.
    runScripts: 'outside-only',
  });
  const { window } = dom;

  // axe-core expects the globals of the document it is auditing.
  window.eval(axe.source);

  const results = await window.axe.run(window.document, {
    resultTypes: ['violations'],
    rules: {
      // jsdom cannot compute colour, so this rule can only produce noise here.
      'color-contrast': { enabled: false },
    },
  });

  const violations = results.violations ?? [];
  totalViolations += violations.length;
  summary.push({ route, status: response.status, violations });

  const mark = violations.length === 0 ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${route}  (${response.status})`);

  for (const violation of violations) {
    console.log(`      [${violation.impact}] ${violation.id} — ${violation.help}`);
    for (const node of violation.nodes.slice(0, 3)) {
      console.log(`        ${node.html.slice(0, 110).replace(/\s+/g, ' ')}`);
    }
    if (violation.nodes.length > 3) {
      console.log(`        …and ${violation.nodes.length - 3} more`);
    }
  }

  window.close();
}

console.log(
  `\n${summary.length} routes audited, ${totalViolations} violation type(s) found ` +
    `(colour contrast checked separately).`,
);

process.exit(totalViolations === 0 ? 0 : 1);
