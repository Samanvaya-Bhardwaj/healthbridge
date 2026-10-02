import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { authHeader, auditFor, createHarness } from './harness.js';
import {
  api,
  createClinicWithAdmin,
  createPatient,
  createPlatformAdmin,
  expectOk,
} from './m2fixtures.js';
import {
  FEE,
  appointmentRow,
  bookSlot,
  capturedEvent,
  checkout,
  expireHoldNow,
  ledgerOf,
  outboxOf,
  paidAppointment,
  paidSetup,
  paymentRow,
  pendingPaid,
  postWebhook,
  refundsOf,
  withKey,
} from './m4fixtures.js';
import { counterValue, domainMetrics } from '../../src/core/metrics/domain.js';

let h;
let admin;
beforeAll(async () => {
  h = await createHarness();
  admin = await createPlatformAdmin(h);
});
afterAll(async () => {
  await h.close();
});

describe('checkout (order creation)', () => {
  it('a paid booking is held PENDING_PAYMENT; checkout uses the server-side amount and is reused', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'pay-co');
    const appt = await bookSlot(h, patient, doctor);
    expect(appt.status).toBe('pending_payment');
    expect(appt.feePaise).toBe(FEE);

    const co = expectOk(await checkout(h, patient, appt.id));
    expect(co.payment).toMatchObject({ status: 'pending', amountPaise: FEE, currency: 'INR' });
    expect(co.checkout).toMatchObject({ provider: 'fake', amountPaise: FEE, simulated: true });
    expect(co.checkout.orderId).toMatch(/^order_fake_/);
    // No provider secrets or internal identifiers in what the browser receives.
    expect(JSON.stringify(co)).not.toMatch(/secret|webhook|payer|patientId/i);

    const again = expectOk(await checkout(h, patient, appt.id));
    expect(again.checkout.orderId).toBe(co.checkout.orderId);
    expect(again.payment.id).toBe(co.payment.id);
    expect(h.paymentProvider.calls.createOrder).toBeGreaterThanOrEqual(1);

    const audit = await auditFor(h.knex, { action: 'payment.create', resource_id: co.payment.id });
    expect(audit).toHaveLength(1);
    expect(audit[0].category).toBe('financial');
  });

  it('the client cannot supply the amount or status; free bookings need no payment', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'pay-forge');
    const appt = await bookSlot(h, patient, doctor);
    const forged = await api(h, patient).post(`/appointments/${appt.id}/payment`, {
      amountPaise: 1,
      status: 'paid',
    });
    expect(forged.status).toBe(400);
    // There is no endpoint to set an appointment or payment status directly.
    expect(
      (await api(h, patient).patch(`/appointments/${appt.id}`, { status: 'confirmed' })).status,
    ).toBe(404);
    expect((await appointmentRow(h, appt.id)).status).toBe('pending_payment');

    const free = await paidSetup(h, admin, 'pay-free', { feePaise: 0 });
    const freeAppt = await bookSlot(h, free.patient, free.doctor);
    expect(freeAppt.status).toBe('confirmed'); // M3 behaviour intact
    expect((await checkout(h, free.patient, freeAppt.id)).body.code).toBe('payment_not_required');
  });

  it('no payment for cancelled or expired appointments', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'pay-cancelled');
    const appt = await bookSlot(h, patient, doctor);
    expectOk(
      await api(h, patient).post(`/appointments/${appt.id}/cancel`, {
        reasonCode: 'patient_request',
      }),
    );
    expect((await checkout(h, patient, appt.id)).body.code).toBe('appointment_not_payable');

    const appt2 = await bookSlot(h, patient, doctor, { index: 2 });
    await expireHoldNow(h, appt2.id);
    expect((await checkout(h, patient, appt2.id)).body.code).toBe('payment_hold_expired');
  });

  it('provider timeout or outage leaves the appointment pending and unpaid; a retry succeeds', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'pay-timeout');
    const appt = await bookSlot(h, patient, doctor);
    for (const kind of ['timeout', 'unavailable', 'invalid_response']) {
      h.paymentProvider.failNext('createOrder', kind);
      const res = await checkout(h, patient, appt.id);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('payment_provider_unavailable');
      expect((await appointmentRow(h, appt.id)).status).toBe('pending_payment');
      const payment = await paymentRow(h, appt.id);
      expect(payment.status).toBe('pending');
      expect(payment.provider_order_id).toBeNull();
    }
    const ok = expectOk(await checkout(h, patient, appt.id));
    expect(ok.checkout.orderId).toMatch(/^order_fake_/);
    expect(await auditFor(h.knex, { action: 'payment.order_failed' })).not.toHaveLength(0);
  });
});

