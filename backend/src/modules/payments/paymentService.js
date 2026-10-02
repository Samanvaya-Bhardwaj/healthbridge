import { OPEN_PAYMENT_STATUSES, PERMISSIONS } from '@healthbridge/shared';
import { isUuid, newId } from '../../core/db/ids.js';
import { withActor, withSystem } from '../../core/db/actorContext.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../core/http/errors.js';
import { domainMetrics, timed } from '../../core/metrics/domain.js';
import { PaymentProviderError } from './providers/paymentProvider.js';
import { toPaymentView } from './repository.js';

class PaymentProviderUnavailableError extends AppError {
  constructor() {
    super({
      status: 503,
      code: 'payment_provider_unavailable',
      title: 'Payment provider unavailable',
      detail: 'We could not reach the payment provider. Your booking is held; please try again.',
    });
  }
}

const PARTY = { patient_party: 'patient', doctor_party: 'doctor', clinic_scheduler: 'clinic' };

/**
 * Patient-facing payments (ADR-0020).
 *
 * - `checkout` opens (or reuses) the appointment's payment and provider order. The amount
 *   comes from the appointment row written at booking, never from the client. The
 *   provider call happens outside any database transaction, so a provider failure or
 *   timeout leaves the appointment untouched (still PENDING_PAYMENT, hold running).
 * - Nothing here marks a payment paid: only a verified webhook does (settlement).
 * - `simulate` (fake provider, non-production only) produces a signed provider webhook
 *   and submits it through the normal webhook path.
 */
