import type { Kysely } from 'kysely';

/**
 * A per-content-type fallback OG image.
 *
 * The scope doc asks for the item's OG image to "fall back to a default per content type if
 * unset", and this is that default. Most items never get their own social image; a type-level one
 * means Events share an events card and Pages share a campus shot without anyone picking a file
 * per item.
 *
 * `set null` rather than `cascade` on delete, matching the rule menu items follow: deleting an
 * image must not delete the content type that referenced it. The type simply loses its default
 * and falls through to no image, which is the state it was in before anyone set one.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('content_types')
    .addColumn('default_og_image_id', 'text', (col) =>
      col.references('media.id').onDelete('set null'),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('content_types').dropColumn('default_og_image_id').execute();
}
