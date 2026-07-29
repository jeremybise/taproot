import {
  createContentType,
  createField,
  createItem,
  createTaxonomy,
  createTerm,
  createUser,
  findUserByEmail,
  getContentTypeByApiId,
  getTaxonomyByApiId,
  listTerms,
  migrateToLatest,
  setPassword,
  type ContentTypeRow,
  type FieldRow,
  type TaprootDb,
  type TaxonomyRow,
  type TermRow,
} from '@taproot/core';

import { openDb } from './_db.ts';

/**
 * Seed a realistic starting point.
 *
 * Idempotent throughout: every step looks for what it would create and reuses it. Running this
 * twice must not duplicate anything, because during development you run it constantly and a seed
 * that only works on an empty database is a seed you stop trusting.
 *
 * The data is chosen to demonstrate the parts of the model that are easy to get wrong — a nested
 * page hierarchy, two same-slug siblings under different parents, a flat collection, and a
 * singleton.
 */

const DEV_EMAIL = 'admin@example.com';
const DEV_PASSWORD = 'taproot';

const { handle, target } = await openDb();
console.log(`Seeding ${target}`);

// Seeding a database with no schema is a confusing failure, so migrate first.
const migration = await migrateToLatest(handle.db);
if (migration.error) {
  console.error('Migration failed:', migration.error);
  await handle.destroy();
  process.exit(1);
}
if (migration.applied.length > 0) {
  console.log(`  applied ${migration.applied.length} migration(s)`);
}

// --- Admin user -------------------------------------------------------------

let admin = await findUserByEmail(handle.db, DEV_EMAIL);
if (admin) {
  // Reset the password so a half-finished earlier run still leaves a usable login.
  await setPassword(handle.db, admin.id, DEV_PASSWORD);
  console.log(`  user ${DEV_EMAIL} (existing, password reset)`);
} else {
  admin = await createUser(handle.db, {
    email: DEV_EMAIL,
    name: 'Avery Admin',
    role: 'admin',
    password: DEV_PASSWORD,
  });
  console.log(`  user ${DEV_EMAIL} (created)`);
}

// --- Taxonomy ---------------------------------------------------------------
//
// Created before the content types, because the page type's taxonomy field has to be configured
// with this taxonomy's id. The tree is two levels deep on purpose: it is what makes "every item
// under Student Services" a query worth having, and it is the shape Phase 3's department-scoped
// permissions assume.

async function ensureTaxonomy(
  input: Parameters<typeof createTaxonomy>[1],
  termNames: { name: string; children?: string[] }[],
): Promise<{ taxonomy: TaxonomyRow; terms: TermRow[] }> {
  const existing = await getTaxonomyByApiId(handle.db, input.api_id);
  if (existing) {
    console.log(`  taxonomy ${input.api_id} (existing)`);
    return { taxonomy: existing, terms: await listTerms(handle.db, existing.id) };
  }

  const taxonomy = await createTaxonomy(handle.db, input);
  const terms: TermRow[] = [];
  for (const entry of termNames) {
    const parent = await createTerm(handle.db, taxonomy.id, { name: entry.name });
    terms.push(parent);
    for (const child of entry.children ?? []) {
      terms.push(await createTerm(handle.db, taxonomy.id, { name: child, parentId: parent.id }));
    }
  }

  console.log(`  taxonomy ${input.api_id} (created with ${terms.length} terms)`);
  return { taxonomy, terms };
}

const departments = await ensureTaxonomy(
  {
    api_id: 'department',
    name: 'Department',
    name_plural: 'Departments',
    description: 'Who owns a piece of content. Scopes editing permissions from Phase 3 onward.',
    hierarchical: true,
  },
  [
    { name: 'Academics', children: ['Sciences', 'Humanities'] },
    { name: 'Student Services', children: ['Admissions', 'Financial Aid'] },
  ],
);

const termId = (name: string): string =>
  departments.terms.find((term) => term.name === name)?.id ?? '';

// --- Content types ----------------------------------------------------------

async function ensureType(
  input: Parameters<typeof createContentType>[1],
  fields: Omit<Parameters<typeof createField>[2], 'position'>[],
): Promise<{ type: ContentTypeRow; fields: FieldRow[] }> {
  const existing = await getContentTypeByApiId(handle.db, input.api_id);
  if (existing) {
    console.log(`  type ${input.api_id} (existing)`);
    return { type: existing, fields: existing.fields };
  }

  const type = await createContentType(handle.db, input);
  const created: FieldRow[] = [];
  for (const [index, field] of fields.entries()) {
    created.push(await createField(handle.db, type.id, { ...field, position: index }));
  }
  console.log(`  type ${input.api_id} (created with ${created.length} fields)`);
  return { type, fields: created };
}

