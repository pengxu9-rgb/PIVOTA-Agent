#!/usr/bin/env node
/**
 * B4 helper — complete a TEST-mode Stripe PaymentIntent with a test card so the
 * payment_intent.succeeded webhook fires and the order finalizes to paid.
 *
 * SAFETY: refuses any key that is not sk_test_… — it can NEVER run a real charge.
 *
 * Env:
 *   STRIPE_SECRET_KEY    Required. Your merchant's Stripe TEST secret key (sk_test_…). Never printed.
 *   PAYMENT_INTENT_ID    Required. e.g. pi_3Tecbx...
 *   STRIPE_ACCOUNT       Optional. Connected account id (acct_…) if the merchant uses Stripe Connect.
 *   TEST_PAYMENT_METHOD  Optional. Default pm_card_visa (Stripe's shared 4242 test method, no 3DS).
 *
 * Run:
 *   STRIPE_SECRET_KEY=sk_test_xxx PAYMENT_INTENT_ID=pi_3Tecbx... node scripts/b4_complete_charge.mjs
 */

function must(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) { console.error(`Missing required env ${name}`); process.exit(1); }
  return String(v).trim();
}

const key = must('STRIPE_SECRET_KEY');
if (!key.startsWith('sk_test_')) {
  console.error('REFUSING: STRIPE_SECRET_KEY must be a TEST key (sk_test_…). This script never runs a live charge.');
  process.exit(1);
}
const piId = must('PAYMENT_INTENT_ID');
const account = (process.env.STRIPE_ACCOUNT || '').trim();
const pm = (process.env.TEST_PAYMENT_METHOD || 'pm_card_visa').trim();
// The PI accepts redirect-capable methods, so Stripe requires a return_url on confirm
// (a card won't actually redirect). Any URL is fine for a test confirm; override via RETURN_URL.
const returnUrl = (process.env.RETURN_URL || 'https://pivota.cc/probe/return').trim();

const headers = {
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/x-www-form-urlencoded',
};
if (account) headers['Stripe-Account'] = account;

const body = new URLSearchParams({ payment_method: pm, return_url: returnUrl }).toString();

const resp = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(piId)}/confirm`, {
  method: 'POST', headers, body,
});
const json = await resp.json().catch(() => ({}));

if (!resp.ok) {
  const msg = json && json.error ? `${json.error.type || ''} ${json.error.message || ''}`.trim() : `HTTP ${resp.status}`;
  console.error(`confirm failed: ${msg}`);
  if (json?.error?.code === 'resource_missing' && !account) {
    console.error('Hint: if the merchant uses Stripe Connect, set STRIPE_ACCOUNT=acct_… (the connected account id).');
  }
  process.exit(2);
}

console.log(`PaymentIntent ${json.id}`);
console.log(`  status   = ${json.status}`);          // expect: succeeded
console.log(`  amount   = ${json.amount} ${String(json.currency || '').toUpperCase()}`);  // expect: 2824 USD
console.log(`  livemode = ${json.livemode}`);          // expect: false (test mode)
if (json.status === 'succeeded') {
  console.log('\n✅ Charged in test mode — payment_intent.succeeded should now reach the webhook → order flips to paid.');
} else if (json.status === 'requires_action') {
  console.log('\n⚠️ requires_action (3DS). Use TEST_PAYMENT_METHOD=pm_card_visa (no 3DS) or complete the 3DS step.');
} else {
  console.log(`\n⚠️ status=${json.status} — not succeeded; the webhook may not finalize the order.`);
}
