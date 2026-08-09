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

/**
 * Extra cookies for particular routes, keyed by their entry in `ROUTES`.
 *
 * Some admin state lives in a cookie read on the server rather than in the URL — the theme, and the
 * item editor's preview pane — so auditing the other state means sending a different cookie rather
 * than fetching a different address. Where the same path is audited twice, the second entry carries
 * a `#fragment` to tell them apart: a fragment is never sent to a server, so it labels the row in
 * the summary without changing the request.
 */
const EXTRA_COOKIES = new Map();

const ROUTES = [
  '/admin',
  '/admin/content',
  '/admin/content/new',
  /**
   * The accessibility report itself, which would be a memorable thing to leave unaudited.
   *
   * Both shapes are worth a look and the seed gives them: `?all=1` widens the scan past what the
   * public can see, and it is the wider one that actually renders the issue list — a filter chain
   * plus a repeated pattern of nested lists per item.
   */
  '/admin/accessibility',
  '/admin/accessibility?all=1',
  '/admin/settings/types',
  '/admin/settings/types/new',
  '/admin/settings/blocks',
  '/admin/settings/blocks/new',
  '/admin/settings/users',
  /**
   * Audited with at least one key present, which the block below creates if there is none.
   *
   * An empty API-keys screen is a create form and an empty state; the interesting markup — the
   * per-key revoke form with its own labelled confirmation input, repeated per row — only exists
   * once a key does. Auditing the empty version would pass and check nothing.
   */
  '/admin/settings/api-keys',
  '/admin/settings/audit',
  /*
   * Worth auditing rather than assuming, because it is two data tables and a filter form — and the
   * seed gives it rows, so the audit sees the populated version rather than the empty state. An
   * empty table passes every rule it has no cells to break.
   */
  '/admin/settings/search',
  '/admin/account',
  '/admin/settings/system',
  '/admin/media',
  '/admin/blocks',
  '/admin/snippets',
  '/admin/snippets/new',
  '/admin/taxonomies',
  '/admin/menus',
  '/admin/settings/redirects',
  '/admin/settings/branding',
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
 * One settings screen **per kind**, because parts of that form exist only for one of them.
 *
 * `contentTypes[0]` is whatever sorts first, and the screen renders a different set of controls per
 * kind — a collection gets the URL prefix and the "items have their own pages" checkbox, a singleton
 * gets the preview path. Auditing only the first type means whichever kind happens to sort second is
 * never checked, and the run still reports zero. The same mistake as taking `items[0]` for the item
 * editor, one screen along.
 *
 * It has now been made three times, which is why this is a loop over the kinds rather than a second
 * hand-written `find`: the seeded database sorts `page` first, so the collection form — two controls,
 * one of them added long after this comment was written — had never been audited once.
 *
 * A kind the seed happens not to have is skipped silently: a missing route is not a violation, and
 * pushing a URL that 404s would fail the run for the wrong reason.
 */
for (const kind of ['collection', 'singleton']) {
  const example = (contentTypes ?? []).find((type) => type.kind === kind);
  if (example && example.id !== contentTypes?.[0]?.id) {
    ROUTES.push(`/admin/settings/types/${example.id}`);
  }
}

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

/**
 * And the items with the most *composed* rows, which field count does not find.
 *
 * Picking by field count fixed one version of this trap and left another: a content type can
 * declare a dozen fields while the item stored against it has no blocks placed and no repeater
 * entries, so the block list and the repeater render their empty states and every collapsible panel
 * — with the fields inside it — is absent from the run. Measured on the seeded database: the
 * field-count winner had **zero** of either, while blocks and repeater rows lived on three other
 * items entirely.
 *
 * The two envelopes are counted separately on purpose. They sit on different items here, so one
 * combined "most composed" score picks the block-heavy page and leaves repeater rows unaudited —
 * the same one-axis mistake one level down.
 */
function composedRows(value, depth = 0) {
  // Deep enough for a block inside a block inside a repeater row; `MAX_BLOCK_DEPTH` is 5.
  if (depth > 6 || !value || typeof value !== 'object') return { blocks: 0, rows: 0 };

  const total = { blocks: 0, rows: 0 };
  const add = (part) => {
    total.blocks += part.blocks;
    total.rows += part.rows;
  };

  if (Array.isArray(value)) {
    for (const entry of value) {
      // A block instance is `{id, type, data}` and a repeater row is `{id, data}` — the absence of
      // `type` is what tells them apart, and both are what renders as a collapsible panel.
      if (entry && typeof entry === 'object' && 'id' in entry && 'data' in entry) {
        if ('type' in entry) total.blocks += 1;
        else total.rows += 1;
      }
      add(composedRows(entry, depth + 1));
    }
    return total;
  }

  for (const entry of Object.values(value)) add(composedRows(entry, depth + 1));
  return total;
}

for (const envelope of ['blocks', 'rows']) {
  const best = (items ?? [])
    .slice()
    .sort((a, b) => composedRows(b.data)[envelope] - composedRows(a.data)[envelope])[0];

  // Skipped silently when the seed composes nothing of that kind: a missing route is not a
  // violation, and an item with an empty block list is exactly what this block exists to avoid.
  if (!best || composedRows(best.data)[envelope] === 0) continue;
  const route = `/admin/content/${best.id}`;
  if (!ROUTES.includes(route)) ROUTES.push(route);
}

/**
 * The same editor with its live preview pane open.
 *
 * Worth a second visit because the pane changes the editor's whole structure — the sidebar panels
 * move into a narrow rail, a sticky Save strip appears, and the pane contributes a toolbar with an
 * address input and two button groups. None of that markup exists on the route above.
 *
 * The pane is a `client:load` island, so what is audited here is its *server-rendered* markup: the
 * toggle, the toolbar, and the labels. jsdom runs with `runScripts: 'outside-only'`, so nothing
 * hydrates and no state reachable only by interaction is covered — the iframe itself never appears,
 * because no token is minted until after hydration. `PreviewPane.test.tsx` is what covers the rest.
 *
 * Opened by cookie rather than by a query parameter, because that is how the admin stores it: the
 * layout reads it server-side so the container is the right width in the first HTML the browser
 * parses.
 */
if (richestItem) {
  const route = `/admin/content/${richestItem.id}#preview-open`;
  ROUTES.push(route);
  EXTRA_COOKIES.set(route, 'taproot_preview_pane=open');
}

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

/*
 * One snippet's editor.
 *
 * Worth auditing separately from the create screen rather than assuming they match: the two share
 * `SnippetFields.astro`, but the edit screen renders `api_id` as a **read-only `<p>`** where the
 * create screen renders an `<input>`. A `<label for>` pointing at that `<p>` would be silently inert
 * — announced correctly, and broken only for click-to-focus — which is exactly the class of defect
 * the audit's inert-label check exists for and inspection does not catch.
 */
const snippetsResponse = await fetch(`${base}/api/taproot/snippets`, { headers: { cookie } });
const { snippets } = await snippetsResponse.json();
if (snippets?.[0]) ROUTES.push(`/admin/snippets/${snippets[0].id}`);

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
/**
 * Ensure the API-keys screen has a key on it.
 *
 * The audit runs against the seeded database, which has none — and the per-key revoke form is the
 * part of that screen worth checking, since it repeats a labelled input per row and is exactly
 * where a duplicated accessible name would appear.
 */
const existingKeys = await (
  await fetch(`${base}/api/taproot/api-keys`, { headers: { cookie } })
).json();

if ((existingKeys.apiKeys ?? []).length === 0) {
  await fetch(`${base}/api/taproot/api-keys`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ label: 'Accessibility audit', scopes: ['content:read'] }),
  });
}

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

