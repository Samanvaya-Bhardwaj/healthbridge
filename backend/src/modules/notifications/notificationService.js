import { withSystem } from '../../core/db/actorContext.js';
import { newId } from '../../core/db/ids.js';
import { domainMetrics, timed } from '../../core/metrics/domain.js';
import { SMS_TEMPLATES, renderTemplate } from './templates.js';

/**
 * Which template an outbox event produces, decided from the event payload (the state at
 * the time of the change). Returns null when the event needs no notification.
 */
export function templateForEvent(eventType, payload = {}) {
  switch (eventType) {
    case 'appointment.booked':
      if (payload.rescheduledFromId) return 'appointment_rescheduled';
      return payload.status === 'pending_payment' ? 'payment_required' : 'appointment_booked';
    case 'appointment.cancelled':
      // A reschedule cancels the old booking; the new booking's event says "rescheduled".
      return payload.reason === 'rescheduled' ? null : 'appointment_cancelled';
    case 'appointment.expired':
      return 'appointment_expired';
    case 'payment.captured':
      // A late capture is refunded; the refund notice covers it.
      return payload.confirmedAppointment ? 'payment_confirmed' : null;
    case 'payment.failed':
      return 'payment_failed';
    case 'payment.refunded':
      return 'payment_refunded';
    case 'document.available':
      return 'document_available';
    case 'document.rejected':
      return 'document_rejected';
    // M9: generic wording; never medicines, notes or diagnoses.
    case 'prescription.signed':
      return 'prescription_available';
    case 'consultation.completed':
      if (payload.outcome === 'physical_visit_required') return 'in_person_visit_requested';
      if (payload.outcome === 'emergency_escalation') return 'emergency_guidance';
      return null;
    default:
      return null;
  }
}

/**
 * Notification consumers (ADR-0020). Workers pass identifiers; this service loads the
 * minimum it needs (appointment schedule, doctor/clinic names, recipient contacts) in a
 * `notifications` system transaction. Every delivery has a dedupe key: a redelivered job
 * finds the delivery already `sent` and does nothing. The delivery row is locked while
 * sending, so two workers cannot send the same message concurrently.
 */
