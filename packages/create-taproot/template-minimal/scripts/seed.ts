import {
  createContentType,
  createField,
  createItem,
  createMenu,
  createMenuItem,
  getContentTypeByApiId,
  getMenuByApiId,
  listFields,
  listMenuItems,
  migrateToLatest,
  type ContentTypeRow,
  type FieldRow,
} from '@taprootcms/core';

import { openDb } from './_db.ts';

/**
 * The starter content.
 *
 * A Page type, one page, and a menu — enough that the admin has something in it and the delivery
 * API returns something, so the first thing you see is a working CMS rather than an empty shell.
 * Delete this script once you have your own content model; nothing depends on it.
 *
 * **It creates no user.** The first administrator comes from the setup screen at `/admin`, which
 * exists for exactly this and closes behind itself atomically the moment an account exists. A seed
 * that made an account with a known password would put one in every scaffolded project, and the
 * ones nobody changed would be the ones that mattered.
 *
 * **Idempotent.** Everything checks for what it would create first, so re-running after adding a
 * field is safe and does not produce a second copy of the home page.
 */

const { handle, target } = await openDb();

console.log(`Seeding ${target}`);

const { error } = await migrateToLatest(handle.db);
if (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  await handle.destroy();
  process.exit(1);
}

// --- The Page content type --------------------------------------------------

async function ensureType(): Promise<{ type: ContentTypeRow; fields: FieldRow[] }> {
  const existing = await getContentTypeByApiId(handle.db, 'page');
  if (existing) {
    console.log('  content type page (existing)');
    return { type: existing, fields: await listFields(handle.db, existing.id) };
  }

  const type = await createContentType(handle.db, {
    api_id: 'page',
    name: 'Page',
    name_plural: 'Pages',
    // `page` nests under a parent, which is what gives you /admissions/apply rather than a flat
    // list. Use `collection` for things like events, which are addressed by a URL prefix instead.
    kind: 'page',
    description: 'A page on the site.',
    icon: null,
    url_prefix: null,
    title_field: 'title',
    default_og_image_id: null,
  });

  const definitions = [
    {
      api_id: 'summary',
      label: 'Summary',
      type: 'text' as const,
      required: false,
      localized: false,
      help_text: 'One or two sentences. Shown in listings.',
      config: { multiline: true, maxLength: 300 },
    },
    {
      api_id: 'body',
      label: 'Body',
      type: 'richtext' as const,
      required: false,
      localized: false,
      help_text: null,
      config: {},
    },
    {
      api_id: 'show_in_nav',
      label: 'Show in navigation',
      type: 'boolean' as const,
      required: false,
      localized: false,
      help_text: null,
      config: { defaultValue: false },
    },
  ];

  const fields: FieldRow[] = [];
  for (const [position, definition] of definitions.entries()) {
    fields.push(await createField(handle.db, type.id, { ...definition, position }));
  }

  console.log('  content type page (created)');
  return { type, fields };
}

const { type, fields } = await ensureType();

// --- A home page ------------------------------------------------------------

const existingHome = await handle.db
  .selectFrom('content_items')
  .select('id')
  .where('path', '=', '/home')
  .executeTakeFirst();

const homeId =
  existingHome?.id ??
  (
    await createItem(handle, type, fields, {
      contentTypeId: type.id,
      title: 'Home',
      status: 'published',
      data: {
        summary: 'The first page in your new CMS.',
        body:
          '<p>This page was created by the starter seed. Edit it, or delete it and write your own.</p>' +
          '<h2>What to do next</h2>' +
          '<p>Add fields to the Page type under Settings, or create another content type for the ' +
          'kinds of content this site actually has.</p>',
        show_in_nav: true,
      },
    })
  ).id;

console.log(`  page /home (${existingHome ? 'existing' : 'created'})`);

// --- A main menu ------------------------------------------------------------
//
// Menu items reference the page rather than storing its URL, which is the whole point: moving the
// page keeps its place in the navigation, and unpublishing it removes the entry, with no menu edit.

const existingMenu = await getMenuByApiId(handle.db, 'main');

if (existingMenu && (await listMenuItems(handle.db, existingMenu.id)).length > 0) {
  console.log('  menu main (existing)');
} else {
  const menu =
    existingMenu ??
    (await createMenu(handle.db, {
      api_id: 'main',
      name: 'Main navigation',
      description: 'The site header.',
    }));

  await createMenuItem(handle.db, menu.id, { targetType: 'item', contentItemId: homeId });
  console.log('  menu main (created)');
}

console.log('\nSeeded. Run `npm run dev` and open http://localhost:4321 to create your account.');
await handle.destroy();