/**
 * Reflow hazards — WCAG 2.1 SC 1.4.10, Level AA.
 *
 * Reflow says content must be usable at a width equivalent to 320 CSS px without scrolling in two
 * dimensions. **The axe run above cannot see it, and neither can anything else in this file.** jsdom
 * computes no layout: `getBoundingClientRect()` returns zeros, `scrollWidth` is always 0, media
 * queries never evaluate, and this script does not pass `resources: 'usable'`, so the stylesheet is
 * never fetched — every Tailwind class here is an inert string.
 *
 * Same bargain `a11y-contrast.mjs` makes: the thing cannot be measured, so known hazards are checked
 * directly rather than assumed absent. **It does not prove reflow.** Only a real browser can, and
 * this repo has none — no Playwright, no Puppeteer, no CI. Verify by hand at 320px before calling a
 * phase done.
 *
 * **These rules are deliberately narrow, and the narrowness is the point.** A first draft also
 * flagged every `min-w-56`, every unprefixed `grid-cols-2`, and the sidebar's `w-60` — and measuring
 * at 320px in a real browser showed all three were fine: the `min-w-*` floors sit in `flex-wrap`
 * parents, `grid-cols-2` of short stat tiles fits, and the sidebar's width is overridden below `lg`
 * by CSS a class-string checker cannot see. A check that fires on verified-good markup is one
 * somebody switches off, so only rules with observed signal survived.
 *
 * What actually caused horizontal page scroll here, for the record — note that **neither is
 * detectable from class strings**, which is why the manual pass is not optional:
 *  - a grid child missing `min-w-0`, so it refused to shrink below its content;
 *  - visually-hidden text escaping a scroll container, because `position: absolute` with no
 *    positioned ancestor is not clipped by `overflow-x: auto`.
 *
 * Opt out with `data-reflow-ok="why"` where CSS handles the width — the attribute is greppable and
 * has to be justified, unlike a checker quietly guessing.
 */
