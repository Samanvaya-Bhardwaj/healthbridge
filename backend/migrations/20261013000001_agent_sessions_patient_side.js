/**
 * M13.1 pre-merge hardening (ADR-0029): `agent_sessions` RLS also checks the patient.
 *
 * The first policies confined rows to their owning user only. The backend re-checks the
 * patient scope with AccessPolicy on every turn, but the database itself did not: a row
 * could name any patient, and a guardian whose guardianship ended could still read and
 * update the sessions they had opened for that dependent.
 *
 * Now every SELECT, INSERT and UPDATE by a user also requires
 * `authz.is_patient_side(patient_id)`: the patient themself or an ACTIVE guardian, with
 * either `view` or `manage` scope (the documented guardian use of the read-only M13.1
 * tools). So, in the database itself:
 *   - a session can only be created for a patient on the user's side;
 *   - rows naming an unrelated patient are invisible and unchangeable;
 *   - when a guardianship ends, its sessions disappear for the former guardian at once
 *     (they remain only for the retention sweep, which deletes them on expiry).
 * Nothing else changes: the sweep's system purpose, the delete rule and the guard trigger
 * are untouched, and no other table's policies are modified.
 */

const OWNER_AND_PATIENT_SIDE =
  'user_id = authz.current_user_id() AND authz.is_patient_side(patient_id)';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw(`
    DROP POLICY agent_sessions_own_select ON agent_sessions;
    DROP POLICY agent_sessions_own_insert ON agent_sessions;
    DROP POLICY agent_sessions_own_update ON agent_sessions;

    CREATE POLICY agent_sessions_patient_side_select ON agent_sessions FOR SELECT USING (
      (${OWNER_AND_PATIENT_SIDE}) OR authz.system_purpose() = 'assistant');
    CREATE POLICY agent_sessions_patient_side_insert ON agent_sessions FOR INSERT
      WITH CHECK (${OWNER_AND_PATIENT_SIDE});
    CREATE POLICY agent_sessions_patient_side_update ON agent_sessions FOR UPDATE
      USING (${OWNER_AND_PATIENT_SIDE}) WITH CHECK (${OWNER_AND_PATIENT_SIDE});
  `);
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.raw(`
    DROP POLICY agent_sessions_patient_side_select ON agent_sessions;
    DROP POLICY agent_sessions_patient_side_insert ON agent_sessions;
    DROP POLICY agent_sessions_patient_side_update ON agent_sessions;

    CREATE POLICY agent_sessions_own_select ON agent_sessions FOR SELECT USING (
      user_id = authz.current_user_id() OR authz.system_purpose() = 'assistant');
    CREATE POLICY agent_sessions_own_insert ON agent_sessions FOR INSERT
      WITH CHECK (user_id = authz.current_user_id());
    CREATE POLICY agent_sessions_own_update ON agent_sessions FOR UPDATE
      USING (user_id = authz.current_user_id()) WITH CHECK (user_id = authz.current_user_id());
  `);
}
