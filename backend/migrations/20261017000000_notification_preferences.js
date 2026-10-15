/**
 * Step 8: notification preferences (account settings).
 *
 * One row per user who changed something; no row means every category is on. Email (and
 * SMS where it exists) can be turned off per category. The in-app inbox always receives
 * everything, and safety messages are sent whatever the preference
 * (@healthbridge/shared ALWAYS_SENT_TEMPLATES). A message not sent because of a preference
 * is recorded as a skipped delivery (skip_reason 'preference'), so it stays auditable.
 *
 * RLS: a user reads and changes only their own row; the notification workers (system
 * purpose `notifications`) read rows to decide.
 */

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE notification_preferences (
      user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
      email_appointments boolean NOT NULL DEFAULT true,
      email_payments boolean NOT NULL DEFAULT true,
      email_reminders boolean NOT NULL DEFAULT true,
      email_documents boolean NOT NULL DEFAULT true,
      email_follow_ups boolean NOT NULL DEFAULT true,
      sms boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
    CREATE POLICY notification_preferences_select ON notification_preferences FOR SELECT
      USING (user_id = authz.current_user_id() OR authz.system_purpose() = 'notifications');
    CREATE POLICY notification_preferences_insert ON notification_preferences FOR INSERT
      WITH CHECK (user_id = authz.current_user_id());
    CREATE POLICY notification_preferences_update ON notification_preferences FOR UPDATE
      USING (user_id = authz.current_user_id())
      WITH CHECK (user_id = authz.current_user_id());
    COMMENT ON TABLE notification_preferences IS
      'Per-category email/SMS preferences (the inbox always receives everything).';
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS notification_preferences');
}
