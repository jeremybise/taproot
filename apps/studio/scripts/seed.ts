import {
  createContentType,
  createField,
  createItem,
  createMenu,
  createMenuItem,
  createRelease,
  hashSessionToken,
  createReusableBlock,
  createSnippet,
  listSnippets,
  createTaxonomy,
  createTerm,
  createUser,
  getMenuByApiId,
  listMenuItems,
  findUserByEmail,
  getContentTypeByApiId,
  getTaxonomyByApiId,
  listReleases,
  listTerms,
  stageItem,
  updateStagedItem,
  buildStorageKey,
  migrateToLatest,
  newId,
  normalizeSearchQuery,
  now,
  setPassword,
  storageFromEnv,
  type ContentTypeRow,
  type FieldRow,
  type TaprootDb,
  type TaxonomyRow,
  type TermRow,
} from '@taprootcms/core';

import { openDb } from './_db.ts';
import { loadEnv } from './_env.ts';
import { placeholderPng, socialCardPng } from './_png.ts';

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

/**
 * Shorter than `MIN_PASSWORD_LENGTH`, deliberately.
 *
 * That minimum governs a password somebody *chooses* — through the setup screen, a set-password
 * link, or the account screen — and all three enforce it. This is a fixture written straight
 * through `setPassword`, and it stays short because it is typed dozens of times a day during
 * development and appears in the README, the login page hint, and the deployment docs.
 *
 * Safe because the seed only ever runs against the local SQLite file: `openDb()` has no path to a
 * deployed database, and a production instance is bootstrapped through the first-run setup screen,
 * which does enforce the minimum.
 */
const DEV_PASSWORD = 'taproot';

/**
 * A fixed API key for local development, so the reference consumer works from a fresh clone.
 *
 * The same reasoning as the fixed development password above, and the same limits: this is seed
 * data, the seed is a development tool, and anything it creates is public knowledge. It is spelled
 * to be unmistakable in a log or a leak.
 *
 * A real deployment never runs the seed and creates its keys under Settings -> API keys, where the
 * token is random and shown exactly once. Nothing here changes that path — the row is inserted
 * directly rather than through `createApiKey`, precisely so that function keeps its promise that a
 * token it returns was randomly generated.
 */
const DEV_API_KEY = `tpr_${'devkey'.padEnd(64, '0')}`;

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
// under Student Services" a branch query worth having.
//
// This classifies content and nothing more. Whichever department is allowed to *edit* a page is a
// separate model in Phase 3 — see the Roles & permissions section of SCOPE.md for why the two are
// deliberately not the same rows.

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
    description: 'Which part of the college a page relates to. Used for navigation and filtering.',
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
    summary_template: '{{ title }}',
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
      type: 'richtext',
      required: false,
      localized: false,
      help_text: null,
      // No `allowedFormats`, so the field gets the full toolbar. The Event type's details field is
      // left as plain text on purpose, so the demo shows both controls rather than only one.
      config: {},
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
      help_text: 'Which parts of the college this page relates to.',
      config: { taxonomyId: departments.taxonomy.id, multiple: true },
    },
    {
      api_id: 'sections',
      label: 'Sections',
      type: 'block',
      required: false,
      localized: false,
      help_text: 'Composed blocks rendered under the body.',
      // Named by `api_id` rather than by id, so the list survives a block type being recreated and
      // reads meaningfully in the stored config.
      config: {
        allowedBlocks: [
          'hero',
          'call_to_action',
          'prose',
          'quote',
          'gallery',
          'video',
          'embedded_form',
          'event_listing',
        ],
      },
    },
  ],
);

// --- Block types ------------------------------------------------------------
//
// The pieces a page is composed from. They are content types with `kind: 'block'` — a block type
// is a user-defined schema with fields, which is what a content type is; the only difference is
// that its instances live inside a page rather than at a URL.
//
// Deliberately generic: a hero, a call to action, a gallery, and a quote are shapes any site has.
// The templates that give them a look live in apps/web/src/blocks, because that is the site's
// decision and not the CMS's.

const hero = await ensureType(
  {
    api_id: 'hero',
    name: 'Hero',
    name_plural: 'Heroes',
    description: 'A headline, a short lead, and an optional image.',
    kind: 'block',
    icon: null,
    url_prefix: null,
    summary_template: null,
  },
  [
    {
      api_id: 'heading',
      label: 'Heading',
      type: 'text',
      required: true,
      localized: false,
      help_text: null,
      config: { maxLength: 120 },
    },
    {
      api_id: 'lead',
      label: 'Lead',
      type: 'text',
      required: false,
      localized: false,
      help_text: 'One or two sentences under the heading.',
      config: { multiline: true, maxLength: 300 },
    },
    {
      api_id: 'image',
      label: 'Background image',
      type: 'media',
      required: false,
      localized: false,
      help_text: null,
      config: { multiple: false, accept: ['image/'] },
    },
  ],
);

const callToAction = await ensureType(
  {
    api_id: 'call_to_action',
    name: 'Call to action',
    name_plural: 'Calls to action',
    description: 'A short prompt with a single link.',
    kind: 'block',
    icon: null,
    url_prefix: null,
    summary_template: null,
  },
  [
    {
      api_id: 'text',
      label: 'Text',
      type: 'text',
      required: true,
      localized: false,
      help_text: null,
      config: { multiline: true, maxLength: 200 },
    },
    {
      api_id: 'link_label',
      label: 'Button label',
      type: 'text',
      required: true,
      localized: false,
      help_text: null,
      config: { maxLength: 60 },
    },
    {
      api_id: 'link_href',
      label: 'Button link',
      type: 'text',
      required: true,
      localized: false,
      help_text: 'A path on this site, or a full address.',
      config: {},
    },
  ],
);

