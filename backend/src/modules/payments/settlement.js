import { createHash } from 'node:crypto';
import { OPEN_PAYMENT_STATUSES } from '@healthbridge/shared';
import { newId } from '../../core/db/ids.js';
import { withSystem } from '../../core/db/actorContext.js';
import { appendOutboxEvent } from '../../core/events/outbox.js';
import { ConflictError } from '../../core/http/errors.js';
import { domainMetrics, timed } from '../../core/metrics/domain.js';
import { appointmentTransition } from '../scheduling/domain/appointmentStateMachine.js';
import {
  REFUNDABLE_STATUSES,
  cancellationRefund,
  paymentTransition,
  statusAfterRefund,
} from './domain/paymentStateMachine.js';
import { PaymentProviderError } from './providers/paymentProvider.js';

const FIN = 'financial';
const SYSTEM = 'system';

/**
 * Authoritative payment state changes (ADR-0020). Everything here runs in `payments`
 * system transactions and is idempotent:
 *
 * - `applyProviderEvent`: a verified webhook. The event row (UNIQUE provider event id and
 *   payload digest) is inserted in the same transaction as its effects, so a replay is a
 *   no-op and a failed transaction leaves nothing behind for the provider's retry.
 * - `closeForAppointment`: an appointment expired or was cancelled → cancel the open
 *   payment, or refund a captured one according to the refund policy.
 * - `requestRefund` / `executeRefund`: refund rows are keyed by an idempotency key; the
 *   provider call happens outside any transaction and is itself idempotent.
 * - `expireHolds`: the hold sweeper.
 *
 * Lock order is always appointment → payment → refund, so the webhook and the hold
 * sweeper (or a cancellation) serialise on the appointment row and cannot deadlock.
 */
