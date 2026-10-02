const CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

let loading = null;

function loadScript() {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error('Could not load the payment window. Please try again.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Opens Razorpay Checkout for a server-created order. The handler's response is NOT
 * proof of payment: the page only switches to "processing" and waits for the server,
 * which confirms the appointment after the provider's verified webhook.
 *
 * @param {{ keyId: string, orderId: string, amountPaise: number, currency: string, name: string }} checkout
 * @param {{ onSubmitted: () => void, onDismiss: () => void }} callbacks
 */
export async function openRazorpayCheckout(checkout, { onSubmitted, onDismiss }) {
  await loadScript();
  const instance = new window.Razorpay({
    key: checkout.keyId,
    order_id: checkout.orderId,
    amount: checkout.amountPaise,
    currency: checkout.currency,
    name: checkout.name,
    description: 'Consultation fee',
    handler: () => onSubmitted(),
    modal: { ondismiss: () => onDismiss() },
    theme: { color: '#0f766e' },
  });
  instance.on('payment.failed', () => onSubmitted());
  instance.open();
}