const prose = await ensureType(
  {
    api_id: 'prose',
    name: 'Rich text',
    name_plural: 'Rich text blocks',
    description: 'A run of formatted text.',
    kind: 'block',
    icon: null,
    url_prefix: null,
    summary_template: null,
  },
  [
    {
      api_id: 'body',
      label: 'Body',
      type: 'richtext',
      required: true,
      localized: false,
      help_text: null,
      config: {},
    },
  ],
);

const quote = await ensureType(
  {
    api_id: 'quote',
    name: 'Quote',
    name_plural: 'Quotes',
    description: 'A pull quote with an attribution.',
    kind: 'block',
    icon: null,
    url_prefix: null,
    summary_template: null,
  },
  [
    {
      api_id: 'quote',
      label: 'Quote',
      type: 'text',
      required: true,
      localized: false,
      help_text: null,
      config: { multiline: true, maxLength: 400 },
    },
    {
      api_id: 'attribution',
      label: 'Attributed to',
      type: 'text',
      required: false,
      localized: false,
      help_text: null,
      config: { maxLength: 120 },
    },
  ],
);

const gallery = await ensureType(
  {
    api_id: 'gallery',
    name: 'Gallery',
    name_plural: 'Galleries',
    description: 'Several images in the order you choose them.',
    kind: 'block',
    icon: null,
    url_prefix: null,
    summary_template: null,
  },
  [
    {
      api_id: 'images',
      label: 'Images',
      type: 'media',
      required: true,
      localized: false,
      // The order is the feature, so the help text says so rather than leaving an editor to
      // discover that the move buttons do something the page respects.
      help_text: 'They appear in the order listed. Use the move buttons to change it.',
      config: { multiple: true, accept: ['image/'] },
    },
    {
      api_id: 'caption',
      label: 'Caption',
      type: 'text',
      required: false,
      localized: false,
      help_text: null,
      config: { maxLength: 200 },
    },
  ],
);

/**
 * The two embed shapes, seeded as separate block types on purpose.
 *
 * One "embed anything" block with a mode picker would have been fewer lines and is the raw-HTML
 * instinct wearing a different hat: sizing belongs to the *field's* config precisely so an editor
 * pasting a link never has to reason about aspect ratios, and so each of these can carry its own
 * template, its own label and its own help text.
 */
const video = await ensureType(
  {
    api_id: 'video',
    name: 'Video',
    name_plural: 'Videos',
    description: 'A video from an approved host, in a 16:9 frame.',
    kind: 'block',
    icon: null,
    url_prefix: null,
    summary_template: null,
  },
  [
    {
      api_id: 'video',
      label: 'Video',
      type: 'embed',
      required: true,
      localized: false,
      help_text: 'Paste the address of the video’s embed page, not the page you watch it on.',
      config: {
        // `youtube-nocookie.com` is here because it is what a site that cares what gets set before
        // somebody presses play will actually embed from.
        allowedHosts: ['youtube.com', 'youtube-nocookie.com', 'player.vimeo.com'],
        sizing: { mode: 'ratio', ratio: 16 / 9 },
      },
    },
    {
      api_id: 'caption',
      label: 'Caption',
      type: 'text',
      required: false,
      localized: false,
      help_text: null,
      config: { maxLength: 200 },
    },
  ],
);

