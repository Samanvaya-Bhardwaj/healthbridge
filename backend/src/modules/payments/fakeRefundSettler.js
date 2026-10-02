import { withSystem } from '../../core/db/actorContext.js';

/**
 * Development/demo only (fake provider): emulates the provider confirming a submitted
 * refund by sending a signed `refund.processed` webhook through the normal webhook path.
 * With a real provider the provider itself sends that webhook.
 */
export function createFakeRefundSettler({ knex, payments, provider, webhookService }) {
  return async function settle(refundId) {
    if (provider.name !== 'fake')
      throw new Error('fake refund settlement requires the fake provider');
    const data = await withSystem(knex, 'payments', async (trx) => {
      const refund = await payments.findRefund(trx, refundId);
      if (!refund || refund.status !== 'processing') return null;
      return { refund, payment: await payments.findById(trx, refund.payment_id) };
    });
    if (!data) return { outcome: 'not_processing' };
    const { refund, payment } = data;
    const { rawBody, headers } = provider.webhook('refund.processed', {
      orderId: payment.provider_order_id,
      paymentId: payment.provider_payment_id,
      amountPaise: payment.amount_paise,
      currency: payment.currency.trim(),
      refund: {
        refundId: refund.provider_refund_id,
        amountPaise: refund.amount_paise,
        notes: { hb_refund_id: refund.id },
      },
    });
    return webhookService.handle('fake', rawBody, headers);
  };
}