describe('verified webhooks are the only authority', () => {
  it('a captured payment confirms the appointment, writes the ledger, audit and outbox', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'wh-capture');
    const before = await counterValue(domainMetrics.paymentsSucceeded);
    const { appointment, co } = await pendingPaid(h, patient, doctor);
    const res = await postWebhook(h, capturedEvent(h, co, appointment.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ received: true, duplicate: false, status: 'processed' });

    const row = await appointmentRow(h, appointment.id);
    expect(row.status).toBe('confirmed');
    expect(row.confirmed_at).not.toBeNull();
    const payment = await paymentRow(h, appointment.id);
    expect(payment).toMatchObject({ status: 'paid', amount_paise: FEE });
    const ledger = await ledgerOf(h, payment.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      entry_type: 'payment_captured',
      direction: 'credit',
      amount_paise: FEE,
    });

    const events = (await outboxOf(h, appointment.id)).map((e) => e.event_type);
    expect(events).toEqual(expect.arrayContaining(['appointment.booked', 'appointment.confirmed']));
    expect((await outboxOf(h, payment.id)).map((e) => e.event_type)).toContain('payment.captured');
    for (const e of await outboxOf(h, payment.id)) {
      expect(JSON.stringify(e.payload)).not.toMatch(/reason|follow-up|email|phone/i);
    }
    expect(
      await auditFor(h.knex, {
        action: 'appointment.confirm_payment',
        resource_id: appointment.id,
      }),
    ).toHaveLength(1);
    expect(
      await auditFor(h.knex, { action: 'payment.captured', resource_id: payment.id }),
    ).toHaveLength(1);
    expect(await counterValue(domainMetrics.paymentsSucceeded)).toBe(before + 1);

    // The patient sees the receipt; the doctor sees status only.
    const receipt = expectOk(await api(h, patient).get(`/appointments/${appointment.id}/payment`));
    expect(receipt).toMatchObject({ status: 'paid', amountPaise: FEE, refundedPaise: 0 });
    const doctorView = expectOk(await api(h, doctor).get(`/appointments/${appointment.id}`));
    expect(doctorView.paymentStatus).toBe('paid');
    expect((await api(h, doctor).get(`/appointments/${appointment.id}/payment`)).status).toBe(403);
  });

  it('rejects unsigned, mis-signed and malformed webhooks without any state change', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'wh-forged');
    const { appointment, co } = await pendingPaid(h, patient, doctor);
    const genuine = capturedEvent(h, co, appointment.id);
    const before = await counterValue(domainMetrics.webhooksInvalid);

    const noSig = { ...genuine.headers };
    delete noSig['x-fake-signature'];
    expect((await postWebhook(h, { rawBody: genuine.rawBody, headers: noSig })).status).toBe(400);
    const badSig = { ...genuine.headers, 'x-fake-signature': 'a'.repeat(64) };
    expect((await postWebhook(h, { rawBody: genuine.rawBody, headers: badSig })).status).toBe(400);
    // Tampered body with the original signature (e.g. a forged "captured" for more money).
    const tampered = Buffer.from(
      genuine.rawBody.toString().replace(`"amount":${FEE}`, '"amount":1'),
    );
    expect((await postWebhook(h, { rawBody: tampered, headers: genuine.headers })).status).toBe(
      400,
    );
    // Wrong provider path.
    expect((await postWebhook(h, genuine, 'razorpay')).status).toBe(404);
    // A "browser" calling the webhook with plain JSON and a user token.
    const browser = await request(h.app)
      .post('/api/v1/webhooks/payments/fake')
      .set(authHeader(patient.session))
      .send({ event: 'payment.captured', appointmentId: appointment.id });
    expect(browser.status).toBe(400);

    expect((await appointmentRow(h, appointment.id)).status).toBe('pending_payment');
    expect((await paymentRow(h, appointment.id)).status).toBe('pending');
    expect(await counterValue(domainMetrics.webhooksInvalid)).toBe(before + 4);
    const audit = await auditFor(h.knex, { action: 'payment.webhook_invalid' });
    expect(audit.map((a) => a.reason)).toEqual(
      expect.arrayContaining(['missing_signature', 'bad_signature']),
    );
    expect(JSON.stringify(audit)).not.toMatch(/test-webhook-secret/);
  });

  it('duplicate and replayed webhooks have exactly one financial effect', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'wh-dup');
    const { appointment, co } = await pendingPaid(h, patient, doctor);
    const event = capturedEvent(h, co, appointment.id);
    const dupBefore = await counterValue(domainMetrics.webhooksDuplicate);

    const results = await Promise.all([1, 2, 3].map(() => postWebhook(h, event)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.data.duplicate === false)).toHaveLength(1);
    // Same signed body under a new (unsigned) event-id header: still a duplicate.
    const replay = await postWebhook(h, {
      rawBody: event.rawBody,
      headers: { ...event.headers, 'x-fake-event-id': `evt_replay_${randomUUID()}` },
    });
    expect(replay.body.data.duplicate).toBe(true);
    // A different, genuine event for the same payment (order.paid) is a stale no-op.
    const orderPaid = h.paymentProvider.webhook('order.paid', {
      orderId: co.checkout.orderId,
      amountPaise: FEE,
      notes: { hb_payment_id: co.payment.id, hb_appointment_id: appointment.id },
    });
    expect((await postWebhook(h, orderPaid)).body.data.status).toBe('ignored');
    // An old "failed" event arriving after the capture cannot move the payment backwards.
    const lateFail = h.paymentProvider.webhook('payment.failed', {
      orderId: co.checkout.orderId,
      paymentId: 'pay_old_attempt',
      amountPaise: FEE,
      errorCode: 'BAD_REQUEST_ERROR',
    });
    expect((await postWebhook(h, lateFail)).body.data.status).toBe('ignored');

    const payment = await paymentRow(h, appointment.id);
    expect(payment.status).toBe('paid');
    expect(await ledgerOf(h, payment.id)).toHaveLength(1);
    expect(
      (await outboxOf(h, payment.id)).filter((e) => e.event_type === 'payment.captured'),
    ).toHaveLength(1);
    expect(await counterValue(domainMetrics.webhooksDuplicate)).toBe(dupBefore + 3);
    expect(await auditFor(h.knex, { action: 'payment.webhook_duplicate' })).not.toHaveLength(0);
  });

  it('unknown payments, amount mismatches and wrong-appointment references are rejected', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'wh-mismatch');
    const { appointment, co } = await pendingPaid(h, patient, doctor);
    const other = await pendingPaid(h, patient, doctor, { index: 3 });

    const unknown = h.paymentProvider.webhook('payment.captured', {
      orderId: 'order_fake_unknown0000',
      amountPaise: FEE,
    });
    expect((await postWebhook(h, unknown)).body.data.status).toBe('ignored');

    const lessMoney = capturedEvent(h, co, appointment.id, { amountPaise: FEE - 100 });
    expect((await postWebhook(h, lessMoney)).body.data.status).toBe('rejected');

    // A genuine order of appointment A carrying appointment B's reference.
    const wrongAppointment = capturedEvent(h, co, appointment.id, {
      notes: { hb_payment_id: co.payment.id, hb_appointment_id: other.appointment.id },
    });
    expect((await postWebhook(h, wrongAppointment)).body.data.status).toBe('rejected');

    // A provider payment id already attached to another payment is rejected, not a 500.
    expectOk(
      await postWebhook(
        h,
        capturedEvent(h, other.co, other.appointment.id, { paymentId: 'pay_dup_1' }),
      ),
    );
    const reused = await postWebhook(
      h,
      capturedEvent(h, co, appointment.id, { paymentId: 'pay_dup_1' }),
    );
    expect(reused.status).toBe(200);
    expect(reused.body.data.status).toBe('rejected');

    expect((await appointmentRow(h, appointment.id)).status).toBe('pending_payment');
    expect((await appointmentRow(h, other.appointment.id)).status).toBe('confirmed');
    const reasons = (await auditFor(h.knex, { action: 'payment.webhook_rejected' })).map(
      (a) => a.reason,
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        'unknown_payment',
        'amount_mismatch',
        'reference_mismatch',
        'provider_payment_conflict',
      ]),
    );
  });

  it('a failed attempt keeps the hold; the patient retries and the capture confirms', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'wh-fail');
    const { appointment, co } = await pendingPaid(h, patient, doctor);
    const failed = h.paymentProvider.webhook('payment.failed', {
      orderId: co.checkout.orderId,
      paymentId: 'pay_fake_attempt1',
      amountPaise: FEE,
      errorCode: 'BAD_REQUEST_ERROR',
      notes: { hb_payment_id: co.payment.id, hb_appointment_id: appointment.id },
    });
    expect((await postWebhook(h, failed)).body.data.status).toBe('processed');
    expect((await paymentRow(h, appointment.id)).status).toBe('failed');
    expect((await appointmentRow(h, appointment.id)).status).toBe('pending_payment');
    expect((await outboxOf(h, co.payment.id)).map((e) => e.event_type)).toContain('payment.failed');

    // Retry: same order; the patient sees the failure state.
    const retry = expectOk(await checkout(h, patient, appointment.id));
    expect(retry.payment.status).toBe('failed');
    expect(retry.checkout.orderId).toBe(co.checkout.orderId);
    expectOk(await postWebhook(h, capturedEvent(h, co, appointment.id)));
    expect((await appointmentRow(h, appointment.id)).status).toBe('confirmed');
  });

  it('a payment captured at the provider but not yet webhooked does not confirm anything', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'wh-delay');
    const { appointment, co } = await pendingPaid(h, patient, doctor);
    const event = capturedEvent(h, co, appointment.id); // provider side: captured, webhook delayed
    expect((await h.paymentProvider.getPaymentStatus(co.checkout.orderId)).status).toBe('paid');
    expect((await appointmentRow(h, appointment.id)).status).toBe('pending_payment');
    expect((await paymentRow(h, appointment.id)).status).toBe('pending');
    expectOk(await postWebhook(h, event)); // the webhook finally arrives
    expect((await appointmentRow(h, appointment.id)).status).toBe('confirmed');
  });

  it('simulated checkout (fake provider) goes through signature verification like a real webhook', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'wh-sim');
    const { appointment } = await pendingPaid(h, patient, doctor);
    const intruder = await createPatient(h, 'wh-sim-intruder');
    expect(
      (
        await api(h, intruder).post(`/appointments/${appointment.id}/payment/simulate`, {
          outcome: 'success',
        })
      ).status,
    ).toBe(404);
    const res = expectOk(
      await api(h, patient).post(`/appointments/${appointment.id}/payment/simulate`, {
        outcome: 'success',
      }),
    );
    expect(res.status).toBe('processed');
    expect((await appointmentRow(h, appointment.id)).status).toBe('confirmed');
  });
});