const embeddedForm = await ensureType(
  {
    api_id: 'embedded_form',
    name: 'Embedded form',
    name_plural: 'Embedded forms',
    description: 'A form hosted elsewhere, in a frame that grows with its content.',
    kind: 'block',
    icon: null,
    url_prefix: null,
    summary_template: null,
  },
  [
    {
      api_id: 'form',
      label: 'Form',
      type: 'embed',
      required: true,
      localized: false,
      help_text:
        'The form’s own address. It has to report its height for the frame to grow — see the handbook.',
      config: {
        // Nothing real to point the demo at, so the list is a placeholder an operator replaces.
        // Empty would be the honest alternative and would make the field refuse every address,
        // which reads as broken rather than as unconfigured.
        allowedHosts: ['docs.google.com'],
        sizing: { mode: 'auto', minHeight: 480 },
      },
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
    icon: 'calendar',
    url_prefix: 'events',
    summary_template: '{{ title }}',
    /*
     * The case configurable columns were built for: an events list ordered by when the events
     * actually happen, showing the date rather than a path nobody reads. Seeded so the feature is
     * visible on a fresh clone rather than something you have to go and switch on to see.
     */
    list_columns: ['title', 'starts_at', 'location', 'status'],
    list_sort: 'field_asc',
    list_sort_field: 'starts_at',
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
    {
      api_id: 'capacity',
      label: 'Capacity',
      type: 'number',
      required: false,
      localized: false,
      help_text: 'Maximum attendees. Leave blank for unlimited.',
      config: { min: 0, integer: true },
    },
    {
      /**
       * Events carry departments too, which is what makes the query block worth demonstrating: a
       * listing filtered to one department is the case, and it cannot be shown with a taxonomy that
       * only pages use.
       */
      api_id: 'departments',
      label: 'Departments',
      type: 'taxonomy',
      required: false,
      localized: false,
      help_text: 'What this event is about. A listing filtered by a parent finds these too.',
      config: { taxonomyId: departments.taxonomy.id, multiple: true },
    },
    {
      /**
       * A repeater, seeded for the same reason as the relation below: an editor nobody's demo data
       * reaches is an editor nobody notices is broken.
       *
       * Session times are the archetypal case — several of one small shape, ordered, and far too
       * slight to be content items of their own.
       */
      api_id: 'schedule',
      label: 'Schedule',
      type: 'repeater',
      required: false,
      localized: false,
      help_text: 'Sessions within the event, in the order they run.',
      config: {
        maxItems: 12,
        fields: [
          { api_id: 'time', label: 'Time', type: 'text', required: true, config: {} },
          { api_id: 'what', label: 'What', type: 'text', required: true, config: {} },
          {
            api_id: 'room',
            label: 'Room',
            type: 'text',
            required: false,
            config: {},
          },
        ],
      },
    },
    {
      /**
       * A link field, seeded for the same reason as the two below it.
       *
       * "Register" is the case the field type exists for: it is sometimes a page on this site and
       * sometimes an external booking system, which is precisely what a `relation` cannot express.
       * No `allowedKinds`, so the demo shows all three panels of the dialog.
       */
      api_id: 'registration_link',
      label: 'Registration',
      type: 'link',
      required: false,
      localized: false,
      help_text: 'Where people sign up — a page here, a file, or an external booking system.',
      config: {},
    },
    {
      /**
       * The relation field, seeded so the demo exercises it.
       *
       * It points from Event to Page rather than the other way round because Page is defined
       * first and a relation needs its target's id — and because "which page is this event part
       * of" is the direction a campus actually asks in.
       *
       * Nothing seeded a relation for two phases, which is why nobody noticed the field type had
       * a config form, server-side validation, and no editing control at all.
       */
      api_id: 'host_page',
      label: 'Part of',
      type: 'relation',
      required: false,
      localized: false,
      help_text: 'The department or programme page this event belongs to.',
      config: {
        targetContentTypeId: page.type.id,
        multiple: false,
        reverseLabel: 'Events',
      },
    },
  ],
);

/**
 * The block the `query` field exists for.
 *
 * Seeded *after* the event type because it points at it — a block type is a content type, so the
 * ordering constraint is the same one every relation field has.
 *
 * A heading beside a listing, which is also the argument for `query` being a *field* rather than a
 * block type of its own: the block composes the two and the site styles the pair. And it shows the
 * split that makes a listing reusable — what may be asked is fixed here, once, while each editor
 * placing this block picks their own department and count.
 */
/**
 * A staff directory, which is the shape a listing with `include=data` exists for.
 *
 * Every other seeded type is read one item at a time through `resolve`. This one is read *as a set*
 * — twenty cards on one page, each needing a photo, a job title and a department — which is the read
 * that used to cost one request per person and now costs one. Seeded because the feature is
 * otherwise invisible on a fresh clone: nothing in a college demo made of pages and events asks the
 * delivery API for field values in bulk.
 *
 * `department` is `multiple` deliberately. Somebody with a joint appointment is the case a facet
 * gets wrong — a filter that reads the first value silently loses the second, on exactly the people
 * most likely to be looked up.
 */
const person = await ensureType(
  {
    api_id: 'person',
    name: 'Person',
    name_plural: 'People',
    description: 'A member of staff, listed in the directory. Flat, with URLs under /people.',
    kind: 'collection',
    icon: 'user',
    url_prefix: 'people',
    // A photograph and a job title tell one row from the next here; a path does not, and these
    // people have no pages anyway.
    list_columns: ['photo', 'title', 'position', 'department'],
    /**
     * No pages of their own, which is the point of seeding a directory rather than another
     * collection of pages.
     *
     * A person is real content — created, versioned, classified by department, listed on
     * `/directory` — and none of them is a URL. With this on, `/people/marguerite-okafor` would
     * resolve, the demo site's catch-all would render a bare field dump at it, and site search would
     * return a result whose link is a page nobody designed.
     */
    item_pages: false,
    summary_template: '{{ title }}',
  },
  [
    {
      api_id: 'position',
      label: 'Position',
      type: 'text',
      required: false,
      localized: false,
      help_text: 'Job title, as it should appear under their name.',
      config: {},
    },
    {
      api_id: 'photo',
      label: 'Photo',
      type: 'media',
      required: false,
      localized: false,
      help_text: null,
      // Single, and portrait in practice — which is what makes the hotspot worth setting, since a
      // directory card crops these square.
      config: { accept: ['image/*'] },
    },
    {
      api_id: 'department',
      label: 'Department',
      type: 'taxonomy',
      required: false,
      localized: false,
      help_text: 'One or more. Somebody can sit in two.',
      config: { taxonomyId: departments.taxonomy.id, multiple: true },
    },
    {
      api_id: 'email',
      label: 'Email',
      type: 'text',
      required: false,
      localized: false,
      help_text: null,
      config: {},
    },
    {
      api_id: 'phone',
      label: 'Phone',
      type: 'text',
      required: false,
      localized: false,
      help_text: null,
      config: {},
    },
  ],
);

const eventListing = await ensureType(
  {
    api_id: 'event_listing',
    name: 'Event listing',
    name_plural: 'Event listings',
    description: 'Upcoming events, chosen by a rule rather than by hand.',
    kind: 'block',
    icon: null,
    url_prefix: null,
    summary_template: null,
  },
  [
    {
      api_id: 'heading',
      label: 'Heading',
      type: 'text',
      required: false,
      localized: false,
      help_text: null,
      config: { maxLength: 120 },
    },
    {
      api_id: 'events',
      label: 'Events',
      type: 'query',
      required: false,
      localized: false,
      help_text: 'Published events matching this appear automatically — nobody edits this page.',
      config: {
        targetContentTypeId: event.type.id,
        taxonomyId: departments.taxonomy.id,
        /**
         * The event's *own* start date, not the day it was published — which is the whole reason
         * the derived value index exists. Without this the listing could only offer "newest", and
         * an events page ordered by publication date is an events page in the wrong order.
         */
        dateFieldApiId: 'starts_at',
        maxResults: 12,
        defaultLimit: 3,
      },
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
    summary_template: null,
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
    /**
     * The two fields below are conditional on the switch above, which is what the feature is for:
     * a banner nobody is showing has no message and no severity, and leaving both on screen asks an
     * editor to fill in something with no effect.
     *
     * `required` is deliberately false on both, so this demonstrates the *visibility* rule without
     * also depending on the relaxation — a seed that needed both to be right would not say which
     * one had broken.
     */
    {
      api_id: 'message',
      label: 'Message',
      type: 'text',
      required: false,
      localized: false,
      help_text: null,
      config: { multiline: true, maxLength: 300 },
      visible_when: { field: 'enabled', operator: 'is_checked' },
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
      visible_when: { field: 'enabled', operator: 'is_checked' },
    },
  ],
);

// --- Media ------------------------------------------------------------------
//
// Enough generated assets that the picker is a grid rather than a single card. One image proves
// the storage pipeline works; it takes several to see whether selection, ordering, and search do.
// Keyed on filename so re-seeding reuses them rather than writing second copies.

const mediaStorage = storageFromEnv(loadEnv());

async function ensureAsset(
  filename: string,
  bytes: Uint8Array,
  dimensions: { width: number; height: number },
  /**
   * `null` means nobody has described it and the accessibility report will say so; `''` would mean
   * somebody decided it needs no description. Seeded assets get real alt text — except one, below,
   * which is what gives the report something true to find.
   */
  altText: string | null,
  title: string,
  /**
   * An off-centre focal point, for the assets where it should visibly do something.
   *
   * Left null for most, which is the honest default for a freshly uploaded file. But every seeded
   * asset used to be null, so the focal point editor always opened dead centre and the public page
   * rendered the same crop it would have rendered without the feature — the one arrangement in
   * which "the hotspot is honoured" and "the hotspot is ignored" look identical.
   */
  hotspot?: { x: number; y: number },
): Promise<string> {
  const existing = await handle.db
    .selectFrom('media')
    .select('id')
    .where('filename', '=', filename)
    .executeTakeFirst();
  if (existing) return existing.id;

  const id = newId();
  const stored = await mediaStorage.put(buildStorageKey(id, filename), bytes, {
    contentType: 'image/png',
  });

  const timestamp = now();
  await handle.db
    .insertInto('media')
    .values({
      id,
      storage_key: stored.key,
      filename,
      mime_type: 'image/png',
      size_bytes: stored.size,
      width: dimensions.width,
      height: dimensions.height,
      // Written rather than left null for all but one: the media library warns about missing alt
      // text, and the picker repeats the warning on every card. Seeding every asset without it
      // would seed the warning too, on every screen that shows them.
      alt_text: altText,
      title,
      hotspot_x: hotspot?.x ?? null,
      hotspot_y: hotspot?.y ?? null,
      crop_top: null,
      crop_right: null,
      crop_bottom: null,
      crop_left: null,
      uploaded_by: admin.id,
      created_at: timestamp,
      updated_at: timestamp,
    })
    .execute();

  console.log(`  media ${filename} (created)`);
  return id;
}

const SOCIAL_CARD_FILENAME = 'riverbend-social-card.png';

const socialCardId = await ensureAsset(
  SOCIAL_CARD_FILENAME,
  socialCardPng(),
  { width: 1200, height: 630 },
  'Riverbend College — a green gradient card used as the default sharing image.',
  'Default social card',
);

/**
 * Library assets in a spread of shapes.
 *
 * The shapes are the point as much as the count: the hotspot editor resolves one asset into a
 * 16:9 hero, a square thumbnail, and a portrait card, and a library of identical landscape images
 * would never show that doing anything.
 */
const galleryImages = [
  await ensureAsset(
    'campus-quad.png',
    placeholderPng(140, 1600, 900),
    { width: 1600, height: 900 },
    'Students crossing the main quad between lectures.',
    'The quad',
    // Well off-centre and high, so a 16:5 hero and a 4:3 gallery tile visibly disagree about what
    // they keep — which is the whole argument for storing the point rather than baking a crop.
    { x: 0.24, y: 0.32 },
  ),
  await ensureAsset(
    'library-reading-room.png',
    placeholderPng(28, 1600, 900),
    { width: 1600, height: 900 },
    'The reading room on the first floor of the Hartley Library.',
    'Hartley Library reading room',
  ),
  await ensureAsset(
    'science-building.png',
    placeholderPng(200, 1200, 1200),
    { width: 1200, height: 1200 },
    'The Fenwick science building seen from the south lawn.',
    'Fenwick building',
    { x: 0.78, y: 0.3 },
  ),
];

await ensureAsset(
  'convocation.png',
  placeholderPng(320, 900, 1600),
  { width: 900, height: 1600 },
  'A graduate crossing the stage during the spring convocation.',
  'Spring convocation',
);

/**
 * One asset nobody has described, and it is not on any page.
 *
 * The most common real accessibility problem in a CMS is an image uploaded in a hurry, and it is
 * also the case the item scan cannot find — an asset placed nowhere appears in no item's data, so
 * only the library query catches it, and it will be undescribed on whatever page it eventually
 * lands on. Seeding it here is what makes that half of the report demonstrably do something.
 */
await ensureAsset(
  'open-day-crowd.png',
  placeholderPng(85, 1600, 900),
  { width: 1600, height: 900 },
  null,
  'Open day',
);

/**
 * Portraits for the directory, one per person.
 *
 * Portrait rather than landscape, and each with its own hotspot, because a directory card crops
 * these to a square — which is the arrangement where a stored focal point is the difference between
 * a face and a chin. Generated per person so the grid is not six copies of one image, which would
 * hide exactly that.
 */
const portrait = (hue: number) => placeholderPng(hue, 900, 1200);

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
    // A meta title that differs from the page title, which is the case the SEO preview exists for
    // — "Admissions" is the right heading on the page and a poor search result on its own.
    seo: {
      metaTitle: 'Admissions & Applying — Riverbend College',
      metaDescription:
        'Deadlines, requirements, and financial aid for undergraduate and transfer applicants to Riverbend College.',
    },
    data: {
      summary: 'Everything you need to join us at Riverbend.',
      body:
        '<p>Our admissions team is here to help at every step, from your first question to your first day on campus.</p>' +
        '<h2>Before you apply</h2>' +
        '<ul><li>Request a transcript from every school you have attended</li>' +
        '<li>Line up two references</li>' +
        '<li>Check the <a href="/admissions/apply/deadlines">deadlines</a></li></ul>',
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
      body:
        '<p>Most students receive some form of aid. Start here to understand what you qualify for.</p>' +
        '<blockquote><p>Roughly four in five Riverbend students receive a grant, a scholarship, or both.</p></blockquote>',
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
      /**
       * The link says "click here", and it is deliberate.
       *
       * The accessibility report needs something real to find or it opens empty on a fresh clone,
       * which is the one arrangement where "the checker works" and "the checker is broken" look
       * identical. This is also the single most common finding on a real campus site, so it is a
       * fair example rather than a contrived one — and it is a warning, not an error, so the demo
       * site is not shipped with a WCAG failure to make a point.
       */
      body:
        '<p>Applications open on <strong>1 September</strong>. You will need transcripts and two references — ' +
        '<a href="/financial-aid">click here</a> for funding.</p>',
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
      body: '<p>Submit the aid application by <strong>1 March</strong> for priority consideration.</p>',
      show_in_nav: true,
      // Two departments on one page — it is genuinely about both. Multi-tagging is unremarkable
      // precisely because these terms classify rather than confer edit rights.
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
    // A thin page that repeats dates published on its parent — the ordinary reason to keep
    // something out of search while leaving it linked and reachable. Set on a *published* page
    // deliberately: an unpublished one never reaches a crawler, so it would demonstrate nothing.
    seo: { noIndex: true },
    data: {
      summary: 'Key dates for the coming application cycle.',
      body:
        '<h2>Undergraduate</h2>' +
        '<ul><li>Early action — 1 November</li><li>Regular decision — 15 January</li></ul>' +
        '<h2>Transfer</h2><ul><li>1 April</li></ul>',
      show_in_nav: false,
      departments: [termId('Admissions')],
    },
  },
  '/admissions/apply/deadlines',
);

// A page built out of blocks rather than a single body field — the Phase 2 case. The block ids are
// generated because they are what keeps a block's editor mounted across a reorder.
await ensureItem(
  handle,
  page.type,
  page.fields,
  {
    contentTypeId: page.type.id,
    title: 'Visit Riverbend',
    // Explicit, because `ensureItem` finds an existing row by path: letting the slug derive from
    // the title would put it at /visit-riverbend, never match the /visit it looks for, and create
    // another copy on every reseed.
    slug: 'visit',
    status: 'published',
    userId: admin.id,
    data: {
      summary: 'Come and see the place before you decide.',
      show_in_nav: false,
      sections: [
        {
          id: newId(),
          type: 'hero',
          data: {
            heading: 'Spend a day on the river',
            lead: 'Tours run every weekday at 10am and 2pm, and most Saturdays in term time.',
            image: socialCardId,
          },
        },
        {
          id: newId(),
          type: 'prose',
          data: {
            body:
              '<p>A campus visit is the fastest way to work out whether somewhere fits. ' +
              'You will see a class, eat in the refectory, and meet current students.</p>' +
              '<h2>What to expect</h2>' +
              '<ul><li>Ninety minutes on foot, mostly outdoors</li>' +
              '<li>A short session with an admissions counsellor</li></ul>',
          },
        },
        {
          id: newId(),
          // Three images in a deliberate order, which is what makes the field's move buttons
          // demonstrable: reorder them in the admin and the page changes to match.
          type: 'gallery',
          data: {
            images: galleryImages,
            caption: 'A few corners of the campus you will walk through on the tour.',
          },
        },
        {
          id: newId(),
          type: 'video',
          data: {
            video: {
              /*
                A real, stable embed address, so a fresh clone shows the frame working rather than a
                grey box. `youtube-nocookie.com` for the reason the block type's allowlist mentions
                it — the demo should not set anything before a visitor presses play.
              */
              url: 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ',
              // Not "Video". The a11y checker warns about a title that names the kind of thing
              // rather than this one, and the seed should not ship the mistake it warns about.
              title: 'Big Buck Bunny, the open-source short film',
            },
            caption: 'The kind of thing a media course puts together in its final year.',
          },
        },
        {
          id: newId(),
          type: 'quote',
          data: {
            quote:
              'I applied the week after my tour. Standing in the middle of it made the decision for me.',
            attribution: 'Nia, second year',
          },
        },
        {
          id: newId(),
          /**
           * The query block, on a page where its point is obvious: an editor never lists these
           * events by hand, and publishing a new one adds it here on its own.
           *
           * `termIds` is left empty deliberately — the demo wants the listing to fill itself, and a
           * department filter on a college-wide "Visit" page would be an odd thing to seed. The
           * filter is one click away in the editor, which is where somebody should see it work.
           */
          type: 'event_listing',
          data: {
            heading: 'While you are here',
            /**
             * The case the feature was asked for: still to come, soonest first. Both halves are
             * resolved at read time — "still to come" against the clock rather than a stored
             * timestamp, and the order against the events' own dates through the value index.
             */
            events: { termIds: [], sort: 'field_asc', limit: 3, dateFilter: 'upcoming' },
          },
        },
        {
          id: newId(),
          type: 'call_to_action',
          data: {
            text: 'Tours fill up quickly in the spring.',
            link_label: 'Book a visit',
            link_href: '/admissions/apply',
          },
        },
      ],
    },
  },
  '/visit',
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
      body:
        '<p>Riverbend College is a fictional institution that exists to demonstrate a CMS.</p>' +
        '<p>Everything here — the pages, the events, the departments — is seed data you can delete.</p>',
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
    data: { summary: 'Still being written.', body: '<p>Draft content.</p>', show_in_nav: false },
  },
  '/campus-housing',
);

