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
/**
 * Routes audited without a session.
 *
 * `/admin/set-password` is here with a deliberately invalid token: the valid-token branch needs a
 * token that only exists for one use, and the invalid branch is the one an audit can reach
 * repeatably. The form itself reuses the same markup as `/admin/setup`, which is audited in full.
 *
 * Three routes are *not* here and cannot be, each because it is unreachable in the environment the
 * audit runs against:
 *
 *  - `/admin/setup` redirects the moment any user exists, and the audit runs seeded.
 *  - `/admin/verify` needs a live sign-in challenge, which needs an account with two-factor
 *    enrolled, which the seed deliberately does not create — a demo that demands an authenticator
 *    app to sign in is a demo nobody can open.
 *  - `/admin/forgot-password` renders only where a mailer can deliver, and `npm run dev` has none
 *    on purpose. The gate is read by the dev server's own environment, so this script cannot open
 *    it. **To audit it: put any `TAPROOT_MAIL_WEBHOOK_URL` in `apps/web/.env`, restart the dev
 *    server, and add `/admin/forgot-password` and `/admin/forgot-password?sent=1` below.** Both
 *    were checked that way when the page was written and passed; they are not checked on every run.
 *
 * All three render the same shapes this file does cover: labelled inputs, a described field, one
 * submit. That is not the same as covering them on every run, which is worth knowing.
 */
const ANONYMOUS_ROUTES = ['/admin/login', '/admin/set-password?token=not-a-real-token'];

const ROUTES = [
  '/admin',
  '/admin/content',
  '/admin/content/new',
  '/admin/settings/types',
  '/admin/settings/types/new',
  '/admin/settings/blocks',
  '/admin/settings/blocks/new',
  '/admin/settings/users',
  '/admin/settings/audit',
  '/admin/account',
  '/admin/settings/system',
  '/admin/media',
  '/admin/blocks',
  '/admin/taxonomies',
  '/admin/menus',
  '/admin/settings/redirects',
  '/admin/releases',
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
const itemsResponse = await fetch(`${base}/api/taproot/items?limit=100`, { headers: { cookie } });
const { items } = await itemsResponse.json();

const typesResponse = await fetch(`${base}/api/taproot/content-types`, { headers: { cookie } });
const { contentTypes } = await typesResponse.json();
if (contentTypes?.[0]) ROUTES.push(`/admin/settings/types/${contentTypes[0].id}`);

/**
 * The item editor is audited on the item with the *most* fields, not the first one returned.
 *
 * Taking `items[0]` meant taking the alphabetically-first path, which was the weather-banner
 * singleton — three fields, all of them plain inputs. Every custom control in the admin lives in
 * the field types that screen does not have, so the densest editor was the one route never
 * audited, and seven inert labels sat there through four phases. Picking by field count makes this
 * track the content model rather than whatever the seed happens to sort first.
 *
 * Field counts come from a request per type because the list endpoint returns types without their
 * fields — a detail worth stating, since deriving the count from the list silently yields zero for
 * everything and restores exactly the bug this replaced.
 */
const fieldCounts = await Promise.all(
  (contentTypes ?? []).map(async (type) => {
    const response = await fetch(`${base}/api/taproot/content-types/${type.id}/fields`, {
      headers: { cookie },
    });
    const { fields } = await response.json();
    return [type.id, (fields ?? []).length];
  }),
);
const fieldCountByType = new Map(fieldCounts);

const richestItem = (items ?? [])
  .slice()
  .sort(
    (a, b) =>
      (fieldCountByType.get(b.content_type_id) ?? 0) - (fieldCountByType.get(a.content_type_id) ?? 0),
  )[0];
if (richestItem) ROUTES.push(`/admin/content/${richestItem.id}`);

// One block type's field builder. Block types are excluded from the content-types endpoint on
// purpose, so the id comes from the listing page rather than the API.
const blocksHtml = await (await fetch(`${base}/admin/settings/blocks`, { headers: { cookie } })).text();
const firstBlockId = blocksHtml.match(/blocks\/([0-9a-f-]{36})/)?.[1];
if (firstBlockId) ROUTES.push(`/admin/settings/blocks/${firstBlockId}`);

// One per-type content list and one singleton, since each content type is now its own destination
// and the two render quite differently.
const listable = (contentTypes ?? []).filter((type) => type.kind !== 'singleton');
const singleton = (contentTypes ?? []).find((type) => type.kind === 'singleton');
if (listable[0]) ROUTES.push(`/admin/content/type/${listable[0].api_id}`);
if (singleton) ROUTES.push(`/admin/singleton/${singleton.api_id}`);

// The media detail screen: the hotspot editor's server-rendered shell plus the alt-text form.
// The editor's hydrated state is covered by HotspotEditor.test.tsx, which axe cannot reach here.
const mediaResponse = await fetch(`${base}/api/taproot/media?limit=1`, { headers: { cookie } });
const { media } = await mediaResponse.json();
if (media?.[0]) ROUTES.push(`/admin/media/${media[0].id}`);

// One reusable block's editor, which renders the block type's own fields plus a usage list.
const reusableResponse = await fetch(`${base}/api/taproot/reusable-blocks`, { headers: { cookie } });
const { reusableBlocks } = await reusableResponse.json();
if (reusableBlocks?.[0]) ROUTES.push(`/admin/blocks/${reusableBlocks[0].id}`);

// The term editor is the densest screen in the admin — a repeated form per row — so it is the one
// most worth auditing, and it only exists once a taxonomy does.
const taxonomiesResponse = await fetch(`${base}/api/taproot/taxonomies`, { headers: { cookie } });
const { taxonomies } = await taxonomiesResponse.json();
if (taxonomies?.[0]) ROUTES.push(`/admin/taxonomies/${taxonomies[0].id}`);

// The menu editor carries three add-forms plus a form per item, which makes it the densest
// screen in the admin and the most likely to repeat an accessible name.
const menusResponse = await fetch(`${base}/api/taproot/menus`, { headers: { cookie } });
const { menus } = await menusResponse.json();
if (menus?.[0]) ROUTES.push(`/admin/menus/${menus[0].id}`);

/**
 * A release with content in it, and the item editor opened in release mode.
 *
 * The release chosen is the one with the most items, for the same reason the item editor is chosen
 * by field count rather than alphabetically: a release with nothing in it renders an empty state
 * and misses every per-item form, the conflict notes, and the publish controls — which is all of
 * the screen worth auditing. The seed ships one with two items so this is never a no-op.
 *
 * Release mode matters separately because it swaps a whole panel of the item editor: the status
 * buttons and the schedule field are replaced by the staged-version panel, and none of that markup
 * is reachable from `/admin/content/{id}` on its own.
 */
const releasesResponse = await fetch(`${base}/api/taproot/releases`, { headers: { cookie } });
const { releases } = await releasesResponse.json();
const fullestRelease = (releases ?? [])
  .slice()
  .sort((a, b) => (b.itemCount ?? 0) - (a.itemCount ?? 0))[0];

if (fullestRelease) {
  ROUTES.push(`/admin/releases/${fullestRelease.id}`);

  const detail = await fetch(`${base}/api/taproot/releases/${fullestRelease.id}`, {
    headers: { cookie },
  });
  const { items: staged } = await detail.json();
  if (staged?.[0]) {
    ROUTES.push(
      `/admin/content/${staged[0].content_item_id}?release=${fullestRelease.id}`,
    );
  }
}

/**
 * Elements a `<label for>` may point at, per the HTML spec's "labelable elements".
 *
 * `div`, `ol`, `fieldset`, and `p` are not among them, which is the whole point of checking: a
 * label pointing at one of those is silently inert.
 */
const LABELABLE = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);