export function createPaymentService({
  knex,
  config,
  payments,
  appointments,
  accessPolicy,
  audit,
  provider,
  settlement,
  webhookService,
  now = () => new Date(),
}) {
  async function authorizeAppointment(trx, principal, appointmentId, permission, req) {
    if (!isUuid(appointmentId)) throw new NotFoundError();
    const row = await appointments.findForUpdate(trx, appointmentId);
    const decision = await accessPolicy.enforce({
      principal,
      permission,
      resource: {
        type: 'appointment',
        id: appointmentId,
        relPatientId: row?.patient_id,
        doctorUserId: row?.doctor_user_id,
        clinicId: row?.clinic_id ?? undefined,
      },
      req,
      trx,
    });
    return { row, party: PARTY[decision.relationship] };
  }

  /** Opens the payment for a PENDING_PAYMENT appointment and returns checkout data. */
  async function checkout(principal, appointmentId, req) {
    const payment = await withActor(knex, principal.userId, async (trx) => {
      const { row, party } = await authorizeAppointment(
        trx,
        principal,
        appointmentId,
        PERMISSIONS.PAYMENTS_CREATE,
        req,
      );
      if (party !== 'patient') {
        throw new ForbiddenError('Only the patient side pays for an appointment.', 'wrong_party');
      }
      if (row.status !== 'pending_payment') {
        throw new ConflictError(
          row.status === 'confirmed'
            ? 'This appointment needs no payment.'
            : 'This appointment can no longer be paid for.',
          row.status === 'confirmed' ? 'payment_not_required' : 'appointment_not_payable',
        );
      }
      if (row.hold_expires_at <= now()) {
        throw new ConflictError(
          'The time to pay for this booking has run out. Please book again.',
          'payment_hold_expired',
        );
      }
      let existing = await payments.findByAppointment(trx, appointmentId);
      if (!existing) {
        const created = await payments.insert(trx, {
          id: newId(),
          appointment_id: appointmentId,
          patient_id: row.patient_id,
          payer_user_id: principal.userId,
          provider: provider.name,
          amount_paise: row.fee_paise, // authoritative: written at booking from the rule
          currency: row.currency,
          status: 'pending',
        });
        existing = await payments.findByAppointment(trx, appointmentId);
        if (created) {
          await audit.record(
            {
              category: 'financial',
              action: 'payment.create',
              outcome: 'success',
              resourceType: 'payment',
              resourceId: existing.id,
              patientId: row.patient_id,
              metadata: { appointmentId, amountPaise: row.fee_paise, provider: provider.name },
            },
            { req, trx },
          );
          domainMetrics.paymentsCreated.inc();
        }
      }
      if (!OPEN_PAYMENT_STATUSES.includes(existing.status)) {
        throw new ConflictError('This payment is no longer open.', 'payment_not_open');
      }
      return { ...existing, holdExpiresAt: row.hold_expires_at };
    });

    let orderId = payment.provider_order_id;
    if (!orderId) {
      let order;
      try {
        order = await timed(domainMetrics.providerLatency, { operation: 'create_order' }, () =>
          provider.createOrder({
            paymentId: payment.id,
            appointmentId,
            amountPaise: payment.amount_paise,
            currency: payment.currency.trim(),
          }),
        );
        if (order.amountPaise !== payment.amount_paise) {
          throw new PaymentProviderError('invalid_response', 'order amount mismatch');
        }
      } catch (err) {
        if (!(err instanceof PaymentProviderError)) throw err;
        await audit.recordBestEffort(
          {
            category: 'financial',
            action: 'payment.order_failed',
            outcome: 'failure',
            resourceType: 'payment',
            resourceId: payment.id,
            patientId: payment.patient_id,
            reason: err.kind,
          },
          { req },
        );
        throw new PaymentProviderUnavailableError();
      }
      await withSystem(knex, 'payments', async (trx) => {
        if (!(await payments.attachOrder(trx, payment.id, order.orderId))) {
          // A concurrent checkout attached its order first; use that one.
          orderId = (await payments.findById(trx, payment.id)).provider_order_id;
        }
      });
      orderId ??= order.orderId;
    }

    return {
      payment: toPaymentView(payment),
      holdExpiresAt: payment.holdExpiresAt,
      checkout: provider.checkoutOptions({
        orderId,
        amountPaise: payment.amount_paise,
        currency: payment.currency.trim(),
      }),
    };
  }

  /** Receipt view for the patient side. */
  async function getForAppointment(principal, appointmentId, req) {
    return withActor(knex, principal.userId, async (trx) => {
      const { party } = await authorizeAppointment(
        trx,
        principal,
        appointmentId,
        PERMISSIONS.PAYMENTS_READ,
        req,
      );
      if (party !== 'patient') throw new ForbiddenError();
      const payment = await payments.findByAppointment(trx, appointmentId);
      if (!payment) throw new NotFoundError('No payment for this appointment.');
      return toPaymentView(payment, await payments.refundsFor(trx, payment.id));
    });
  }

  /** Doctor or clinic issues a (goodwill/duplicate) refund; amount defaults to the rest. */
  async function refund(
    principal,
    appointmentId,
    { amountPaise, reasonCode },
    idempotencyKey,
    req,
  ) {
    const party = await withActor(knex, principal.userId, async (trx) => {
      const decision = await authorizeAppointment(
        trx,
        principal,
        appointmentId,
        PERMISSIONS.PAYMENTS_REFUND,
        req,
      );
      if (!['doctor', 'clinic'].includes(decision.party)) {
        throw new ForbiddenError('Refunds are issued by the doctor or the clinic.', 'wrong_party');
      }
      return decision.party;
    });
    const { refund: row, created } = await settlement.requestRefund(
      {
        appointmentId,
        amountPaise,
        reason: reasonCode,
        party,
        userId: principal.userId,
        idempotencyKey,
      },
      req,
    );
    return {
      created,
      refund: {
        id: row.id,
        amountPaise: row.amount_paise,
        status: row.status,
        reason: row.reason,
      },
    };
  }

  /**
   * Development/test checkout: the fake provider signs a webhook exactly as a real
   * provider would, and it is processed by the same webhook service. Never available with
   * a real provider or in production.
   */
  async function simulate(principal, appointmentId, { outcome }, req) {
    if (!config.payments.simulationEnabled || provider.name !== 'fake') throw new NotFoundError();
    const payment = await withActor(knex, principal.userId, async (trx) => {
      const { party } = await authorizeAppointment(
        trx,
        principal,
        appointmentId,
        PERMISSIONS.PAYMENTS_CREATE,
        req,
      );
      if (party !== 'patient') throw new ForbiddenError();
      return payments.findByAppointment(trx, appointmentId);
    });
    if (!payment?.provider_order_id) {
      throw new ConflictError('Start the checkout first.', 'checkout_not_started');
    }
    const { rawBody, headers } = provider.webhook(
      outcome === 'success' ? 'payment.captured' : 'payment.failed',
      {
        orderId: payment.provider_order_id,
        amountPaise: payment.amount_paise,
        currency: payment.currency.trim(),
        notes: { hb_payment_id: payment.id, hb_appointment_id: appointmentId },
        ...(outcome === 'failure'
          ? { paymentId: `pay_fake_${newId().slice(0, 8)}`, errorCode: 'BAD_REQUEST_ERROR' }
          : {}),
      },
    );
    return webhookService.handle('fake', rawBody, headers, req);
  }

  return { checkout, getForAppointment, refund, simulate };
}