const page = await ensureType(
  {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    description: 'A standard page that nests under a parent to form the site hierarchy.',
    kind: 'page',
    icon: null,
    url_prefix: null,
    title_field: 'title',
  },
  [
    {
      api_id: 'summary',
      label: 'Summary',
      type: 'text',
      required: false,
      localized: false,
      help_text: 'One or two sentences shown in listings and search results.',
      config: { multiline: true, maxLength: 300 },
    },
    {
      api_id: 'body',
      label: 'Body',
      type: 'text',
      required: false,
      localized: false,
      help_text: null,
      config: { multiline: true },
    },
    {
      api_id: 'show_in_nav',
      label: 'Show in navigation',
      type: 'boolean',
      required: false,
      localized: false,
      help_text: null,
      config: { defaultValue: true },
    },
    {
      api_id: 'departments',
      label: 'Departments',
      type: 'taxonomy',
      required: false,
      localized: false,
      help_text: 'Which department owns this page. Drives permissions from Phase 3 onward.',
      config: { taxonomyId: departments.taxonomy.id, multiple: true },
    },
  ],
);

const event = await ensureType(
  {
    api_id: 'event',
    name: 'Event',
    name_plural: 'Events',
    description: 'A dated event. Flat, with URLs under /events.',
    kind: 'collection',
    icon: null,
    url_prefix: 'events',
    title_field: 'title',
  },
  [
    {
      api_id: 'starts_at',
      label: 'Starts',
      type: 'date',
      required: true,
      localized: false,
      help_text: null,
      config: { includeTime: true },
    },
    {
      api_id: 'location',
      label: 'Location',
      type: 'text',
      required: false,
      localized: false,
      help_text: null,
      config: {},
    },
    {
      api_id: 'audience',
      label: 'Audience',
      type: 'select',
      required: false,
      localized: false,
      help_text: 'Who the event is aimed at.',
      config: {
        multiple: false,
        options: [
          { label: 'Prospective students', value: 'prospective' },
          { label: 'Current students', value: 'current' },
          { label: 'Faculty and staff', value: 'staff' },
          { label: 'Alumni', value: 'alumni' },
        ],
      },
    },
    {
      api_id: 'body',
      label: 'Details',
      type: 'text',
      required: false,
      localized: false,
      help_text: null,
      config: { multiline: true },
    },
  ],
);

const banner = await ensureType(
  {
    api_id: 'weather_banner',
    name: 'Weather Banner',
    name_plural: 'Weather Banners',
    description: 'Site-wide closure or delay notice. Exactly one exists.',
    kind: 'singleton',
    icon: null,
    url_prefix: null,
    title_field: null,
  },
  [
    {
      api_id: 'enabled',
      label: 'Show the banner',
      type: 'boolean',
      required: false,
      localized: false,
      help_text: null,
      config: { defaultValue: false },
    },
    {
      api_id: 'message',
      label: 'Message',
      type: 'text',
      required: false,
      localized: false,
      help_text: null,
      config: { multiline: true, maxLength: 300 },
    },
    {
      api_id: 'severity',
      label: 'Severity',
      type: 'select',
      required: false,
      localized: false,
      help_text: null,
      config: {
        multiple: false,
        options: [
          { label: 'Information', value: 'info' },
          { label: 'Warning', value: 'warning' },
          { label: 'Closure', value: 'closure' },
        ],
      },
    },
  ],
);

// --- Content items ----------------------------------------------------------

async function ensureItem(
  db: TaprootDb,
  type: ContentTypeRow,
  fields: FieldRow[],
  input: Parameters<typeof createItem>[3],
  expectedPath: string,
): Promise<string> {
  const existing = await db.db
    .selectFrom('content_items')
    .select('id')
    .where('path', '=', expectedPath)
    .executeTakeFirst();

  if (existing) return existing.id;

  const item = await createItem(db, type, fields, input);
  return item.id;
}

const admissionsId = await ensureItem(
  handle,
  page.type,
  page.fields,
  {
    contentTypeId: page.type.id,
    title: 'Admissions',
    status: 'published',
    userId: admin.id,
    data: {
      summary: 'Everything you need to join us at Riverbend.',
      body: 'Our admissions team is here to help at every step, from your first question to your first day on campus.',
      show_in_nav: true,
      departments: [termId('Admissions')],
    },
  },
  '/admissions',
);

const aidId = await ensureItem(
  handle,
  page.type,
  page.fields,
  {
    contentTypeId: page.type.id,
    title: 'Financial Aid',
    status: 'published',
    userId: admin.id,
    data: {
      summary: 'Scholarships, grants, and work-study at Riverbend.',
      body: 'Most students receive some form of aid. Start here to understand what you qualify for.',
      show_in_nav: true,
      departments: [termId('Financial Aid')],
    },
  },
  '/financial-aid',
);