// Every remaining status gets one item, so the status colours and the status filter both have
// something to show on a fresh clone rather than a list that is entirely one colour.
await ensureItem(
  handle,
  page.type,
  page.fields,
  {
    contentTypeId: page.type.id,
    title: 'Student Life',
    status: 'in_review',
    userId: admin.id,
    data: {
      summary: 'Clubs, athletics, and life on the river.',
      body: '<p>Waiting on a read from the Student Affairs office before this goes live.</p>',
      show_in_nav: false,
    },
  },
  '/student-life',
);

await ensureItem(
  handle,
  page.type,
  page.fields,
  {
    contentTypeId: page.type.id,
    title: 'Registration — Spring 2025',
    status: 'archived',
    userId: admin.id,
    data: {
      summary: 'Superseded by the current registration page.',
      body:
        '<p>Kept for reference. Archived rather than deleted so its URL keeps resolving.</p>',
      show_in_nav: false,
    },
  },
  '/registration-spring-2025',
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
      starts_at: '2030-04-11T14:00:00.000Z',
      location: 'Riverbend Quad',
      audience: 'prospective',
      body: 'Tour campus, meet faculty, and sit in on a class.',
      capacity: 300,
      schedule: [
        { id: newId(), data: { time: '10:00', what: 'Welcome and campus tour', room: 'Riverbend Quad' } },
        { id: newId(), data: { time: '11:30', what: 'Subject talks', room: 'Halloway Hall' } },
        { id: newId(), data: { time: '13:00', what: 'Lunch with current students', room: 'The Refectory' } },
      ],
      // An external address, which is the half of `link` a relation field cannot express at all.
      registration_link: {
        kind: 'url',
        href: 'https://example.edu/open-house/register',
        label: 'Reserve your place',
        newTab: true,
        noFollow: false,
      },
      // The relation, pointing at a page that exists — so the editor opens on a resolved title
      // rather than on an empty control that looks the same whether or not the feature works.
      host_page: admissionsId,
      /**
       * Filed under a *child* term, which is what makes branch expansion demonstrable: a listing
       * filtered to "Student Services" has to find this even though it is tagged "Admissions".
       */
      departments: [termId('Admissions')],
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
      starts_at: '2030-03-03T23:00:00.000Z',
      location: 'Halloway Hall',
      audience: 'prospective',
      body: 'A walk-through of the aid application, with counsellors on hand.',
      capacity: 80,
      host_page: aidId,
      departments: [termId('Financial Aid')],
    },
  },
  '/events/financial-aid-night',
);

