import type { Kysely } from 'kysely';

/**
 * AI assist: which provider, which model, and which features are switched on.
 *
 * ## No key is stored here, and that is the whole shape of the feature
 *
 * Provider keys come from the **environment** (`TAPROOT_ANTHROPIC_API_KEY` and friends), exactly as
 * `TAPROOT_CRON_SECRET` and the mail webhook token do, and Settings reports each one as set or
 * not-set and never shows a value. A key column would be the first secret at rest in this database,
 * and storing it in the clear is not an option while a `wrangler d1 export` is already a credential
 * store — so it would need encryption, which means a new required secret to hold the encryption key,
 * which has to have a working default for `npm run dev`, and a default encryption key is not a
 * secret. The environment already solves this and needs nothing built.
 *
 * ## Why provider and model *are* stored
 *
 * They are configuration rather than credentials, and an operator changing model should not be a
 * redeploy. Null provider means "nobody has chosen", which is deliberately **not** the same as "no
 * key is configured": a deployment can hold a key and leave the feature off, and one can have the
 * feature on with the key missing — the second is a misconfiguration Settings → System names, rather
 * than something that silently half-works. Deriving the provider from whichever key happens to be
 * present would make both states unsayable and would pick for the operator when several are set.
 *
 * ## Two feature toggles, not one
 *
 * Alt text is a description of an image the model can actually see. A meta description is a claim
 * about what a page is *for*, which is a different kind of guess with a different failure. Wanting
 * the first and not the second is reasonable, and one blanket switch makes it unexpressible.
 *
 * Both default to off. A version bump must not start spending somebody's API credit because they
 * happened to have a key in the environment for something else.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('settings').addColumn('ai_provider', 'text').execute();
  await db.schema.alterTable('settings').addColumn('ai_model', 'text').execute();
  await db.schema
    .alterTable('settings')
    .addColumn('ai_alt_text', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable('settings')
    .addColumn('ai_seo', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('settings').dropColumn('ai_seo').execute();
  await db.schema.alterTable('settings').dropColumn('ai_alt_text').execute();
  await db.schema.alterTable('settings').dropColumn('ai_model').execute();
  await db.schema.alterTable('settings').dropColumn('ai_provider').execute();
}
