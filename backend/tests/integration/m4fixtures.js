// M4 fixtures: paid bookings, checkout and signed (fake-provider) webhooks.

import request from 'supertest';
import { authHeader } from './harness.js';
import { api, createPatient, createVerifiedDoctor, expectOk, linkCare } from './m2fixtures.js';

export const FEE = 50_000; // ₹500.00

export const isoDate = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** Every weekday 06:00–22:00 IST, 15-minute slots, with a fee. */
export async function publishPaidWeek(
  h,
  doctor,
  { feePaise = FEE, mode = 'online', clinicId } = {},
) {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    expectOk(
      await api(h, doctor).post('/doctors/me/availability', {
        mode,
        ...(clinicId ? { clinicId } : {}),
        weekday,
        startTime: '06:00',
        endTime: '22:00',
        slotMinutes: 15,
        validFrom: isoDate(-1),
        feePaise,
      }),
      201,
    );
  }
}

/** Doctor with a paid weekly schedule and a patient in their care team. */
export async function paidSetup(h, admin, label, opts = {}) {
  const doctor = await createVerifiedDoctor(h, admin, `${label}-doc`);
  await publishPaidWeek(h, doctor, opts);
  const patient = await createPatient(h, `${label}-pt`);
  await linkCare(h, patient, doctor, opts.clinicId ? { clinicId: opts.clinicId } : {});
  return { doctor, patient };
}

/** Books the n-th slot `days` days ahead. */
export async function bookSlot(h, patient, doctor, { index = 0, days = 2, mode = 'online' } = {}) {
  const qs = new URLSearchParams({ from: isoDate(days), to: isoDate(days + 1), mode });
  const slots = expectOk(await api(h, patient).get(`/doctors/${doctor.doctor.id}/slots?${qs}`));
  const slot = slots[index];
  return expectOk(
    await api(h, patient).post('/appointments', {
      patientId: patient.patient.id,
      doctorId: doctor.doctor.id,
      startsAt: slot.startsAt,
      mode,
      ...(slot.clinicId ? { clinicId: slot.clinicId } : {}),
      reason: 'Synthetic: follow-up consultation',
    }),
    201,
  );
}

export const checkout = (h, who, appointmentId) =>
  api(h, who).post(`/appointments/${appointmentId}/payment`);

/** Posts a signed provider webhook (raw body) to the public webhook endpoint. */
export function postWebhook(h, { rawBody, headers }, provider = 'fake') {
  // Send the exact bytes as a string (supertest would JSON-serialise a Buffer).
  return request(h.app)
    .post(`/api/v1/webhooks/payments/${provider}`)
    .set(headers)
    .send(rawBody.toString('utf8'));
}

/** The webhook a provider sends when the checkout's payment is captured. */
export function capturedEvent(h, co, appointmentId, overrides = {}) {
  return h.paymentProvider.webhook('payment.captured', {
    orderId: co.checkout.orderId,
    amountPaise: co.payment.amountPaise,
    notes: { hb_payment_id: co.payment.id, hb_appointment_id: appointmentId },
    ...overrides,
  });
}

/** Booked + checkout started. */
export async function pendingPaid(h, patient, doctor, opts = {}) {
  const appointment = await bookSlot(h, patient, doctor, opts);
  const co = expectOk(await checkout(h, patient, appointment.id));
  return { appointment, co };
}

/** Booked, paid and confirmed through a verified webhook. */
export async function paidAppointment(h, patient, doctor, opts = {}) {
  const { appointment, co } = await pendingPaid(h, patient, doctor, opts);
  expectOk(await postWebhook(h, capturedEvent(h, co, appointment.id)));
  return { appointment, co };
}

export const expireHoldNow = (h, appointmentId) =>
  h
    .ownerKnex('appointments')
    .where({ id: appointmentId })
    .update({ hold_expires_at: h.ownerKnex.raw("now() - interval '1 minute'") });

export const appointmentRow = (h, id) => h.ownerKnex('appointments').where({ id }).first();
export const paymentRow = (h, appointmentId) =>
  h.ownerKnex('payments').where({ appointment_id: appointmentId }).first();
export const refundsOf = (h, paymentId) =>
  h.ownerKnex('payment_refunds').where({ payment_id: paymentId }).orderBy('created_at');
export const ledgerOf = (h, paymentId) =>
  h.ownerKnex('ledger_entries').where({ payment_id: paymentId }).orderBy('created_at');
export const outboxOf = (h, aggregateId) =>
  h.ownerKnex('outbox_events').where({ aggregate_id: aggregateId }).orderBy('occurred_at');

export const withKey = (who, key) => ({ ...authHeader(who.session), 'Idempotency-Key': key });