export function createNotificationService({
  knex,
  appointments,
  provider,
  logger,
  config,
  now = () => new Date(),
}) {
  async function loadContext(trx, appointmentId) {
    const appointment = await appointments.findById(trx, appointmentId);
    if (!appointment) return null;
    const rule = appointment.availability_rule_id
      ? await trx('availability_rules')
          .where({ id: appointment.availability_rule_id })
          .first('timezone')
      : null;
    const { rows: recipients } = await trx.raw('SELECT * FROM authz.notification_recipients(?)', [
      appointment.patient_id,
    ]);
    return {
      appointment,
      recipients,
      base: {
        patientName: recipients[0]?.patient_name ?? 'the patient',
        doctorName: appointment.doctor_name,
        clinicName: appointment.clinic_name ?? null,
        mode: appointment.mode,
        startsAt: appointment.starts_at,
        timezone: rule?.timezone ?? 'Asia/Kolkata',
        reference: appointment.id.slice(-8).toUpperCase(),
      },
    };
  }

  /**
   * Sends one message at most once per dedupe key.
   * @returns {Promise<'sent'|'duplicate'>}
   */
  async function deliver({
    dedupeKey,
    template,
    channel,
    recipientUserId,
    appointmentId,
    sourceEventId,
    send,
  }) {
    const outcome = await withSystem(knex, 'notifications', async (trx) => {
      await trx('notification_deliveries')
        .insert({
          id: newId(),
          dedupe_key: dedupeKey,
          template,
          channel,
          recipient_user_id: recipientUserId,
          appointment_id: appointmentId,
          source_event_id: sourceEventId ?? null,
        })
        .onConflict('dedupe_key')
        .ignore();
      const row = await trx('notification_deliveries')
        .where({ dedupe_key: dedupeKey })
        .forUpdate()
        .first();
      if (row.status === 'sent' || row.status === 'skipped') return { status: 'duplicate' };
      try {
        await timed(domainMetrics.notificationLatency, { channel }, send);
      } catch (err) {
        await trx('notification_deliveries')
          .where({ id: row.id })
          .update({
            status: 'failed',
            attempts: row.attempts + 1,
            last_error: `${err.kind ?? err.name ?? 'error'}`.slice(0, 300),
          });
        return { status: 'failed', err };
      }
      await trx('notification_deliveries')
        .where({ id: row.id })
        .update({ status: 'sent', sent_at: now(), attempts: row.attempts + 1, last_error: null });
      return { status: 'sent' };
    });
    if (outcome.status === 'failed') {
      domainMetrics.notificationsFailed.inc({ channel });
      throw outcome.err; // the job retries with backoff
    }
    if (outcome.status === 'sent') domainMetrics.notificationsSent.inc({ channel, template });
    return outcome.status;
  }

  async function sendToRecipients(ctx, template, vars, keyPrefix, sourceEventId) {
    const results = [];
    for (const recipient of ctx.recipients) {
      const content = renderTemplate(template, {
        ...ctx.base,
        ...vars,
        recipientName: recipient.display_name,
        relationship: recipient.relationship,
      });
      results.push(
        await deliver({
          dedupeKey: `${keyPrefix}-${recipient.user_id}-email`,
          template,
          channel: 'email',
          recipientUserId: recipient.user_id,
          appointmentId: ctx.appointment.id,
          sourceEventId,
          send: () =>
            provider.sendEmail({
              to: recipient.email,
              subject: content.subject,
              text: content.text,
              template,
            }),
        }),
      );
      if (recipient.phone_e164 && content.sms && SMS_TEMPLATES.includes(template)) {
        results.push(
          await deliver({
            dedupeKey: `${keyPrefix}-${recipient.user_id}-sms`,
            template,
            channel: 'sms',
            recipientUserId: recipient.user_id,
            appointmentId: ctx.appointment.id,
            sourceEventId,
            send: () => provider.sendSMS({ to: recipient.phone_e164, text: content.sms, template }),
          }),
        );
      }
    }
    return results;
  }

  /**
   * Outbox consumer.
   * @param {{ eventId: string, eventType: string, aggregateId: string, payload: Record<string, any> }} event
   */
  /** Document events: patient-side recipients, generic text, no appointment context. */
  async function handleDocumentEvent({ eventId, template, payload }) {
    const recipients = await withSystem(knex, 'notifications', async (trx) => {
      const { rows } = await trx.raw('SELECT * FROM authz.notification_recipients(?)', [
        payload.patientId,
      ]);
      return rows;
    });
    if (!recipients.length) return { outcome: 'no_recipients' };
    const results = [];
    for (const r of recipients) {
      const content = renderTemplate(template, {
        recipientName: r.display_name,
        patientName: r.patient_name,
        relationship: r.relationship,
      });
      results.push(
        await deliver({
          dedupeKey: `${eventId}-${template}-${r.user_id}-email`,
          template,
          channel: 'email',
          recipientUserId: r.user_id,
          appointmentId: null,
          sourceEventId: eventId,
          send: () =>
            provider.sendEmail({
              to: r.email,
              subject: content.subject,
              text: content.text,
              template,
            }),
        }),
      );
    }
    return { outcome: results.every((x) => x === 'duplicate') ? 'duplicate' : 'sent', template };
  }

  async function handleEvent({ eventId, eventType, aggregateId, payload = {} }) {
    const template = templateForEvent(eventType, payload);
    if (!template) return { outcome: 'no_notification' };
    if (eventType.startsWith('document.')) {
      return handleDocumentEvent({ eventId, template, payload });
    }
    const appointmentId = payload.appointmentId ?? aggregateId;
    const ctx = await withSystem(knex, 'notifications', (trx) => loadContext(trx, appointmentId));
    if (!ctx) return { outcome: 'appointment_not_found' };
    if (!ctx.recipients.length) return { outcome: 'no_recipients' };
    const vars = {
      amountPaise:
        payload.amountPaise ?? (template === 'payment_required' ? ctx.appointment.fee_paise : 0),
      currency: payload.currency ?? ctx.appointment.currency?.trim() ?? 'INR',
    };
    const results = await sendToRecipients(ctx, template, vars, `${eventId}-${template}`, eventId);
    return { outcome: results.every((r) => r === 'duplicate') ? 'duplicate' : 'sent', template };
  }

  // ── Reminders (the database is the source of truth) ─────────────

  /**
   * Creates reminder rows that are due now (at most one per appointment per sweep: the
   * nearest offset wins, so a late sweep never sends both the 24-hour and the 1-hour
   * reminder) and returns pending reminders that need a job — new ones and ones whose
   * job may have been lost (e.g. Redis restarted).
   * @returns {Promise<string[]>} reminder ids to enqueue
   */
  async function collectDueReminders({ limit = 200, requeueAfterMinutes = 5 } = {}) {
    const offsets = config.notifications.reminderOffsetsMinutes;
    return withSystem(knex, 'scheduler', async (trx) => {
      await trx.raw(
        `INSERT INTO appointment_reminders (id, appointment_id, offset_minutes, occurrence_starts_at, due_at)
         SELECT gen_random_uuid(), a.id, o.mins, a.starts_at, a.starts_at - make_interval(mins => o.mins)
           FROM appointments a CROSS JOIN unnest(?::int[]) AS o(mins)
          WHERE a.status = 'confirmed'
            AND a.starts_at > now()
            AND a.starts_at - make_interval(mins => o.mins) <= now()
            AND a.confirmed_at <= a.starts_at - make_interval(mins => o.mins)
            AND NOT EXISTS (
              SELECT 1 FROM unnest(?::int[]) AS o2(mins)
               WHERE o2.mins < o.mins AND a.starts_at - make_interval(mins => o2.mins) <= now()
                 AND a.confirmed_at <= a.starts_at - make_interval(mins => o2.mins))
         ON CONFLICT DO NOTHING`,
        [offsets, offsets],
      );
      const due = await trx('appointment_reminders')
        .where({ status: 'pending' })
        .where((w) =>
          w
            .whereNull('enqueued_at')
            .orWhere(
              'enqueued_at',
              '<',
              trx.raw(`now() - make_interval(mins => ?)`, [requeueAfterMinutes]),
            ),
        )
        .orderBy('due_at')
        .limit(limit)
        .forUpdate()
        .skipLocked();
      if (due.length) {
        await trx('appointment_reminders')
          .whereIn(
            'id',
            due.map((r) => r.id),
          )
          .update({ enqueued_at: trx.fn.now(), enqueue_count: trx.raw('enqueue_count + 1') });
      }
      return due.map((r) => r.id);
    });
  }

  /** Reminder job: sends only if the appointment is still the same confirmed occurrence. */
  async function sendReminder(reminderId) {
    const prepared = await withSystem(knex, 'notifications', async (trx) => {
      const reminder = await trx('appointment_reminders').where({ id: reminderId }).first();
      if (!reminder || reminder.status !== 'pending') return { done: 'not_pending' };
      const ctx = await loadContext(trx, reminder.appointment_id);
      const appt = ctx?.appointment;
      let skip = null;
      if (!appt || appt.status !== 'confirmed') skip = `appointment_${appt?.status ?? 'missing'}`;
      else if (
        new Date(appt.starts_at).getTime() !== new Date(reminder.occurrence_starts_at).getTime()
      ) {
        skip = 'occurrence_changed';
      } else if (new Date(appt.starts_at) <= now()) skip = 'appointment_started';
      if (skip) {
        await trx('appointment_reminders')
          .where({ id: reminderId, status: 'pending' })
          .update({ status: 'skipped', skip_reason: skip, processed_at: trx.fn.now() });
        return { done: `skipped_${skip}` };
      }
      return { reminder, ctx };
    });
    if (prepared.done) return { outcome: prepared.done };
    const { reminder, ctx } = prepared;
    const occurrence = new Date(reminder.occurrence_starts_at).getTime();
    const results = await sendToRecipients(
      ctx,
      'appointment_reminder',
      { offsetMinutes: reminder.offset_minutes },
      `reminder-${reminder.appointment_id}-${reminder.offset_minutes}-${occurrence}`,
      null,
    );
    await withSystem(knex, 'notifications', (trx) =>
      trx('appointment_reminders')
        .where({ id: reminderId, status: 'pending' })
        .update({ status: 'sent', processed_at: trx.fn.now() }),
    );
    if (results.includes('sent')) domainMetrics.remindersSent.inc();
    logger?.info({ reminderId, offsetMinutes: reminder.offset_minutes }, 'reminder processed');
    return { outcome: results.every((r) => r === 'duplicate') ? 'duplicate' : 'sent' };
  }

  return { handleEvent, collectDueReminders, sendReminder, deliver };
}
