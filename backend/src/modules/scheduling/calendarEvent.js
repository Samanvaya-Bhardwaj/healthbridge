import { buildIcs, mailAddress } from '../../core/calendar/ics.js';

/** Minutes before the start that the calendar reminds (the app's own reminders still run). */
const ALARM_MINUTES = 30;

/**
 * What a calendar entry needs about one appointment, read in the caller's transaction (the
 * patient side's actor transaction, or the `notifications` system purpose).
 * The UID comes from the first booking of a reschedule chain, so one calendar entry follows
 * the appointment from time to time; `depth` is how many times it moved.
 */
export async function calendarFacts(trx, appointmentId) {
  const row = await trx('appointments as a')
    .join('doctors as d', 'd.id', 'a.doctor_id')
    // The patient row may be hidden by RLS (notifications); callers then pass the name.
    .leftJoin('patients as p', 'p.id', 'a.patient_id')
    .leftJoin('clinics as c', 'c.id', 'a.clinic_id')
    .where('a.id', appointmentId)
    .first(
      'a.id',
      'a.status',
      'a.mode',
      'a.starts_at',
      'a.ends_at',
      'd.professional_name as doctor_name',
      'p.full_name as patient_name',
      'p.user_id as patient_user_id',
      'c.name as clinic_name',
      'c.address_line as clinic_address_line',
      'c.city as clinic_city',
      'c.state as clinic_state',
      'c.postal_code as clinic_postal_code',
    );
  if (!row) return null;
  const { rows } = await trx.raw(
    `WITH RECURSIVE chain AS (
       SELECT id, rescheduled_from_id, 0 AS depth FROM appointments WHERE id = ?
       UNION ALL
       SELECT a.id, a.rescheduled_from_id, chain.depth + 1
         FROM appointments a JOIN chain ON a.id = chain.rescheduled_from_id
        WHERE chain.depth < 50
     )
     SELECT id, depth FROM chain ORDER BY depth DESC LIMIT 1`,
    [appointmentId],
  );
  return { ...row, root_id: rows[0]?.id ?? row.id, depth: Number(rows[0]?.depth ?? 0) };
}

/**
 * @param {NonNullable<Awaited<ReturnType<typeof calendarFacts>>>} facts
 * @param {{ method: 'REQUEST'|'CANCEL'|'PUBLISH', appUrl: string, from: string,
 *   attendee?: { email: string, name?: string }|null, forDependent?: boolean,
 *   patientName?: string, stamp?: Date }} options
 */
export function appointmentIcs(
  facts,
  { method, appUrl, from, attendee, forDependent, patientName, stamp },
) {
  const reference = facts.id.slice(-8).toUpperCase();
  const whose = forDependent ? `${facts.patient_name ?? patientName ?? 'the patient'}'s ` : '';
  const online = facts.mode === 'online';
  const summary = online
    ? `HealthBridge: ${whose}online consultation with ${facts.doctor_name}`
    : `HealthBridge: ${whose}visit to ${facts.doctor_name}${facts.clinic_name ? ` at ${facts.clinic_name}` : ''}`;
  const address = [
    facts.clinic_name,
    facts.clinic_address_line,
    facts.clinic_city,
    facts.clinic_state,
    facts.clinic_postal_code,
  ]
    .filter(Boolean)
    .join(', ');
  const url = `${appUrl.replace(/\/$/, '')}/app/appointments/${facts.id}`;
  const description = [
    `Booking reference ${reference}.`,
    `Open it in HealthBridge: ${url}`,
    online
      ? 'Join from the appointment page; the waiting room opens 15 minutes before the start.'
      : 'Please arrive 10 minutes early and check in at reception.',
  ].join('\n');
  return buildIcs({
    method,
    uid: `appointment-${facts.root_id}@healthbridge`,
    // Each move and the cancellation are later versions of the same entry.
    sequence: facts.depth * 2 + (method === 'CANCEL' ? 1 : 0),
    startsAt: facts.starts_at,
    endsAt: facts.ends_at,
    summary,
    description,
    location: online ? 'Online video consultation (HealthBridge)' : address || 'Clinic',
    url,
    organizer: { email: mailAddress(from), name: 'HealthBridge' },
    attendee: attendee ?? null,
    alarmMinutes: ALARM_MINUTES,
    stamp,
  });
}

/** Templates whose email carries the calendar invitation, and how. */
export const CALENDAR_TEMPLATES = Object.freeze({
  appointment_booked: 'REQUEST',
  payment_confirmed: 'REQUEST',
  appointment_rescheduled: 'REQUEST',
  appointment_cancelled: 'CANCEL',
  appointment_withdrawn: 'CANCEL',
});