export function createPaymentSettlement({
  knex,
  payments,
  appointments,
  audit,
  provider,
  logger,
  now = () => new Date(),
}) {
  const auditFin = (trx, req, event) =>
    audit.record({ category: FIN, actor: SYSTEM, ...event }, { req, trx });

  async function emit(trx, aggregateType, aggregateId, eventType, payload, req) {
    await appendOutboxEvent(trx, {
      aggregateType,
      aggregateId,
      eventType,
      payload,
      requestId: req?.id ?? null,
    });
  }

  /** Inserts a refund request (idempotent by key) under the payment row lock. */
  async function insertRefund(trx, payment, { amountPaise, reason, party, userId, key }, req) {
    const existing = await payments.findRefundByKey(trx, key);
    if (existing) return { refund: existing, created: false };
    if (!REFUNDABLE_STATUSES.includes(payment.status)) {
      throw new ConflictError('This payment cannot be refunded.', 'payment_not_refundable');
    }
    const committed = await payments.committedRefundPaise(trx, payment.id);
    if (amountPaise <= 0 || committed + amountPaise > payment.amount_paise) {
      throw new ConflictError(
        'The refund exceeds the amount still refundable.',
        'refund_exceeds_payment',
      );
    }
    const refund = {
      id: newId(),
      payment_id: payment.id,
      appointment_id: payment.appointment_id,
      amount_paise: amountPaise,
      currency: payment.currency,
      reason,
      idempotency_key: key,
      requested_by_party: party,
      requested_by_user_id: userId ?? null,
    };
    const created = await payments.insertRefund(trx, refund);
    if (!created) return { refund: await payments.findRefundByKey(trx, key), created: false };
    await emit(
      trx,
      'payment',
      payment.id,
      'payment.refund_requested',
      {
        paymentId: payment.id,
        refundId: refund.id,
        appointmentId: payment.appointment_id,
      },
      req,
    );
    await audit.record(
      {
        category: FIN,
        action: 'payment.refund_requested',
        outcome: 'success',
        resourceType: 'payment',
        resourceId: payment.id,
        patientId: payment.patient_id,
        actor: userId ? undefined : SYSTEM,
        metadata: { refundId: refund.id, amountPaise, reason, party },
      },
      { req, trx },
    );
    domainMetrics.refundsCreated.inc({ reason });
    return { refund, created: true };
  }

  // ── Verified webhooks ───────────────────────────────────────────

  async function applyPaymentKind(trx, event, payment, req) {
    const appointment = await appointments.findForUpdate(trx, payment.appointment_id);
    const locked = await payments.findById(trx, payment.id, { forUpdate: true });

    if (['captured', 'authorized'].includes(event.kind)) {
      if (event.amountPaise !== locked.amount_paise || event.currency !== locked.currency.trim()) {
        return { status: 'rejected', outcome: 'amount_mismatch' };
      }
    }
    const transition = paymentTransition(locked.status, event.kind);
    if (!transition.next) return { status: 'ignored', outcome: transition.reason };
    // Provider payment ids are globally unique; one already attached to another payment
    // is an anomaly to investigate, not something to retry forever (or to apply).
    if (event.paymentId) {
      const owner = await payments.findByProviderPayment(trx, locked.provider, event.paymentId);
      if (owner && owner.id !== locked.id) {
        return { status: 'rejected', outcome: 'provider_payment_conflict' };
      }
    }
    const at = now();

    if (event.kind === 'authorized') {
      await payments.update(trx, locked.id, {
        status: 'authorized',
        authorized_at: at,
        provider_payment_id: event.paymentId,
      });
      await auditFin(trx, req, {
        action: 'payment.authorized',
        outcome: 'success',
        resourceType: 'payment',
        resourceId: locked.id,
        patientId: locked.patient_id,
      });
      return { status: 'processed', outcome: 'authorized' };
    }

    if (event.kind === 'failed') {
      await payments.update(trx, locked.id, {
        status: 'failed',
        failed_at: at,
        failure_code: event.failureCode,
        provider_payment_id: event.paymentId,
      });
      await auditFin(trx, req, {
        action: 'payment.failed',
        outcome: 'failure',
        resourceType: 'payment',
        resourceId: locked.id,
        patientId: locked.patient_id,
        reason: event.failureCode,
      });
      await emit(
        trx,
        'payment',
        locked.id,
        'payment.failed',
        {
          paymentId: locked.id,
          appointmentId: locked.appointment_id,
          patientId: locked.patient_id,
        },
        req,
      );
      domainMetrics.paymentsFailed.inc();
      return { status: 'processed', outcome: 'failed' };
    }

    // captured: money moved. Record it, then confirm the appointment or refund.
    await payments.update(trx, locked.id, {
      status: 'paid',
      paid_at: at,
      provider_payment_id: event.paymentId,
      failure_code: null,
    });
    await payments.appendLedger(trx, {
      id: newId(),
      entry_type: 'payment_captured',
      direction: 'credit',
      amount_paise: locked.amount_paise,
      currency: locked.currency,
      payment_id: locked.id,
      appointment_id: locked.appointment_id,
      provider: locked.provider,
      provider_reference: event.paymentId,
      payment_event_id: event.rowId,
    });
    await auditFin(trx, req, {
      action: 'payment.captured',
      outcome: 'success',
      resourceType: 'payment',
      resourceId: locked.id,
      patientId: locked.patient_id,
      metadata: { amountPaise: locked.amount_paise, appointmentId: locked.appointment_id },
    });
    domainMetrics.paymentsSucceeded.inc();

    if (appointment.status === 'pending_payment') {
      const next = appointmentTransition(appointment, 'confirm_payment', 'system', at);
      await appointments.update(trx, appointment.id, { status: next, confirmed_at: at });
      await audit.record(
        {
          category: 'data_access',
          action: 'appointment.confirm_payment',
          outcome: 'success',
          actor: SYSTEM,
          resourceType: 'appointment',
          resourceId: appointment.id,
          patientId: appointment.patient_id,
          metadata: { from: appointment.status, to: next, paymentId: locked.id },
        },
        { req, trx },
      );
      await emit(
        trx,
        'appointment',
        appointment.id,
        'appointment.confirmed',
        {
          patientId: appointment.patient_id,
          doctorId: appointment.doctor_id,
          clinicId: appointment.clinic_id,
          status: next,
          startsAt: appointment.starts_at,
        },
        req,
      );
      await emit(
        trx,
        'payment',
        locked.id,
        'payment.captured',
        {
          paymentId: locked.id,
          appointmentId: appointment.id,
          patientId: appointment.patient_id,
          amountPaise: locked.amount_paise,
          currency: locked.currency.trim(),
          confirmedAppointment: true,
        },
        req,
      );
      return { status: 'processed', outcome: 'captured_confirmed' };
    }

    // The appointment expired or was cancelled before the capture: refund in full.
    await auditFin(trx, req, {
      action: 'payment.late_capture',
      outcome: 'success',
      resourceType: 'payment',
      resourceId: locked.id,
      patientId: locked.patient_id,
      reason: `appointment_${appointment.status}`,
    });
    await insertRefund(
      trx,
      { ...locked, status: 'paid' },
      {
        amountPaise: locked.amount_paise,
        reason: 'late_capture',
        party: 'system',
        key: `late-capture-${locked.id}`,
      },
      req,
    );
    return { status: 'processed', outcome: 'captured_refund_due' };
  }

  async function applyRefundKind(trx, event, req) {
    const found =
      (event.refundId && (await payments.findRefundByProviderId(trx, event.refundId))) ||
      (event.refs.refundId && (await payments.findRefund(trx, event.refs.refundId)));
    if (!found) return { status: 'ignored', outcome: 'unknown_refund' };
    await appointments.findForUpdate(trx, found.appointment_id);
    const payment = await payments.findById(trx, found.payment_id, { forUpdate: true });
    const refund = await payments.findRefund(trx, found.id, { forUpdate: true });
    const ids = { paymentId: payment.id, refundId: refund.id };

    if (event.kind === 'refund_created') {
      if (refund.status !== 'pending')
        return { status: 'ignored', outcome: 'stale_refund', ...ids };
      await payments.updateRefund(trx, refund.id, {
        status: 'processing',
        provider_refund_id: event.refundId,
      });
      return { status: 'processed', outcome: 'refund_processing', ...ids };
    }
    if (event.kind === 'refund_failed') {
      if (!['pending', 'processing'].includes(refund.status)) {
        return { status: 'ignored', outcome: 'stale_refund', ...ids };
      }
      await payments.updateRefund(trx, refund.id, {
        status: 'failed',
        failure_code: 'provider_failed',
        provider_refund_id: event.refundId,
      });
      await auditFin(trx, req, {
        action: 'payment.refund_failed',
        outcome: 'failure',
        resourceType: 'payment',
        resourceId: payment.id,
        patientId: payment.patient_id,
        metadata: { refundId: refund.id },
      });
      return { status: 'processed', outcome: 'refund_failed', ...ids };
    }

    // refund_processed
    if (refund.status === 'processed')
      return { status: 'ignored', outcome: 'stale_refund', ...ids };
    if (event.amountPaise !== refund.amount_paise) {
      return { status: 'rejected', outcome: 'amount_mismatch', ...ids };
    }
    const refunded = payment.refunded_paise + refund.amount_paise;
    await payments.updateRefund(trx, refund.id, {
      status: 'processed',
      processed_at: now(),
      provider_refund_id: event.refundId,
    });
    await payments.update(trx, payment.id, {
      refunded_paise: refunded,
      status: statusAfterRefund(payment.amount_paise, refunded),
    });
    await payments.appendLedger(trx, {
      id: newId(),
      entry_type: 'refund_processed',
      direction: 'debit',
      amount_paise: refund.amount_paise,
      currency: refund.currency,
      payment_id: payment.id,
      refund_id: refund.id,
      appointment_id: refund.appointment_id,
      provider: payment.provider,
      provider_reference: event.refundId,
      payment_event_id: event.rowId,
    });
    await auditFin(trx, req, {
      action: 'payment.refund_processed',
      outcome: 'success',
      resourceType: 'payment',
      resourceId: payment.id,
      patientId: payment.patient_id,
      metadata: { refundId: refund.id, amountPaise: refund.amount_paise },
    });
    await emit(
      trx,
      'payment',
      payment.id,
      'payment.refunded',
      {
        paymentId: payment.id,
        refundId: refund.id,
        appointmentId: refund.appointment_id,
        patientId: payment.patient_id,
        amountPaise: refund.amount_paise,
        currency: refund.currency.trim(),
      },
      req,
    );
    domainMetrics.refundsCompleted.inc();
    return { status: 'processed', outcome: 'refund_processed', ...ids };
  }

  /**
   * @param {import('./providers/paymentProvider.js').ProviderEvent} event verified event
   * @param {{ payloadSha256: string, req?: import('express').Request }} context
   * @returns {Promise<{ duplicate: boolean, status?: string, outcome?: string }>}
   */
  async function applyProviderEvent(event, { payloadSha256, req }) {
    return withSystem(knex, 'payments', async (trx) => {
      const rowId = newId();
      const inserted = await payments.insertEvent(trx, {
        id: rowId,
        provider: provider.name,
        provider_event_id: event.eventId,
        event_type: event.type,
        provider_order_id: event.orderId,
        provider_payment_id: event.paymentId,
        provider_refund_id: event.refundId,
        amount_paise: event.amountPaise,
        payload_sha256: payloadSha256,
        request_id: req?.id ?? null,
      });
      if (!inserted) return { duplicate: true };
      const withRow = { ...event, rowId };

      let result;
      if (event.kind === 'ignored') {
        result = { status: 'ignored', outcome: 'unhandled_event_type' };
      } else if (event.kind.startsWith('refund_')) {
        result = await applyRefundKind(trx, withRow, req);
      } else {
        const payment = event.orderId
          ? await payments.findByProviderOrder(trx, provider.name, event.orderId)
          : null;
        if (!payment) {
          result = { status: 'ignored', outcome: 'unknown_payment' };
        } else if (
          (event.refs.paymentId && event.refs.paymentId !== payment.id) ||
          (event.refs.appointmentId && event.refs.appointmentId !== payment.appointment_id)
        ) {
          result = { status: 'rejected', outcome: 'reference_mismatch', paymentId: payment.id };
        } else {
          result = {
            ...(await applyPaymentKind(trx, withRow, payment, req)),
            paymentId: payment.id,
          };
        }
      }

      await payments.completeEvent(trx, rowId, result);
      if (result.status === 'rejected' || result.outcome?.startsWith('unknown_')) {
        // Rejected events are recorded (replay-safe) and answered 200: re-sending them
        // cannot succeed, so the provider must not retry them indefinitely.
        await audit.record(
          {
            category: FIN,
            action: 'payment.webhook_rejected',
            outcome: 'denied',
            actor: SYSTEM,
            resourceType: 'payment_event',
            resourceId: rowId,
            reason: result.outcome,
            metadata: { eventType: event.type, provider: provider.name },
          },
          { req, trx },
        );
      }
      return { duplicate: false, status: result.status, outcome: result.outcome };
    });
  }

  // ── Appointment-driven payment changes (outbox consumers) ───────

  /** Appointment expired or cancelled: close the open payment or refund per policy. */
  async function closeForAppointment(appointmentId, { req } = {}) {
    return withSystem(knex, 'payments', async (trx) => {
      const appointment = await appointments.findForUpdate(trx, appointmentId);
      if (!appointment || !['expired', 'cancelled'].includes(appointment.status)) {
        return { outcome: 'not_applicable' };
      }
      const payment = await payments.findByAppointment(trx, appointmentId, { forUpdate: true });
      if (!payment) return { outcome: 'no_payment' };

      if (OPEN_PAYMENT_STATUSES.includes(payment.status)) {
        const { next } = paymentTransition(payment.status, 'cancel');
        await payments.update(trx, payment.id, { status: next, cancelled_at: now() });
        await auditFin(trx, req, {
          action: 'payment.cancelled',
          outcome: 'success',
          resourceType: 'payment',
          resourceId: payment.id,
          patientId: payment.patient_id,
          reason: `appointment_${appointment.status}`,
        });
        return { outcome: 'payment_cancelled' };
      }
      if (appointment.status === 'cancelled' && REFUNDABLE_STATUSES.includes(payment.status)) {
        const key = `cancel-${appointmentId}`;
        if (await payments.findRefundByKey(trx, key))
          return { outcome: 'refund_already_requested' };
        const committed = await payments.committedRefundPaise(trx, payment.id);
        const policy = cancellationRefund({
          refundablePaise: payment.amount_paise - committed,
          cancelledByParty: appointment.cancelled_by_party,
          cancelReason: appointment.cancel_reason,
          startsAt: appointment.starts_at,
          cancelledAt: appointment.cancelled_at,
        });
        if (policy.amountPaise <= 0) return { outcome: 'no_refund_due' };
        const { created } = await insertRefund(
          trx,
          payment,
          {
            amountPaise: policy.amountPaise,
            reason: policy.reason,
            party: 'system',
            key,
          },
          req,
        );
        return { outcome: created ? 'refund_requested' : 'refund_already_requested' };
      }
      return { outcome: 'nothing_to_do' };
    });
  }

  /**
   * A doctor or clinic issues a refund (authorised by the caller). Runs as a payments
   * system transaction; the acting user is recorded on the refund and in the audit row.
   */
  async function requestRefund(
    { appointmentId, amountPaise, reason, party, userId, idempotencyKey },
    req,
  ) {
    return withSystem(knex, 'payments', async (trx) => {
      await appointments.findForUpdate(trx, appointmentId);
      const payment = await payments.findByAppointment(trx, appointmentId, { forUpdate: true });
      if (!payment) {
        throw new ConflictError('This appointment has no payment.', 'payment_not_refundable');
      }
      // Scoped to the appointment and bounded in length whatever the client sent.
      const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
      const key = `manual-${appointmentId}-${digest}`;
      const prior = await payments.findRefundByKey(trx, key);
      if (prior) return { refund: prior, created: false };
      const committed = await payments.committedRefundPaise(trx, payment.id);
      return insertRefund(
        trx,
        payment,
        {
          amountPaise: amountPaise ?? payment.amount_paise - committed,
          reason,
          party,
          userId,
          key,
        },
        req,
      );
    });
  }

  /**
   * Payments worker: sends a requested refund to the provider. Safe to repeat: the
   * provider call is idempotent by our refund id, and only a `pending` refund is sent.
   * @returns {Promise<{ outcome: string }>}
   */
  async function executeRefund(refundId) {
    const prepared = await withSystem(knex, 'payments', async (trx) => {
      const refund = await payments.findRefund(trx, refundId, { forUpdate: true });
      if (!refund || refund.status !== 'pending') return null;
      const payment = await payments.findById(trx, refund.payment_id);
      await payments.updateRefund(trx, refund.id, { attempts: refund.attempts + 1 });
      return { refund, payment };
    });
    if (!prepared) return { outcome: 'not_pending' };
    const { refund, payment } = prepared;

    let result;
    try {
      result = await timed(domainMetrics.providerLatency, { operation: 'refund' }, () =>
        provider.refund({
          providerPaymentId: payment.provider_payment_id,
          amountPaise: refund.amount_paise,
          idempotencyKey: refund.idempotency_key,
          refundId: refund.id,
        }),
      );
    } catch (err) {
      if (err instanceof PaymentProviderError && !err.retryable) {
        await withSystem(knex, 'payments', async (trx) => {
          await payments.updateRefund(trx, refund.id, {
            status: 'failed',
            failure_code: 'provider_rejected',
          });
          await audit.record(
            {
              category: FIN,
              action: 'payment.refund_failed',
              outcome: 'failure',
              actor: SYSTEM,
              resourceType: 'payment',
              resourceId: payment.id,
              patientId: payment.patient_id,
              reason: 'provider_rejected',
              metadata: { refundId: refund.id },
            },
            { trx },
          );
        });
        return { outcome: 'rejected' };
      }
      throw err; // retryable: the job retries with backoff
    }

    await withSystem(knex, 'payments', async (trx) => {
      const current = await payments.findRefund(trx, refund.id, { forUpdate: true });
      if (current.status === 'pending') {
        await payments.updateRefund(trx, refund.id, {
          status: 'processing',
          provider_refund_id: result.refundId,
        });
      }
    });
    logger?.info({ refundId: refund.id }, 'refund submitted to provider');
    return { outcome: 'submitted' };
  }

  // ── Hold sweeper ────────────────────────────────────────────────

  /**
   * Expires elapsed payment holds. Rows are claimed with FOR UPDATE SKIP LOCKED, so many
   * workers can run this concurrently, and a webhook holding an appointment's lock is
   * simply skipped (and decides that appointment's fate first).
   */
  async function expireHolds({ limit = 100 } = {}) {
    return withSystem(knex, 'payments', async (trx) => {
      const rows = await appointments.claimExpiredHolds(trx, limit);
      const at = now();
      for (const row of rows) {
        const next = appointmentTransition(row, 'expire', 'system', at);
        await appointments.update(trx, row.id, { status: next });
        const payment = await payments.findByAppointment(trx, row.id, { forUpdate: true });
        if (payment && OPEN_PAYMENT_STATUSES.includes(payment.status)) {
          await payments.update(trx, payment.id, { status: 'cancelled', cancelled_at: at });
        }
        await audit.record(
          {
            category: 'data_access',
            action: 'appointment.expire',
            outcome: 'success',
            actor: SYSTEM,
            resourceType: 'appointment',
            resourceId: row.id,
            patientId: row.patient_id,
            metadata: { from: row.status, to: next, paymentId: payment?.id ?? null },
          },
          { trx },
        );
        await appendOutboxEvent(trx, {
          aggregateType: 'appointment',
          aggregateId: row.id,
          eventType: 'appointment.expired',
          payload: {
            patientId: row.patient_id,
            doctorId: row.doctor_id,
            clinicId: row.clinic_id,
            status: next,
            startsAt: row.starts_at,
          },
        });
        domainMetrics.holdsExpired.inc();
      }
      return { expired: rows.length };
    });
  }

  return {
    applyProviderEvent,
    closeForAppointment,
    requestRefund,
    executeRefund,
    expireHolds,
  };
}