/**
 * A scheduled item, with a time far enough out that a fresh clone never has to race it.
 *
 * Dated rather than relative so reseeding is idempotent — a `now + 7 days` would write a different
 * value on every run and make the row look edited when nothing touched it. Visitors do not see
 * this one, which is the point: it demonstrates the status rather than the sweep.
 *
 * **Fixed dates go stale, and these had.** Every date here was originally a year or so ahead and
 * had quietly slipped into the past, which cost more than it looks: the scheduled item had already
 * published, so the demo no longer showed the status it exists to show, and the events listing —
 * which filters to what is still to come — had almost nothing left to list. Pushed far enough out
 * that it will not need thinking about again soon. If a seeded date is in the past, that is the bug,
 * not the feature reading it.
 */
await ensureItem(
  handle,
  event.type,
  event.fields,
  {
    contentTypeId: event.type.id,
    title: 'Summer Orientation',
    status: 'scheduled',
    publishAt: '2030-08-01T08:00:00.000Z',
    userId: admin.id,
    data: {
      starts_at: '2030-08-24T13:00:00.000Z',
      location: 'Halloway Hall',
      audience: 'current',
      body: 'Two days of advising, registration, and campus tours for incoming students.',
    },
  },
  '/events/summer-orientation',
);

/**
 * The directory, seeded as a set rather than as a few examples.
 *
 * Six is the smallest number that makes the facet do something visible: enough that filtering
 * removes cards rather than reordering them, spread across both branches of the department tree so
 * "Academics" is demonstrably a *branch* count and not a term count, and with one joint appointment
 * so a multi-value taxonomy is on screen rather than merely supported.
 *
 * Hotspots are set high and off-centre because the card crops square from a portrait: without one,
 * every face is cropped at the chin, which is the failure the focal point exists to prevent and the
 * one nobody sees until there are faces.
 */