/**
 * Every `<label for>` must point at an element that exists *and* can be labelled.
 *
 * axe does not check this — its `label` rule asks whether a form control has a name, not whether a
 * label has a target, so a label pointing at a `<div>` passes every rule while doing nothing. The
 * failure is quiet by construction: the control is still named through `aria-labelledby`, so a
 * screen reader sounds correct and only the click-to-focus behaviour is missing.
 *
 * It is checked here rather than in a component test because the mistake is not specific to any
 * one component — it is what happens whenever a custom control replaces a plain input and the
 * label above it is left alone.
 */
function brokenLabels(document) {
  const broken = [];

  for (const label of document.querySelectorAll('label[for]')) {
    const id = label.getAttribute('for');
    const target = document.getElementById(id);
    const text = (label.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

    if (!target) {
      broken.push(`"${text}" → for="${id}" matches no element`);
    } else if (!LABELABLE.has(target.tagName.toLowerCase())) {
      broken.push(`"${text}" → for="${id}" points at <${target.tagName.toLowerCase()}>, not labelable`);
    }
  }

  return broken;
}

let totalViolations = 0;
let totalBrokenLabels = 0;
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
  const labels = brokenLabels(window.document);
  totalViolations += violations.length;
  totalBrokenLabels += labels.length;
  summary.push({ route, status: response.status, violations });

  const mark = violations.length === 0 && labels.length === 0 ? 'PASS' : 'FAIL';
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

  for (const broken of labels) {
    console.log(`      [label] ${broken}`);
  }

  window.close();
}

console.log(
  `\n${summary.length} routes audited, ${totalViolations} violation type(s) and ` +
    `${totalBrokenLabels} inert label(s) found (colour contrast checked separately).`,
);

process.exit(totalViolations === 0 && totalBrokenLabels === 0 ? 0 : 1);
