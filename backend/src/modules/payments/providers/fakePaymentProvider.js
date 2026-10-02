import { createHash, randomUUID } from 'node:crypto';
import {
  InvalidWebhookError,
  PaymentProviderError,
  hmacHex,
  parseRazorpayEvent,
  verifyHmacSignature,
} from './paymentProvider.js';

export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';
export const FAKE_EVENT_ID_HEADER = 'x-fake-event-id';

const short = (value, length = 14) =>
  createHash('sha256').update(value).digest('hex').slice(0, length);

/**
 * Deterministic, offline PaymentProvider for development, tests and demo mode. No money
 * moves. Uses Razorpay's webhook wire format, signed with the configured webhook secret,
 * so webhook verification and processing run the same code path as production.
 *
 * Failure injection (tests): `provider.failNext('createOrder', 'timeout' | 'unavailable' |
 * 'invalid_response' | 'rejected')` makes the next call of that operation fail.
 *
 * @param {{ webhookSecret: string, delayMs?: number }} options
 * @returns {import('./paymentProvider.js').PaymentProvider & Record<string, Function>}
 */
export function createFakePaymentProvider({ webhookSecret, delayMs = 0 }) {
  const failures = new Map();
  const refunds = new Map(); // idempotencyKey → refund
  const orders = new Map(); // orderId → { amountPaise, currency, paidPaymentId }
  const calls = { createOrder: 0, refund: 0, getPaymentStatus: 0 };

  async function maybeFail(operation) {
    calls[operation] += 1;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const kind = failures.get(operation)?.shift();
    if (kind) throw new PaymentProviderError(kind, `fake ${operation} failure: ${kind}`);
  }

  function sign(body, eventId = `evt_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`) {
    const rawBody = Buffer.from(JSON.stringify(body));
    return {
      rawBody,
      headers: {
        'content-type': 'application/json',
        [FAKE_SIGNATURE_HEADER]: hmacHex(rawBody, webhookSecret),
        [FAKE_EVENT_ID_HEADER]: eventId,
      },
      eventId,
    };
  }

  return {
    name: 'fake',
    calls,

    failNext(operation, kind, times = 1) {
      failures.set(operation, [...(failures.get(operation) ?? []), ...Array(times).fill(kind)]);
    },

    async createOrder({ paymentId, amountPaise, currency }) {
      await maybeFail('createOrder');
      const orderId = `order_fake_${short(paymentId)}`;
      orders.set(orderId, { amountPaise, currency, paidPaymentId: null });
      return { orderId, amountPaise, currency };
    },

    verifyWebhook(rawBody, headers) {
      const signature = headers[FAKE_SIGNATURE_HEADER];
      if (!signature) throw new InvalidWebhookError('missing_signature');
      if (!verifyHmacSignature(rawBody, signature, webhookSecret)) {
        throw new InvalidWebhookError('bad_signature');
      }
      const eventId = headers[FAKE_EVENT_ID_HEADER];
      if (!eventId || eventId.length > 128) throw new InvalidWebhookError('missing_event_id');
      return parseRazorpayEvent(rawBody, eventId);
    },

    async refund({ providerPaymentId, amountPaise, idempotencyKey, refundId }) {
      await maybeFail('refund');
      const existing = refunds.get(idempotencyKey);
      if (existing) return { refundId: existing.refundId, status: existing.status };
      const result = { refundId: `rfnd_fake_${short(idempotencyKey)}`, status: 'processing' };
      refunds.set(idempotencyKey, { ...result, providerPaymentId, amountPaise, ourId: refundId });
      return { ...result };
    },

    async getPaymentStatus(orderId) {
      await maybeFail('getPaymentStatus');
      const order = orders.get(orderId);
      if (!order) throw new PaymentProviderError('rejected', 'unknown order');
      return {
        status: order.paidPaymentId ? 'paid' : 'created',
        paidPaymentId: order.paidPaymentId,
      };
    },

    checkoutOptions({ orderId, amountPaise, currency }) {
      return { provider: 'fake', orderId, amountPaise, currency, simulated: true };
    },

    /**
     * Builds a signed provider webhook, as the real provider would send it.
     * @param {'payment.authorized'|'payment.captured'|'payment.failed'|'order.paid'|'refund.created'|'refund.processed'|'refund.failed'} event
     */
    webhook(
      event,
      { orderId, paymentId, amountPaise, currency = 'INR', notes = {}, refund, errorCode, eventId },
    ) {
      const providerPaymentId = paymentId ?? `pay_fake_${short(`${orderId}:${event}`)}`;
      if (event === 'payment.captured' || event === 'order.paid') {
        const order = orders.get(orderId);
        if (order) order.paidPaymentId = providerPaymentId;
      }
      const payment = {
        id: providerPaymentId,
        entity: 'payment',
        order_id: orderId,
        amount: amountPaise,
        currency,
        status: event.split('.')[1],
        error_code: errorCode ?? null,
        notes,
      };
      const payload = { payment: { entity: payment } };
      if (refund) {
        payload.refund = {
          entity: {
            id: refund.refundId,
            entity: 'refund',
            payment_id: providerPaymentId,
            amount: refund.amountPaise,
            currency,
            status: event.split('.')[1],
            notes: refund.notes ?? {},
          },
        };
      }
      if (event === 'order.paid') payload.order = { entity: { id: orderId } };
      return sign(
        {
          entity: 'event',
          account_id: 'acc_fake',
          event,
          contains: Object.keys(payload),
          payload,
          created_at: Math.floor(Date.now() / 1000),
        },
        eventId,
      );
    },
  };
}
