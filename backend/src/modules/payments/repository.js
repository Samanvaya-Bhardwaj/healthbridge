import { assertScopedTransaction, assertSystemTransaction } from '../../core/db/actorContext.js';

/** Patient-side payment summary (receipt information; no provider internals). */
export function toPaymentView(payment, refunds = []) {
  if (!payment) return null;
  return {
    id: payment.id,
    reference: payment.id.slice(-8).toUpperCase(),
    appointmentId: payment.appointment_id,
    status: payment.status,
    amountPaise: payment.amount_paise,
    refundedPaise: payment.refunded_paise,
    currency: payment.currency?.trim(),
    paidAt: payment.paid_at,
    failureCode: payment.status === 'failed' ? payment.failure_code : null,
    refunds: refunds.map((r) => ({
      id: r.id,
      amountPaise: r.amount_paise,
      status: r.status,
      reason: r.reason,
      createdAt: r.created_at,
      processedAt: r.processed_at,
    })),
  };
}

/**
 * Payment tables (ADR-0020). Every call needs an actor (patient side, RLS) or a
 * `payments` system transaction; the ledger and webhook events are system-only.
 */
export function createPaymentRepository() {
  const scoped = (trx) => assertScopedTransaction(trx, 'payments');
  const system = (trx) => assertSystemTransaction(trx, 'payments');

  return {
    // ── payments ──
    findByAppointment(trx, appointmentId, { forUpdate = false } = {}) {
      scoped(trx);
      const q = trx('payments').where({ appointment_id: appointmentId });
      if (forUpdate) q.forUpdate();
      return q.first();
    },
    findById(trx, id, { forUpdate = false } = {}) {
      scoped(trx);
      const q = trx('payments').where({ id });
      if (forUpdate) q.forUpdate();
      return q.first();
    },
    findByProviderOrder(trx, provider, orderId) {
      system(trx);
      return trx('payments').where({ provider, provider_order_id: orderId }).first();
    },
    findByProviderPayment(trx, provider, providerPaymentId) {
      system(trx);
      return trx('payments').where({ provider, provider_payment_id: providerPaymentId }).first();
    },
    async insert(trx, row) {
      scoped(trx);
      const inserted = await trx('payments')
        .insert(row)
        .onConflict('appointment_id')
        .ignore()
        .returning('id');
      return inserted.length > 0;
    },
    /** Sets the provider order id once; returns false if another request set it first. */
    async attachOrder(trx, id, orderId) {
      system(trx);
      const n = await trx('payments')
        .where({ id })
        .whereNull('provider_order_id')
        .update({ provider_order_id: orderId });
      return n === 1;
    },
    async update(trx, id, patch) {
      system(trx);
      await trx('payments').where({ id }).update(patch);
    },

    // ── refunds ──
    refundsFor(trx, paymentId) {
      scoped(trx);
      return trx('payment_refunds').where({ payment_id: paymentId }).orderBy('created_at');
    },
    findRefund(trx, id, { forUpdate = false } = {}) {
      system(trx);
      const q = trx('payment_refunds').where({ id });
      if (forUpdate) q.forUpdate();
      return q.first();
    },
    findRefundByProviderId(trx, providerRefundId) {
      system(trx);
      return trx('payment_refunds').where({ provider_refund_id: providerRefundId }).first();
    },
    findRefundByKey(trx, idempotencyKey) {
      system(trx);
      return trx('payment_refunds').where({ idempotency_key: idempotencyKey }).first();
    },
    /** Sum of refunds that are pending, in flight or done (failed ones free the amount). */
    async committedRefundPaise(trx, paymentId) {
      system(trx);
      const row = await trx('payment_refunds')
        .where({ payment_id: paymentId })
        .whereNot({ status: 'failed' })
        .sum({ total: 'amount_paise' })
        .first();
      return Number(row?.total ?? 0);
    },
    async insertRefund(trx, row) {
      system(trx);
      const inserted = await trx('payment_refunds')
        .insert(row)
        .onConflict('idempotency_key')
        .ignore()
        .returning('id');
      return inserted.length > 0;
    },
    async updateRefund(trx, id, patch) {
      system(trx);
      await trx('payment_refunds').where({ id }).update(patch);
    },

    // ── webhook events ──
    /** Inserts a verified provider event; false if it was already received (replay). */
    async insertEvent(trx, row) {
      system(trx);
      const { rows } = await trx.raw(
        `INSERT INTO payment_events (${Object.keys(row).join(', ')})
         VALUES (${Object.keys(row)
           .map(() => '?')
           .join(', ')})
         ON CONFLICT DO NOTHING RETURNING id`,
        Object.values(row),
      );
      return rows.length > 0;
    },
    async completeEvent(trx, id, { status, outcome, paymentId, refundId }) {
      system(trx);
      await trx('payment_events')
        .where({ id })
        .update({
          processing_status: status,
          outcome,
          processed_at: trx.fn.now(),
          ...(paymentId ? { payment_id: paymentId } : {}),
          ...(refundId ? { refund_id: refundId } : {}),
        });
    },

    // ── ledger (append-only) ──
    async appendLedger(trx, row) {
      system(trx);
      const inserted = await trx('ledger_entries')
        .insert(row)
        .onConflict()
        .ignore()
        .returning('id');
      return inserted.length > 0;
    },
    ledgerFor(trx, paymentId) {
      system(trx);
      return trx('ledger_entries').where({ payment_id: paymentId }).orderBy('created_at');
    },
  };
}