const FIXED_TRACK_GRID = /^grid-cols-\[[^\]]*(?:rem|px)/;
const FIXED_WIDTH = /^w-\[\d+px\]$/;

function reflowHazards(document) {
  const hazards = [];
  const seen = new Set();
  const note = (message) => {
    if (seen.has(message)) return;
    seen.add(message);
    hazards.push(message);
  };

  for (const el of document.querySelectorAll('[class]')) {
    if (el.closest('[data-reflow-ok]')) continue;
    const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const tag = el.tagName.toLowerCase();

    for (const cls of classes) {
      // A grid whose track list is in fixed units has a hard minimum at every viewport. This is what
      // `grid-cols-[9rem_1fr]` on the account screen was.
      if (FIXED_TRACK_GRID.test(cls)) {
        note(`<${tag}> has ${cls} — a fixed track with no breakpoint or container prefix`);
      }

      // A pixel width with nothing letting it shrink.
      if (FIXED_WIDTH.test(cls) && !classes.includes('max-w-full')) {
        note(`<${tag}> has ${cls} with no responsive variant and no max-w-full`);
      }
    }
  }

  /**
   * A table needs a scroll container of its own.
   *
   * Data tables are the canonical "requires two-dimensional layout" exception to 1.4.10, so they may
   * scroll horizontally — but only *inside* something. An unwrapped one takes the page with it.
   */
  for (const table of document.querySelectorAll('table')) {
    let wrapper = table.parentElement;
    let wrapped = false;
    for (let depth = 0; wrapper && depth < 2; depth += 1, wrapper = wrapper.parentElement) {
      const cls = wrapper.getAttribute('class') ?? '';
      if (/overflow-x-auto|overflow-x-scroll|overflow-auto/.test(cls)) wrapped = true;
    }
    if (!wrapped) {
      const caption = table.querySelector('caption')?.textContent?.trim().slice(0, 40) ?? '';
      note(`<table> "${caption}" is not inside an overflow-x-auto wrapper`);
    }
  }

  return hazards;
}

let totalViolations = 0;
let totalBrokenLabels = 0;
let totalReflowHazards = 0;
const summary = [];

for (const route of [...ANONYMOUS_ROUTES, ...ROUTES]) {
  const anonymous = ANONYMOUS_ROUTES.includes(route);
  const extra = EXTRA_COOKIES.get(route);
  const response = await fetch(`${base}${route}`, {
    headers: anonymous ? {} : { cookie: extra ? `${cookie}; ${extra}` : cookie },
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

  /**
   * Open every sheet before auditing it.
   *
   * A closed `<dialog>` is `display: none`, so axe skips its contents entirely — and the item
   * editor's revision history, incoming references, and danger zone all moved into sheets. Left
   * closed, three panels that were audited on every run when they sat inline would silently stop
   * being checked, and the run would still report zero violations. That is the worst shape a
   * regression in an audit can take.
   *
   * The `open` attribute rather than `showModal()`: the modal version makes everything outside the
   * dialog inert, which would then hide the rest of the page from the same run.
   */
  for (const sheet of window.document.querySelectorAll('dialog.taproot-sheet')) {
    sheet.setAttribute('open', '');
  }

  /**
   * And every disclosure menu, for the same reason.
   *
   * The sidebar's account link, theme buttons and sign-out form used to sit in the open, and were
   * audited on every route. Moving them behind a `[data-menu]` disclosure hides them from axe
   * unless the panel is opened — the run would stay green while three controls stopped being
   * checked, which is the worst way for an audit to lose coverage.
   */
  for (const panel of window.document.querySelectorAll('[data-menu-panel]')) {
    panel.removeAttribute('hidden');
  }

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
  const reflow = reflowHazards(window.document);
  totalViolations += violations.length;
  totalBrokenLabels += labels.length;
  totalReflowHazards += reflow.length;
  summary.push({ route, status: response.status, violations });

  const mark =
    violations.length === 0 && labels.length === 0 && reflow.length === 0 ? 'PASS' : 'FAIL';
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

  for (const hazard of reflow) {
    console.log(`      [reflow] ${hazard}`);
  }

  window.close();
}

console.log(
  `\n${summary.length} routes audited, ${totalViolations} violation type(s), ` +
    `${totalBrokenLabels} inert label(s) and ${totalReflowHazards} reflow hazard(s) found ` +
    `(colour contrast checked separately).`,
);

process.exit(
  totalViolations === 0 && totalBrokenLabels === 0 && totalReflowHazards === 0 ? 0 : 1,
);