describe('payment hold expiry racing a successful payment', () => {
  it('A: webhook wins — the sweeper leaves the confirmed appointment alone', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'race-a');
    const { appointment, co } = await pendingPaid(h, patient, doctor);
    expectOk(await postWebhook(h, capturedEvent(h, co, appointment.id)));
    await expireHoldNow(h, appointment.id);
    await h.container.settlement.expireHolds();
    expect((await appointmentRow(h, appointment.id)).status).toBe('confirmed');
    expect((await paymentRow(h, appointment.id)).status).toBe('paid');
    expect(await refundsOf(h, co.payment.id)).toHaveLength(0);
  });

  it('B: expiry wins — the late capture is recorded and fully refunded', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'race-b');
    const { appointment, co } = await pendingPaid(h, patient, doctor);
    await expireHoldNow(h, appointment.id);
    const holdsBefore = await counterValue(domainMetrics.holdsExpired);
    await h.container.settlement.expireHolds();
    expect(await counterValue(domainMetrics.holdsExpired)).toBeGreaterThan(holdsBefore);
    expect((await appointmentRow(h, appointment.id)).status).toBe('expired');
    expect((await paymentRow(h, appointment.id)).status).toBe('cancelled');
    expect((await outboxOf(h, appointment.id)).map((e) => e.event_type)).toContain(
      'appointment.expired',
    );

    expectOk(await postWebhook(h, capturedEvent(h, co, appointment.id)));
    expect((await appointmentRow(h, appointment.id)).status).toBe('expired');
    const payment = await paymentRow(h, appointment.id);
    expect(payment.status).toBe('paid');
    const refunds = await refundsOf(h, payment.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      reason: 'late_capture',
      amount_paise: FEE,
      status: 'pending',
    });
    expect(
      await auditFor(h.knex, { action: 'payment.late_capture', resource_id: payment.id }),
    ).toHaveLength(1);
  });

  it('C: simultaneous webhook and sweeper always end in one valid state', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'race-c');
    const outcomes = [];
    for (let i = 0; i < 6; i += 1) {
      const { appointment, co } = await pendingPaid(h, patient, doctor, { index: i * 2 });
      await expireHoldNow(h, appointment.id);
      await Promise.all([
        postWebhook(h, capturedEvent(h, co, appointment.id)),
        h.container.settlement.expireHolds(),
      ]);
      const row = await appointmentRow(h, appointment.id);
      const payment = await paymentRow(h, appointment.id);
      const refunds = await refundsOf(h, payment.id);
      expect(payment.status).toBe('paid'); // money moved exactly once
      expect(await ledgerOf(h, payment.id)).toHaveLength(1);
      if (row.status === 'confirmed') {
        expect(refunds).toHaveLength(0);
      } else {
        expect(row.status).toBe('expired');
        expect(refunds.map((r) => r.reason)).toEqual(['late_capture']);
      }
      outcomes.push(row.status);
    }
    expect(outcomes.every((s) => ['confirmed', 'expired'].includes(s))).toBe(true);
  });
});