// The point of these two: identical slug, different parents. A flat-page CMS cannot express this.
await ensureItem(
  handle,
  page.type,
  page.fields,
  {
    contentTypeId: page.type.id,
    title: 'Apply',
    parentId: admissionsId,
    status: 'published',
    userId: admin.id,
    data: {
      summary: 'Start your application to Riverbend College.',
      body: 'Applications open on 1 September. You will need transcripts and two references.',
      show_in_nav: true,
      departments: [termId('Admissions')],
    },
  },
  '/admissions/apply',
);

await ensureItem(
  handle,
  page.type,
  page.fields,
  {
    contentTypeId: page.type.id,
    title: 'Apply',
    parentId: aidId,
    status: 'published',
    userId: admin.id,
    data: {
      summary: 'Apply for financial aid — a separate process from admissions.',
      body: 'Submit the aid application by 1 March for priority consideration.',
      show_in_nav: true,
      // Two departments on one page: the aid team owns it, admissions links to it.
      departments: [termId('Financial Aid'), termId('Admissions')],
    },
  },
  '/financial-aid/apply',
);

// Three levels deep, so cascading renames have something real to cascade to.
const applyId = (await handle.db
  .selectFrom('content_items')
  .select('id')
  .where('path', '=', '/admissions/apply')
  .executeTakeFirstOrThrow()).id;

await ensureItem(
  handle,
  page.type,
  page.fields,
  {
    contentTypeId: page.type.id,
    title: 'Deadlines',
    parentId: applyId,
    status: 'published',
    userId: admin.id,
    data: {
      summary: 'Key dates for the coming application cycle.',
      body: 'Early action: 1 November. Regular decision: 15 January. Transfer: 1 April.',
      show_in_nav: false,
      departments: [termId('Admissions')],
    },
  },
  '/admissions/apply/deadlines',
);

await ensureItem(
  handle,
  page.type,
  page.fields,
  {
    contentTypeId: page.type.id,
    title: 'About',
    status: 'published',
    userId: admin.id,
    data: {
      summary: 'A small college on the river, founded in 1897.',
      body: 'Riverbend College is a fictional institution that exists to demonstrate a CMS.',
      show_in_nav: true,
    },
  },
  '/about',
);

// A draft, so the admin has something unpublished to show and the public route has something to hide.
await ensureItem(
  handle,
  page.type,
  page.fields,
  {
    contentTypeId: page.type.id,
    title: 'Campus Housing',
    status: 'draft',
    userId: admin.id,
    data: { summary: 'Still being written.', body: 'Draft content.', show_in_nav: false },
  },
  '/campus-housing',
);

await ensureItem(
  handle,
  event.type,
  event.fields,
  {
    contentTypeId: event.type.id,
    title: 'Spring Open House',
    status: 'published',
    userId: admin.id,
    data: {
      starts_at: '2026-04-11T14:00:00.000Z',
      location: 'Riverbend Quad',
      audience: 'prospective',
      body: 'Tour campus, meet faculty, and sit in on a class.',
    },
  },
  '/events/spring-open-house',
);

await ensureItem(
  handle,
  event.type,
  event.fields,
  {
    contentTypeId: event.type.id,
    title: 'Financial Aid Night',
    status: 'published',
    userId: admin.id,
    data: {
      starts_at: '2026-03-03T23:00:00.000Z',
      location: 'Halloway Hall',
      audience: 'prospective',
      body: 'A walk-through of the aid application, with counsellors on hand.',
    },
  },
  '/events/financial-aid-night',
);

const bannerExists = await handle.db
  .selectFrom('content_items')
  .select('id')
  .where('content_type_id', '=', banner.type.id)
  .executeTakeFirst();

if (!bannerExists) {
  await createItem(handle, banner.type, banner.fields, {
    contentTypeId: banner.type.id,
    title: 'Weather Banner',
    status: 'published',
    userId: admin.id,
    data: { enabled: false, message: '', severity: 'info' },
  });
}

const counts = await handle.db
  .selectFrom('content_items')
  .select((eb) => eb.fn.countAll<number>().as('n'))
  .executeTakeFirst();

const assignmentCount = await handle.db
  .selectFrom('taxonomy_assignments')
  .select((eb) => eb.fn.countAll<number>().as('n'))
  .executeTakeFirst();

console.log(
  `\nSeeded. ${Number(counts?.n ?? 0)} content items, ` +
    `${Number(assignmentCount?.n ?? 0)} taxonomy assignments.`,
);
console.log(`\n  Sign in at http://localhost:4321/admin`);
console.log(`  Email:    ${DEV_EMAIL}`);
console.log(`  Password: ${DEV_PASSWORD}\n`);

await handle.destroy();
