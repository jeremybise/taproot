/**
 * How many database queries one page view costs.
 *
 * A sibling of `a11y-audit.mjs`, and for the same reason: the standard is easy to state, invisible
 * from reading the code, and regresses silently. Nothing in the test suite counts round trips, so a
 * loader added inside a loop, an `await` where a `Promise.all` belonged, or an unconditional lookup
 * on a path that rarely needs it all pass every test, every typecheck and every build — and the only
 * symptom is a site that feels slow and a D1 bill that does not match the traffic.
 *
 * Counting is the point rather than timing. Against a local SQLite file every one of these is a
 * fraction of a millisecond, so a stopwatch here would report success no matter how many queries ran
 * — while on Workers each is a round trip to a database in one region. The count is the thing that
 * transfers between the two; the duration is not.
 *
 * Run it with the dev database seeded:
 *
 *   npm run db:seed && npm run query-count
 *
 * It exits non-zero when a page costs more than `BUDGET`, so it can gate a change the way the a11y
 * audit does. Raise the budget deliberately and say why, or the number stops meaning anything.
 */
import process from 'node:process';

import { createDb, resolveDelivery, resolveMenu } from '@taprootcms/core';

/**
 * The ceiling for one page view: the `resolve` call plus the menu the layout asks for.
 *
 * Not a target — a ceiling. It is set a little above the worst page the seed produces so that
 * ordinary content changes do not trip it, and low enough that a new N+1 does.
 */
const BUDGET = 16;

const location = process.env.TAPROOT_SQLITE_PATH ?? './apps/studio/data/taproot.sqlite';

const handle = await createDb({ driver: 'sqlite', location });

/**
 * Counted through a Kysely plugin rather than the `log` option.
 *
 * `log` has to be passed when the instance is constructed, and the instance here comes from
 * `createDb` — the same public entry point the studio uses. Reaching past it to build a Kysely by
 * hand would mean this script measured a database handle nothing else in the codebase uses, and
 * would need core's dialect modules to be exported for no other reason.
 */
let executed = 0;
const db = handle.db.withPlugin({
  transformQuery: (args) => {
    executed += 1;
    return args.node;
  },
  transformResult: async (args) => args.result,
});

/**
 * Enough of a storage adapter for `loadMedia` to build URLs with.
 *
 * The real one is chosen by environment and may talk to R2; nothing about which bytes exist changes
 * how many queries a resolve costs, and requiring a configured bucket would make this unrunnable on
 * a fresh clone.
 */
const storage = { publicUrl: (key) => `/media/${key}`, get: async () => null };

function count(label, fn) {
  executed = 0;
  return fn().then((result) => ({ label, queries: executed, result }));
}

const items = await db
  .selectFrom('content_items')
  .select(['path'])
  .where('status', '=', 'published')
  .orderBy('path')
  .execute();

if (items.length === 0) {
  console.error('No published content. Run `npm run db:seed` first.');
  process.exit(1);
}

const menu = await count('menu', () => resolveMenu(db, 'main'));

const pages = [];
for (const { path } of items) {
  const measured = await count(path, () =>
    resolveDelivery(db, path, { origin: 'http://localhost:4321', storage }),
  );
  if (measured.result.kind === 'item') pages.push(measured);
}

pages.sort((a, b) => b.queries - a.queries);

console.log(`Database queries per page view — ${pages.length} published pages\n`);
for (const page of pages) {
  const total = page.queries + menu.queries;
  const flag = total > BUDGET ? '  OVER' : '';
  console.log(
    `  ${String(total).padStart(3)}  ${String(page.queries).padStart(3)} resolve + ${menu.queries} menu   ${page.label}${flag}`,
  );
}

const worst = pages[0];
const worstTotal = worst.queries + menu.queries;

console.log(`\n  menu('main'): ${menu.queries} queries, once per page view`);
console.log(`  worst page:   ${worstTotal} (${worst.label})`);
console.log(`  budget:       ${BUDGET}`);

await handle.destroy();

if (worstTotal > BUDGET) {
  console.error(
    `\nOver budget: ${worstTotal} > ${BUDGET}. Something on the read path is issuing queries it did not before.`,
  );
  process.exit(1);
}

console.log('\nWithin budget.');