describe('refunds', () => {
  it('a doctor cancellation refunds in full: provider submit → refund webhook → ledger debit', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'refund-cancel');
    const { appointment, co } = await paidAppointment(h, patient, doctor);
    expectOk(
      await api(h, doctor).post(`/appointments/${appointment.id}/cancel`, {
        reasonCode: 'doctor_unavailable',
      }),
    );

    const settlement = h.container.settlement;
    expect((await settlement.closeForAppointment(appointment.id)).outcome).toBe('refund_requested');
    expect((await settlement.closeForAppointment(appointment.id)).outcome).toBe(
      'refund_already_requested',
    );
    const [refund] = await refundsOf(h, co.payment.id);
    expect(refund).toMatchObject({
      amount_paise: FEE,
      reason: 'appointment_cancelled',
      status: 'pending',
    });

    expect((await settlement.executeRefund(refund.id)).outcome).toBe('submitted');
    expect((await settlement.executeRefund(refund.id)).outcome).toBe('not_pending'); // redelivery
    expect(h.paymentProvider.calls.refund).toBeGreaterThanOrEqual(1);
    const settled = await h.container.fakeRefundSettler(refund.id);
    expect(settled.status).toBe('processed');

    const payment = await paymentRow(h, appointment.id);
    expect(payment).toMatchObject({ status: 'refunded', refunded_paise: FEE });
    const ledger = await ledgerOf(h, payment.id);
    expect(ledger.map((l) => [l.entry_type, l.direction, l.amount_paise])).toEqual([
      ['payment_captured', 'credit', FEE],
      ['refund_processed', 'debit', FEE],
    ]);
    expect((await outboxOf(h, payment.id)).map((e) => e.event_type)).toContain('payment.refunded');
    const receipt = expectOk(await api(h, patient).get(`/appointments/${appointment.id}/payment`));
    expect(receipt.refunds).toHaveLength(1);
    expect(receipt.refunds[0]).toMatchObject({ status: 'processed', amountPaise: FEE });
  });

  it('a patient cancelling more than 24 hours ahead is refunded; open payments are cancelled', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'refund-patient');
    const { appointment, co } = await paidAppointment(h, patient, doctor, { days: 3 });
    expectOk(
      await api(h, patient).post(`/appointments/${appointment.id}/cancel`, {
        reasonCode: 'patient_request',
      }),
    );
    expect((await h.container.settlement.closeForAppointment(appointment.id)).outcome).toBe(
      'refund_requested',
    );
    expect((await refundsOf(h, co.payment.id))[0].amount_paise).toBe(FEE);

    const unpaid = await pendingPaid(h, patient, doctor, { index: 5 });
    expectOk(
      await api(h, patient).post(`/appointments/${unpaid.appointment.id}/cancel`, {
        reasonCode: 'patient_request',
      }),
    );
    expect((await h.container.settlement.closeForAppointment(unpaid.appointment.id)).outcome).toBe(
      'payment_cancelled',
    );
    expect((await paymentRow(h, unpaid.appointment.id)).status).toBe('cancelled');
  });

  it('manual refunds: doctor and clinic only, idempotent, never above the amount paid', async () => {
    const platform = await createPlatformAdmin(h, 'refund-padmin');
    const { clinic, clinicAdmin } = await createClinicWithAdmin(h, platform, 'refund-clinic');
    const other = await createClinicWithAdmin(h, platform, 'refund-other-clinic');
    const { doctor, patient } = await paidSetup(h, admin, 'refund-manual');
    // The doctor joins the clinic; an in-clinic paid schedule there.
    const invite = expectOk(
      await api(h, clinicAdmin).post(`/clinics/${clinic.id}/doctors`, {
        doctorId: doctor.doctor.id,
      }),
      201,
    );
    expectOk(await api(h, doctor).post(`/clinic-memberships/${invite.id}/accept`));
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      expectOk(
        await api(h, doctor).post('/doctors/me/availability', {
          mode: 'in_clinic',
          clinicId: clinic.id,
          weekday,
          startTime: '22:00',
          endTime: '23:00',
          slotMinutes: 15,
          validFrom: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
          feePaise: FEE,
        }),
        201,
      );
    }
    const { appointment } = await paidAppointment(h, patient, doctor, { mode: 'in_clinic' });
    const path = `/api/v1/appointments/${appointment.id}/refunds`;
    const post = (who, key, body) =>
      request(h.app)
        .post(path)
        .set(key ? withKey(who, key) : authHeader(who.session))
        .send(body);

    expect((await post(doctor, null, { reasonCode: 'goodwill', amountPaise: 100 })).body.code).toBe(
      'idempotency_key_required',
    );
    expect(
      (await post(patient, 'patient-key-0001', { reasonCode: 'goodwill', amountPaise: 100 }))
        .status,
    ).toBe(403);
    expect(
      (
        await post(other.clinicAdmin, 'other-clinic-0001', {
          reasonCode: 'goodwill',
          amountPaise: 100,
        })
      ).status,
    ).toBe(403);
    expect(
      (await post(admin, 'platform-key-0001', { reasonCode: 'goodwill', amountPaise: 100 })).status,
    ).toBe(403);

    const first = await post(doctor, 'doctor-key-00001', {
      reasonCode: 'goodwill',
      amountPaise: 20_000,
    });
    expect(first.status).toBe(202);
    const replay = await post(doctor, 'doctor-key-00001', {
      reasonCode: 'goodwill',
      amountPaise: 20_000,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const byClinic = await post(clinicAdmin, 'clinic-key-00001', {
      reasonCode: 'duplicate_payment',
      amountPaise: 20_000,
    });
    expect(byClinic.status).toBe(202);
    const tooMuch = await post(doctor, 'doctor-key-00002', {
      reasonCode: 'goodwill',
      amountPaise: 20_000,
    });
    expect(tooMuch.body.code).toBe('refund_exceeds_payment');

    const payment = await paymentRow(h, appointment.id);
    expect((await refundsOf(h, payment.id)).map((r) => r.amount_paise)).toEqual([20_000, 20_000]);
    const audits = await auditFor(h.knex, {
      action: 'payment.refund_requested',
      resource_id: payment.id,
    });
    expect(audits.map((a) => a.actor_type)).toEqual(['user', 'user']);
  });
});