const people: {
  name: string;
  position: string;
  departments: string[];
  email: string;
  phone: string;
  hue: number;
}[] = [
  {
    name: 'Marguerite Okafor',
    position: 'Registrar',
    departments: ['Student Services'],
    email: 'm.okafor@example.edu',
    phone: '+1 555 0141',
    hue: 190,
  },
  {
    name: 'Tomas Reinholt',
    position: 'Director of Admissions',
    departments: ['Admissions'],
    email: 't.reinholt@example.edu',
    phone: '+1 555 0142',
    hue: 24,
  },
  {
    name: 'Priya Raghunathan',
    position: 'Professor of Biology',
    // The joint appointment. A facet that reads the first value drops her from Humanities, and she
    // is exactly the person somebody browsing either department expects to find.
    departments: ['Sciences', 'Humanities'],
    email: 'p.raghunathan@example.edu',
    phone: '+1 555 0143',
    hue: 145,
  },
  {
    name: 'Daniel Osei',
    position: 'Financial Aid Counsellor',
    departments: ['Financial Aid'],
    email: 'd.osei@example.edu',
    phone: '+1 555 0144',
    hue: 275,
  },
  {
    name: 'Wren Callaghan',
    position: 'Lecturer in Classics',
    departments: ['Humanities'],
    email: 'w.callaghan@example.edu',
    phone: '+1 555 0145',
    hue: 330,
  },
  {
    name: 'Ingrid Halvorsen',
    position: 'Laboratory Manager',
    departments: ['Sciences'],
    email: 'i.halvorsen@example.edu',
    phone: '+1 555 0146',
    hue: 62,
  },
];

for (const entry of people) {
  const slug = entry.name.toLowerCase().replace(/[^a-z]+/g, '-');

  const photo = await ensureAsset(
    `${slug}.png`,
    portrait(entry.hue),
    { width: 900, height: 1200 },
    `${entry.name}, ${entry.position}.`,
    entry.name,
    { x: 0.5, y: 0.28 },
  );

  await ensureItem(
    handle,
    person.type,
    person.fields,
    {
      contentTypeId: person.type.id,
      title: entry.name,
      status: 'published',
      userId: admin.id,
      data: {
        position: entry.position,
        photo,
        department: entry.departments.map(termId).filter(Boolean),
        email: entry.email,
        phone: entry.phone,
      },
    },
    `/people/${slug}`,
  );
}

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

