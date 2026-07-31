import type { Kysely } from 'kysely';

/**
 * What two-factor authentication needs beyond the `totp_secrets` table Phase 0 left behind.
 *
 * That table already had `secret` and `verified_at` — the seam was right. Three things were
 * missing, and each of them is the difference between a demo and something worth relying on.
 */
export async function up(db: Kysely<any>): Promise<void> {
  /**
   * The last time step accepted for this secret.
   *
   * Without it a code works for its whole period plus the drift window, so one observed over a
   * shoulder — or captured by a phishing page and relayed — is good for up to ninety seconds.
   * Storing the step spent turns a stolen code into a single-use one.
   */
  await db.schema.alterTable('totp_secrets').addColumn('last_used_step', 'integer').execute();

  /**
   * Recovery codes, hashed at rest and single-use.
   *
   * The failure mode two-factor introduces is losing the phone, and without recovery that means an
   * administrator resetting it — or, for the last remaining admin, a database console. Ten codes
   * generated once at enrolment is the standard answer and the reason enrolment can be
   * recommended at all.
   *
   * Hashed with plain SHA-256 rather than PBKDF2, deliberately: these are 40 bits of CSPRNG
   * output from an alphabet the user never chose, so there is no dictionary to run against them
   * and nothing for a slow hash to buy.
   */
  await db.schema
    .createTable('totp_recovery_codes')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('used_at', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('totp_recovery_codes_user_idx')
    .on('totp_recovery_codes')
    .column('user_id')
    .execute();

  /**
   * A half-finished sign-in, between the password and the second factor.
   *
   * A row rather than a signed cookie, because this has to be **revocable and single-use**: it
   * represents "this password was correct", which is most of the way in. A self-contained token
   * would stay valid for its lifetime no matter what happened to the account in between, and
   * could be replayed.
   *
   * Short-lived on purpose — a few minutes is long enough to fetch a phone and not long enough to
   * be worth stealing.
   */
  await db.schema
    .createTable('login_challenges')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('expires_at', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('login_challenges').execute();
  await db.schema.dropTable('totp_recovery_codes').execute();
  await db.schema.alterTable('totp_secrets').dropColumn('last_used_step').execute();
}
