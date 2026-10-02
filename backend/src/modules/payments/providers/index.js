import { createFakePaymentProvider } from './fakePaymentProvider.js';
import { createRazorpayPaymentProvider } from './razorpayPaymentProvider.js';

/**
 * Chooses the PaymentProvider from configuration (one factory per capability, ADR-0007).
 * Configuration validation already refuses the fake provider in production and live
 * Razorpay keys outside production.
 * @param {ReturnType<typeof import('../../../config/index.js').loadConfig>['payments']} payments
 */
export function createPaymentProvider(payments, { fetch } = {}) {
  if (payments.provider === 'razorpay') {
    return createRazorpayPaymentProvider({
      keyId: payments.razorpay.keyId,
      keySecret: payments.razorpay.keySecret,
      webhookSecret: payments.webhookSecret,
      timeoutMs: payments.timeoutMs,
      ...(fetch ? { fetch } : {}),
    });
  }
  return createFakePaymentProvider({ webhookSecret: payments.webhookSecret });
}