// --- Reusable block ---------------------------------------------------------
//
// One library entry, referenced from two pages, so the feature is visible on a fresh clone: edit
// it once and both pages change. An ordinary block would have to be edited twice.

const existingReusable = await handle.db
  .selectFrom('reusable_blocks')
  .select('id')
  .where('name', '=', 'Visit prompt')
  .executeTakeFirst();

const visitPrompt =
  existingReusable ??
  (await createReusableBlock(handle.db, callToAction.fields, {
    name: 'Visit prompt',
    description: 'The standard nudge to book a campus tour. Used across admissions pages.',
    blockType: 'call_to_action',
    data: {
      text: 'Seeing the place is the fastest way to decide.',
      link_label: 'Book a campus visit',
      link_href: '/visit',
    },
    userId: admin.id,
  }));

if (!existingReusable) console.log('  reusable block "Visit prompt" (created)');

/*
 * Two text snippets, seeded so the feature is visible on a fresh clone.
 *
 * `tuition` is the case that prompted them: a number with a display form, so prose reads "$4,500"
 * while a chart could plot 4500. `application_deadline` is a date, which exercises the other half
 * of the derived formatting. Idempotent by `api_id`, like everything else here.
 */
const existingSnippets = new Set((await listSnippets(handle.db)).map((entry) => entry.api_id));

for (const snippet of [
  {
    api_id: 'tuition',
    name: 'Current tuition',
    description: 'In-state, per year. Reviewed each spring by the Business Office.',
    kind: 'number' as const,
    value: '4500',
    display: '$4,500',
  },
  {
    api_id: 'application_deadline',
    name: 'Application deadline',
    description: 'Autumn intake.',
    kind: 'date' as const,
    value: '2026-08-15',
    display: null,
  },
]) {
  if (existingSnippets.has(snippet.api_id)) continue;
  await createSnippet(handle.db, snippet);
  console.log(`  snippet "${snippet.api_id}" (created)`);
}

// Reference it from two published pages. Written directly rather than through `updateItem` because
// `ensureItem` has already returned early for an existing row, and this has to run either way.
for (const path of ['/admissions', '/financial-aid']) {
  const target = await handle.db
    .selectFrom('content_items')
    .select(['id', 'data'])
    .where('path', '=', path)
    .executeTakeFirst();

  if (!target) continue;

  const data = JSON.parse(target.data) as Record<string, unknown>;
  const sections = Array.isArray(data.sections) ? (data.sections as { ref?: string }[]) : [];
  if (sections.some((block) => block.ref === visitPrompt.id)) continue;

  data.sections = [
    ...sections,
    { id: newId(), type: 'call_to_action', data: {}, ref: visitPrompt.id },
  ];

  await handle.db
    .updateTable('content_items')
    .set({ data: JSON.stringify(data), updated_at: now() })
    .where('id', '=', target.id)
    .execute();
}

// Give Events a default social card but leave Pages without one, so both sides of the fallback
// are visible: an event inherits an image it never chose, a page shows the empty state.
if (socialCardId && !event.type.default_og_image_id) {
  await handle.db
    .updateTable('content_types')
    .set({ default_og_image_id: socialCardId, updated_at: now() })
    .where('id', '=', event.type.id)
    .execute();
  console.log('  type event (default social image set)');
}

// --- Menu -------------------------------------------------------------------
//
// Built last, because every entry references content that has to exist first. The mix is
// deliberate: pages, a nested child, a term archive, and an external address, so the resolution
// rules have something to demonstrate rather than being described in a comment.

const existingMenu = await getMenuByApiId(handle.db, 'main');
if (existingMenu && (await listMenuItems(handle.db, existingMenu.id)).length > 0) {
  console.log('  menu main (existing)');
} else {
  const menu = existingMenu ?? (await createMenu(handle.db, {
    api_id: 'main',
    name: 'Main navigation',
    description: 'The site header. Entries reference content, so moving a page keeps its link.',
  }));

  const pathId = async (path: string) =>
    (
      await handle.db
        .selectFrom('content_items')
        .select('id')
        .where('path', '=', path)
        .executeTakeFirstOrThrow()
    ).id;

  const admissionsEntry = await createMenuItem(handle.db, menu.id, {
    targetType: 'item',
    contentItemId: await pathId('/admissions'),
  });

  // Nested, to exercise the tree. Labelled shorter than the page title, which is the usual reason
  // to set a label at all.
  await createMenuItem(handle.db, menu.id, {
    targetType: 'item',
    contentItemId: await pathId('/admissions/apply'),
    label: 'Apply',
    parentId: admissionsEntry.id,
  });

  await createMenuItem(handle.db, menu.id, {
    targetType: 'item',
    contentItemId: await pathId('/financial-aid'),
  });

  await createMenuItem(handle.db, menu.id, {
    targetType: 'item',
    contentItemId: await pathId('/about'),
  });

  // A term archive, which is what makes the taxonomy visible on the public site at all.
  const studentServices = departments.terms.find((term) => term.name === 'Student Services');
  if (studentServices) {
    await createMenuItem(handle.db, menu.id, {
      targetType: 'term',
      termId: studentServices.id,
      label: 'Student Services',
    });
  }

  console.log(`  menu main (created with ${(await listMenuItems(handle.db, menu.id)).length} items)`);
}

// --- A release in progress ------------------------------------------------
//
// Seeded so the feature is visible rather than described. It stages two *published* pages and
// rewrites their content, which is the case releases exist for and the one nothing else in the CMS
// can do: editing a live page changes what visitors see immediately, so a coordinated change to
// several of them had no home before this.
//
// Left `open` rather than `scheduled` on purpose. A seeded scheduled release would publish itself
// the first time anybody ran the sweep, which turns "here is the feature" into "why did the demo
// site change on its own".