describe('authorization and RLS for financial data', () => {
  it('cross-patient payment access is indistinguishable from a missing appointment', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'pay-idor');
    const { appointment } = await pendingPaid(h, patient, doctor);
    const intruder = await createPatient(h, 'pay-idor-x');
    for (const res of [
      await checkout(h, intruder, appointment.id),
      await api(h, intruder).get(`/appointments/${appointment.id}/payment`),
      await checkout(h, intruder, randomUUID()),
    ]) {
      expect(res.status).toBe(404);
    }
    // Platform administrators have no financial access.
    expect((await api(h, admin).get(`/appointments/${appointment.id}/payment`)).status).toBe(403);
  });

  it('RLS: users see only their own payments; the ledger and webhook log are system-only', async () => {
    const { doctor, patient } = await paidSetup(h, admin, 'pay-rls');
    const { co } = await paidAppointment(h, patient, doctor);
    const intruder = await createPatient(h, 'pay-rls-x');
    const asUser = (userId, fn) =>
      h.knex.transaction(async (trx) => {
        await trx.raw("SELECT set_config('app.user_id', ?, true)", [userId]);
        return fn(trx);
      });
    expect(
      await asUser(intruder.id, (trx) => trx('payments').where({ id: co.payment.id })),
    ).toHaveLength(0);
    expect(
      await asUser(patient.id, (trx) => trx('payments').where({ id: co.payment.id })),
    ).toHaveLength(1);
    expect(
      await asUser(patient.id, (trx) => trx('ledger_entries').where({ payment_id: co.payment.id })),
    ).toHaveLength(0);
    expect(
      await asUser(doctor.id, (trx) => trx('payments').where({ id: co.payment.id })),
    ).toHaveLength(0);
    // A user transaction cannot borrow system privileges.
    const borrowed = await asUser(patient.id, async (trx) => {
      await trx.raw("SELECT set_config('app.system_purpose', 'payments', true)");
      return trx('ledger_entries').where({ payment_id: co.payment.id });
    });
    expect(borrowed).toHaveLength(0);
    // No context at all: nothing visible, nothing writable.
    expect(await h.knex('payments').where({ id: co.payment.id })).toHaveLength(0);
    await expect(
      h.knex('payments').where({ id: co.payment.id }).update({ status: 'refunded' }),
    ).resolves.toBe(0);
    // A patient cannot update their own payment (only verified webhooks can).
    expect(
      await asUser(patient.id, (trx) =>
        trx('payments').where({ id: co.payment.id }).update({ status: 'paid' }),
      ),
    ).toBe(0);
    // The application role cannot delete payments or touch the ledger.
    await expect(h.knex.raw('DELETE FROM payments WHERE id = ?', [co.payment.id])).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      h.knex.raw('UPDATE ledger_entries SET amount_paise = 1 WHERE payment_id = ?', [
        co.payment.id,
      ]),
    ).rejects.toThrow(/permission denied/);
    // Even the owner cannot rewrite history: corrections are compensating entries.
    await expect(
      h
        .ownerKnex('ledger_entries')
        .where({ payment_id: co.payment.id })
        .update({ amount_paise: 1 }),
    ).rejects.toThrow(/append-only/);
  });
});
