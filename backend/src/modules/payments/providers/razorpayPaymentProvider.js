import { z } from 'zod';
import {
  InvalidWebhookError,
  expectShape,
  parseRazorpayEvent,
  providerFetch,
  verifyHmacSignature,
} from './paymentProvider.js';

const API = 'https://api.razorpay.com/v1';
export const RAZORPAY_SIGNATURE_HEADER = 'x-razorpay-signature';
export const RAZORPAY_EVENT_ID_HEADER = 'x-razorpay-event-id';

const orderShape = z.looseObject({
  id: z.string().min(1).max(64),
  amount: z.number().int().positive(),
  currency: z.string().length(3),
});
const refundShape = z.looseObject({
  id: z.string().min(1).max(64),
  status: z.string(),
  notes: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
});
const listShape = (item) => z.looseObject({ items: z.array(item) });
const paymentShape = z.looseObject({ id: z.string(), status: z.string() });

/**
 * Razorpay adapter (orders + webhooks + refunds) over its REST API.
 *
 * - Orders are created server-side with the amount from our database; the browser only
 *   receives the public key id and order id for Checkout.
 * - Webhooks are authenticated with HMAC-SHA256 over the raw body (webhook secret).
 * - Refunds are made idempotent by looking for an existing refund carrying our refund id
 *   in its notes before creating one.
 * - Orders use automatic capture (payment_capture), so a successful payment produces
 *   `payment.captured`; `payment.authorized` alone never confirms an appointment.
 *
 * @param {{ keyId: string, keySecret: string, webhookSecret: string, timeoutMs: number, fetch?: typeof fetch }} options
 * @returns {import('./paymentProvider.js').PaymentProvider}
 */
export function createRazorpayPaymentProvider({
  keyId,
  keySecret,
  webhookSecret,
  timeoutMs,
  fetch: fetchImpl = fetch,
}) {
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
  const call = (path, { method = 'GET', body } = {}) =>
    providerFetch(fetchImpl, `${API}${path}`, {
      method,
      timeoutMs,
      headers: {
        authorization: auth,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  return {
    name: 'razorpay',

    async createOrder({ paymentId, appointmentId, amountPaise, currency }) {
      const order = expectShape(
        orderShape,
        await call('/orders', {
          method: 'POST',
          body: {
            amount: amountPaise,
            currency,
            receipt: paymentId,
            payment_capture: 1,
            // Identifiers only: notes are visible in the Razorpay dashboard.
            notes: { hb_payment_id: paymentId, hb_appointment_id: appointmentId },
          },
        }),
      );
      return { orderId: order.id, amountPaise: order.amount, currency: order.currency };
    },

    verifyWebhook(rawBody, headers) {
      const signature = headers[RAZORPAY_SIGNATURE_HEADER];
      if (!signature) throw new InvalidWebhookError('missing_signature');
      if (!verifyHmacSignature(rawBody, signature, webhookSecret)) {
        throw new InvalidWebhookError('bad_signature');
      }
      const eventId = headers[RAZORPAY_EVENT_ID_HEADER];
      if (!eventId || eventId.length > 128) throw new InvalidWebhookError('missing_event_id');
      return parseRazorpayEvent(rawBody, eventId);
    },

    async refund({ providerPaymentId, amountPaise, refundId }) {
      const existing = expectShape(
        listShape(refundShape),
        await call(`/payments/${encodeURIComponent(providerPaymentId)}/refunds`),
      ).items.find((r) => !Array.isArray(r.notes) && r.notes?.hb_refund_id === refundId);
      const refund =
        existing ??
        expectShape(
          refundShape,
          await call(`/payments/${encodeURIComponent(providerPaymentId)}/refund`, {
            method: 'POST',
            body: {
              amount: amountPaise,
              speed: 'normal',
              receipt: refundId,
              notes: { hb_refund_id: refundId },
            },
          }),
        );
      return {
        refundId: refund.id,
        status: refund.status === 'processed' ? 'processed' : 'processing',
      };
    },

    async getPaymentStatus(orderId) {
      const payments = expectShape(
        listShape(paymentShape),
        await call(`/orders/${encodeURIComponent(orderId)}/payments`),
      ).items;
      const captured = payments.find((p) => p.status === 'captured');
      return {
        status: captured ? 'paid' : payments.length ? 'attempted' : 'created',
        paidPaymentId: captured?.id ?? null,
      };
    },

    checkoutOptions({ orderId, amountPaise, currency }) {
      // Public values only: the key id is designed to be embedded in the browser.
      return { provider: 'razorpay', keyId, orderId, amountPaise, currency, name: 'HealthBridge' };
    },
  };
}