const { releases: existingReleases } = await listReleases(handle.db);
if (existingReleases.length > 0) {
  console.log(`  release ${existingReleases[0]!.name} (existing)`);
} else {
  const release = await createRelease(handle.db, {
    name: 'Tuition update 2027',
    description:
      'Next year’s figures, across every page that quotes one. All of it goes live together.',
    userId: admin.id,
  });

  const stageByPath = async (path: string, rewrite: (body: string) => string) => {
    const target = await handle.db
      .selectFrom('content_items')
      .select(['id', 'data'])
      .where('path', '=', path)
      .executeTakeFirst();
    if (!target) return false;

    await stageItem(handle.db, release.id, target.id, { actor: admin });

    const data = JSON.parse(target.data) as Record<string, unknown>;
    const body = typeof data.body === 'string' ? data.body : '';
    await updateStagedItem(handle.db, release.id, target.id, {
      data: { ...data, body: rewrite(body) },
    });
    return true;
  };

  let staged = 0;
  if (
    await stageByPath(
      '/financial-aid',
      (body) =>
        `<p>Tuition for the 2027–28 academic year is $38,400, with the average aid package ` +
        `covering 62% of it.</p>${body}`,
    )
  ) {
    staged += 1;
  }

  if (
    await stageByPath(
      '/admissions/apply',
      (body) => `<p>Applications for the 2027–28 year open on 1 September.</p>${body}`,
    )
  ) {
    staged += 1;
  }

  console.log(`  release ${release.name} (created, ${staged} items staged)`);
}

// --- A development API key -------------------------------------------------
//
// Without one the reference consumer in apps/web cannot read anything, and `npm run dev` from a
// fresh clone would give you a working CMS beside a site showing an error. The zero-setup story is
// a standing requirement, so the seed provides the key and apps/web/.env.example carries it.

const existingKey = await handle.db
  .selectFrom('api_keys')
  .select('id')
  .where('id', '=', await hashSessionToken(DEV_API_KEY))
  .executeTakeFirst();

/**
 * The scopes the seeded key carries.
 *
 * `search:write` joined `content:read` when the search log arrived, and the *existing* branch below
 * has to write them too rather than shrugging. A developer who seeded before this release already
 * has the row, so "exists, leave it" would hand them a key that reads content and silently cannot
 * report a search — which presents as an empty report screen with nothing anywhere explaining why.
 * Re-stating the scopes is idempotent, which is what the seed promises anyway.
 */
const DEV_KEY_SCOPES = JSON.stringify(['content:read', 'search:write']);

if (existingKey) {
  await handle.db
    .updateTable('api_keys')
    .set({ scopes: DEV_KEY_SCOPES, updated_at: now() })
    .where('id', '=', existingKey.id)
    .execute();

  console.log('  api key (existing, scopes refreshed)');
} else {
  const keyTimestamp = now();
  await handle.db
    .insertInto('api_keys')
    .values({
      // `id` is the hash of the token, exactly as `createApiKey` does it — the raw value is never
      // stored, not even for a key whose value is written down in a checked-in example file.
      id: await hashSessionToken(DEV_API_KEY),
      label: 'Local development (seeded)',
      token_prefix: DEV_API_KEY.slice(0, 12),
      scopes: DEV_KEY_SCOPES,
      expires_at: null,
      revoked_at: null,
      last_used_at: null,
      created_by: admin.id,
      created_at: keyTimestamp,
      updated_at: keyTimestamp,
    })
    .execute();

  console.log('  api key (created, for apps/web)');
}

// --- Search history ---------------------------------------------------------
//
// Settings -> Search is a report, and a report over an empty table demonstrates nothing — you
// cannot tell "this works and nobody has searched yet" from "this is broken". These rows are what
// the screen is for: terms that found something, terms that found nothing, and one term that used
// to fail and now succeeds, which is the case the "found nothing" list has to stop accusing.
//
// Dated relative to now so the 7- and 30-day windows both have content whenever the seed is run.

const existingSearches = await handle.db
  .selectFrom('search_queries')
  .select((eb) => eb.fn.countAll<number>().as('n'))
  .executeTakeFirst();

if (Number(existingSearches?.n ?? 0) > 0) {
  console.log('  search log (existing)');
} else {
  const daysAgo = (days: number, hour: number): string =>
    new Date(Date.now() - days * 86_400_000 + hour * 3_600_000).toISOString();

  /** `[query, resultCount, daysAgo, source]` — repeated entries are repeated searches. */
  const history: [string, number, number, 'page' | 'suggest' | 'abandoned'][] = [
    ['admissions', 4, 1, 'page'],
    ['admissions', 4, 2, 'suggest'],
    ['admissions', 4, 5, 'page'],
    ['financial aid', 3, 1, 'page'],
    ['financial aid', 3, 3, 'suggest'],
    ['Financial Aid', 3, 6, 'page'],
    ['apply', 3, 2, 'suggest'],
    ['open house', 0, 1, 'page'],
    ['open house', 0, 4, 'page'],
    ['transcripts', 0, 2, 'page'],
    ['parking permit', 0, 3, 'suggest'],
    ['nursi', 0, 2, 'abandoned'],
    // Failed for a week, then somebody wrote the page. The most recent search is what decides, so
    // this must appear under "most searched" and *not* under "found nothing".
    ['scholarships', 0, 9, 'page'],
    ['scholarships', 0, 8, 'page'],
    ['scholarships', 2, 1, 'page'],
  ];

  await handle.db
    .insertInto('search_queries')
    .values(
      history.map(([query, resultCount, days, source], index) => ({
        id: newId(),
        query,
        normalized: normalizeSearchQuery(query),
        result_count: resultCount,
        source,
        created_at: daysAgo(days, index % 12),
      })),
    )
    .execute();

  console.log(`  search log (created, ${history.length} searches)`);
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
