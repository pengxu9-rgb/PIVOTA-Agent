// Proves the normalization adapter makes the kernel consume the REAL backend contract.
// The "REAL" responses below are the exact shapes the repo's own integration tests pin
// (tests/integration/preview_quote.test.js, create_order_quote_id_passthrough.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { wrapUpstream, normalizeUpstream, normalizePreviewQuote, normalizeCreateOrder, parseMoney } from '../src/upstreamAdapter.js';

const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };

// EXACT real backend response shapes.
const REAL_PREVIEW_QUOTE = {
  quote_id: 'q_test', expires_at: '2025-12-22T00:00:00Z', engine: 'shopify_rest_checkout', engine_ref: 'tok_123',
  currency: 'USD',
  pricing: { subtotal: '100.00', discount_total: '10.00', shipping_fee: '5.00', tax: '0.00', total: '95.00' },
  payment_handlers: [{ id: 'shop_pay', type: 'dev.shopify.shop_pay' }],
  line_items: [{ variant_id: 'v1', quantity: 1, unit_price_effective: '90.00' }],
};
const REAL_CREATE_ORDER = {
  status: 'success',
  // amounts.total is MINOR units and consistent with the $95.00 quote (9500) — see the cross-check test.
  order: { order_id: 'ORD_1', quote_id: 'q_123', amounts: { total: '95.00', currency: 'USD' } },
  payment: { psp: 'stripe', client_secret: 'cs_test' },
  tracking: { agent_session_id: 's', created_at: '2026-06-01T00:00:00Z' },
};

test('parseMoney parses MAJOR-unit input → MINOR-unit integers (currency-aware, no float)', () => {
  assert.equal(parseMoney('95.00', 'USD'), 9500);
  assert.equal(parseMoney('0.00', 'USD'), 0);
  assert.equal(parseMoney('19.99', 'USD'), 1999);
  assert.equal(parseMoney('1000', 'JPY'), 1000);   // zero-decimal currency: minor == major
  assert.equal(parseMoney('1.500', 'BHD'), 1500);  // three-decimal currency
  assert.equal(parseMoney('abc', 'USD'), undefined);
  assert.equal(parseMoney('', 'USD'), undefined);
  assert.equal(parseMoney(undefined, 'USD'), undefined);
});

test('normalizePreviewQuote maps pricing strings → locked_totals MINOR integers + merchant_of_record', () => {
  const out = normalizePreviewQuote(REAL_PREVIEW_QUOTE, { quote: { merchant_id: 'm_123', items: [] } });
  assert.equal(out.merchant_of_record, 'm_123');
  assert.equal(out.currency, 'USD');
  assert.deepEqual(out.locked_totals, { subtotal: 10000, tax: 0, shipping: 500, total: 9500 });
  assert.ok(Number.isInteger(out.locked_totals.total));
});

test('normalizeCreateOrder lifts nested order.order_id to top level', () => {
  const out = normalizeCreateOrder(REAL_CREATE_ORDER);
  assert.equal(out.order_id, 'ORD_1');
});

test('END-TO-END: kernel CONSUMES the real backend contract via the adapter (was rejected before)', async () => {
  // Raw upstream returns the REAL shapes; wrapUpstream normalizes them for the kernel.
  const rawUpstream = async (op) => (op === 'preview_quote' ? REAL_PREVIEW_QUOTE : op === 'create_order' ? REAL_CREATE_ORDER : {});
  const kernel = new SafetyKernel({ upstream: wrapUpstream(rawUpstream), secret: 'adapter-secret-0123456789ab', log: { info() {}, warn() {}, error() {} } });

  // preview_quote now SUCCEEDS (previously threw MERCHANT_UNAVAILABLE).
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm_123', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  assert.equal(q.merchant_of_record, 'm_123');
  assert.equal(q.locked_totals.total, 9500); // $95.00 → 9500 minor units

  // create_order works against the real nested order_id; the backend amount cross-check passes (9500==9500).
  const o = await kernel.createOrder({ idempotency_key: 'idem-adapter-1', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  assert.equal(o.order_id, 'ORD_1');
  assert.equal(o.amount_total, 9500, 'charge amount comes from the quote snapshot (INV-5), in MINOR units');
  assert.equal(o.currency, 'USD');
});

test('LIVE CONTRACT (prod probe 2026-06-02): create_order.amounts.total is a MAJOR decimal string, parsed → minor', () => {
  // The prod wire-format probe confirmed (×2) the backend returns amounts.total as a MAJOR-unit decimal
  // STRING ("28.24"), the same shape as preview_quote.pricing.total — NOT a minor integer. The adapter
  // must parse it as major→minor so the cross-check matches the quote.
  const out = normalizeCreateOrder({ status: 'success', order: { order_id: 'ORD_LIVE', amounts: { total: '28.24', currency: 'usd' } } });
  assert.equal(out.order_id, 'ORD_LIVE');
  assert.equal(out.backend_amount_present, true);
  assert.equal(out.backend_amount_minor, 2824, '"28.24" major → 2824 minor');
  assert.equal(out.backend_currency, 'USD', 'currency canonicalized to uppercase');
});

test('LIVE CONTRACT (prod probe run 26879631671, 2026-06-03): $1.69 MAJOR → 169 minor end-to-end, cross-check green', async () => {
  // Re-confirmed on a real cents-priced item via the gateway (pivota-agent-production → v2 backend):
  // pricing.total="1.69", create_order.amounts.total="1.69", currency="USD" present → expected minor 169.
  // Pins the full quote→order money path at the confirmed value so the major→minor flip cannot regress.
  const raw = async (op) => (
    op === 'preview_quote' ? { merchant_of_record: 'm', currency: 'USD', pricing: { subtotal: '1.69', tax: '0.00', shipping_fee: '0.00', total: '1.69' }, line_items: [{ product_id: 'p', quantity: 1 }], acp_state: {} }
    : op === 'create_order' ? { order: { order_id: 'o_169', amounts: { total: '1.69', currency: 'USD' } }, acp_state: {} }
    : {}
  );
  const kernel = new SafetyKernel({ upstream: wrapUpstream(raw), secret: 'adapter-secret-0123456789ab', log: { info() {}, warn() {}, error() {} }, requireBackendAmount: true });
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm', items: [{ product_id: 'p', quantity: 1 }] } }, CTX);
  assert.equal(q.locked_totals.total, 169);
  const o = await kernel.createOrder({ idempotency_key: 'idem-169-0001', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  assert.equal(o.amount_total, 169, 'backend "1.69" major cross-checked against quote 169 minor — no false PRICE_CHANGED');
  assert.equal(o.currency, 'USD');
});

// The REAL `/agent/v1/orders/create` response — the shape the kernel's create_order upstream actually
// receives via the shop gateway (`POST /agent/shop/v1/invoke` → proxied to `/agent/v1/orders/create`).
// It is FLAT: top-level `total` (string) + `total_amount` (float) + `currency` + best-effort `pricing`.
// There is NO `order` wrapper and NO `amounts` object. (Source: routes/agent_api.py:8762 response.)
const REAL_V1_CREATE_ORDER_FLAT = {
  status: 'success',
  order_id: 'ORD_FLAT_169',
  merchant_id: 'm',
  total: '1.69',          // deprecated string, ALWAYS present
  total_amount: 1.69,     // "new standard" float field
  currency: 'USD',
  presentment_currency: 'USD',
  charge_currency: 'USD',
  payment: { psp: 'stripe', client_secret: 'cs_test', payment_intent_id: null, payment_action: null },
  tracking: { agent_session_id: 's', created_at: '2026-06-09T00:00:00Z' },
  pricing: { subtotal: '1.69', tax: '0.00', shipping_fee: '0.00', total: '1.69' },
};

test('LIVE CONTRACT (real /agent/v1/orders/create, FLAT shape): top-level total → backend_amount_present + minor', () => {
  // REGRESSION GUARD for the 2026-06-09 PRICE_CHANGED bug: the adapter previously only read the nested
  // `order.amounts.total`, which is ABSENT here → backend_amount_present=false → backend_amount_missing →
  // PRICE_CHANGED on every real order. The flat top-level `total`/`total_amount` must be read as MAJOR→minor.
  const out = normalizeCreateOrder(REAL_V1_CREATE_ORDER_FLAT);
  assert.equal(out.order_id, 'ORD_FLAT_169', 'top-level order_id lifted');
  assert.equal(out.backend_amount_present, true, 'flat top-level total is a present amount');
  assert.equal(out.backend_amount_minor, 169, '"1.69" major → 169 minor');
  assert.equal(out.backend_currency, 'USD');
});

test('END-TO-END (real FLAT v1 create): quote→order cross-check is GREEN — reproduces+fixes the prod PRICE_CHANGED', async () => {
  // This is the test that would have CAUGHT the prod bug: it feeds the REAL flat create_order wire (no
  // nested order.amounts) with requireBackendAmount on (as prod wires it). On the OLD adapter this throws
  // PRICE_CHANGED{reason:'backend_amount_missing'}; the fix makes the cross-check compare 169==169.
  const raw = async (op) => (
    op === 'preview_quote' ? { merchant_of_record: 'm', currency: 'USD', pricing: { subtotal: '1.69', tax: '0.00', shipping_fee: '0.00', total: '1.69' }, line_items: [{ product_id: 'p', quantity: 1 }], acp_state: {} }
    : op === 'create_order' ? REAL_V1_CREATE_ORDER_FLAT
    : {}
  );
  const kernel = new SafetyKernel({ upstream: wrapUpstream(raw), secret: 'adapter-secret-0123456789ab', log: { info() {}, warn() {}, error() {} }, requireBackendAmount: true });
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm', items: [{ product_id: 'p', quantity: 1 }] } }, CTX);
  assert.equal(q.locked_totals.total, 169);
  const o = await kernel.createOrder({ idempotency_key: 'idem-flat-169', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  assert.equal(o.order_id, 'ORD_FLAT_169');
  assert.equal(o.amount_total, 169, 'charge from quote snapshot (INV-5); flat backend total cross-checked green');
  assert.equal(o.currency, 'USD');
});

test('MONEY-UNITS cross-check: create_order FAILS CLOSED when the backend amount disagrees with the quote', async () => {
  // The $95.00 quote → 9500 minor, but the backend order says 1000 minor ($10): a major/minor or
  // pricing inconsistency. The kernel must reject BEFORE any charge can be authorized.
  const rawUpstream = async (op) => (
    op === 'preview_quote' ? REAL_PREVIEW_QUOTE
    : op === 'create_order' ? { status: 'success', order: { order_id: 'ORD_X', amounts: { total: '10.00', currency: 'USD' } } }
    : {}
  );
  const kernel = new SafetyKernel({ upstream: wrapUpstream(rawUpstream), secret: 'adapter-secret-0123456789ab', log: { info() {}, warn() {}, error() {} } });
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm_123', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  await assert.rejects(
    kernel.createOrder({ idempotency_key: 'idem-xcheck', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX),
    (e) => e.code === 'PRICE_CHANGED' && e.detail?.reason === 'amount_units_mismatch',
  );
});

test('Codex P0-2: cross-check FAILS CLOSED when the backend order currency differs from the quote', async () => {
  // Amounts match (9500 == 9500) but the backend reports the order in JPY, not the quote's USD.
  const rawUpstream = async (op) => (
    op === 'preview_quote' ? REAL_PREVIEW_QUOTE
    : op === 'create_order' ? { status: 'success', order: { order_id: 'ORD_C', amounts: { total: '9500', currency: 'JPY' } } }
    : {}
  );
  const kernel = new SafetyKernel({ upstream: wrapUpstream(rawUpstream), secret: 'adapter-secret-0123456789ab', log: { info() {}, warn() {}, error() {} } });
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm_123', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  await assert.rejects(
    kernel.createOrder({ idempotency_key: 'idem-ccy', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX),
    (e) => e.code === 'PRICE_CHANGED' && e.detail?.reason === 'currency_mismatch',
  );
});

test('Codex P1-2: a surfaced-but-unparseable backend amount FAILS CLOSED (does not silently skip the check)', async () => {
  // The backend surfaces amounts.total as a MAJOR-decimal string "95.00" — exactly the units shape the
  // guard exists to catch. asMinor() can't read it, but because it is PRESENT the kernel must fail closed.
  const rawUpstream = async (op) => (
    op === 'preview_quote' ? REAL_PREVIEW_QUOTE
    : op === 'create_order' ? { status: 'success', order: { order_id: 'ORD_U', amounts: { total: 'unpriceable', currency: 'USD' } } }
    : {}
  );
  const kernel = new SafetyKernel({ upstream: wrapUpstream(rawUpstream), secret: 'adapter-secret-0123456789ab', log: { info() {}, warn() {}, error() {} } });
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm_123', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  await assert.rejects(
    kernel.createOrder({ idempotency_key: 'idem-unp', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX),
    (e) => e.code === 'PRICE_CHANGED' && e.detail?.reason === 'backend_amount_unparseable',
  );
});

test('Codex R2-P2: a lowercase backend currency ("usd") MATCHES the quote (USD) — no false mismatch', async () => {
  const rawUpstream = async (op) => (
    op === 'preview_quote' ? REAL_PREVIEW_QUOTE
    : op === 'create_order' ? { status: 'success', order: { order_id: 'ORD_LC', amounts: { total: '95.00', currency: 'usd' } } }
    : {}
  );
  const kernel = new SafetyKernel({ upstream: wrapUpstream(rawUpstream), secret: 'adapter-secret-0123456789ab', log: { info() {}, warn() {}, error() {} } });
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm_123', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const o = await kernel.createOrder({ idempotency_key: 'idem-lc-1', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  assert.equal(o.order_id, 'ORD_LC');
  assert.equal(o.currency, 'USD'); // stored canonical uppercase
});

test('Codex R2-P1: amount present but currency ABSENT fails closed (cannot verify currency of a charge)', async () => {
  const rawUpstream = async (op) => (
    op === 'preview_quote' ? REAL_PREVIEW_QUOTE
    : op === 'create_order' ? { status: 'success', order: { order_id: 'ORD_NC', amounts: { total: '95.00' /* no currency */ } } }
    : {}
  );
  const kernel = new SafetyKernel({ upstream: wrapUpstream(rawUpstream), secret: 'adapter-secret-0123456789ab', log: { info() {}, warn() {}, error() {} } });
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm_123', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  await assert.rejects(
    kernel.createOrder({ idempotency_key: 'idem-nc-1', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX),
    (e) => e.code === 'PRICE_CHANGED' && e.detail?.reason === 'backend_currency_missing',
  );
});

test('Codex: a present-but-null PRIMARY amount does NOT fall through to a valid fallback (fail closed)', () => {
  // order.amounts.total is explicitly null (present-but-unparseable) but a fallback raw.amount is valid.
  // The adapter must pick the present-but-null primary → unparseable, not the fallback.
  const out = normalizeCreateOrder({ status: 'success', order: { order_id: 'ORD_NF', amounts: { total: null, currency: 'USD' } }, amount: '28.24' });
  assert.equal(out.backend_amount_present, true);
  assert.equal(out.backend_amount_minor, undefined, 'present-but-null primary is unparseable, not the fallback 2824');
});

test('Codex: requireBackendAmount fails closed when the real backend omits the order amount entirely', async () => {
  const rawUpstream = async (op) => (
    op === 'preview_quote' ? REAL_PREVIEW_QUOTE
    : op === 'create_order' ? { status: 'success', order: { order_id: 'ORD_NOAMT' /* no amounts at all */ } }
    : {}
  );
  const kernel = new SafetyKernel({ upstream: wrapUpstream(rawUpstream), secret: 'adapter-secret-0123456789ab', requireBackendAmount: true, log: { info() {}, warn() {}, error() {} } });
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm_123', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  await assert.rejects(
    kernel.createOrder({ idempotency_key: 'idem-noamt', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX),
    (e) => e.code === 'PRICE_CHANGED' && e.detail?.reason === 'backend_amount_missing',
  );
});

test('Codex R2-P1: an explicit null backend total is PRESENT-but-unparseable (not absent) → fail closed', async () => {
  const rawUpstream = async (op) => (
    op === 'preview_quote' ? REAL_PREVIEW_QUOTE
    : op === 'create_order' ? { status: 'success', order: { order_id: 'ORD_NL', amounts: { total: null, currency: 'USD' } } }
    : {}
  );
  const kernel = new SafetyKernel({ upstream: wrapUpstream(rawUpstream), secret: 'adapter-secret-0123456789ab', log: { info() {}, warn() {}, error() {} } });
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm_123', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  await assert.rejects(
    kernel.createOrder({ idempotency_key: 'idem-nl-1', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX),
    (e) => e.code === 'PRICE_CHANGED' && e.detail?.reason === 'backend_amount_unparseable',
  );
});

test('Codex R2-P2: previewQuote rejects an unchargeable amount for the currency (UGX fractional major)', async () => {
  // 5.25 UGX → 525 minor, but UGX charges must be whole major units (multiple of 100) → reject at quote.
  const rawUpstream = async () => ({ currency: 'UGX', merchant_of_record: 'm_123', locked_totals: { total: 525 } });
  const kernel = new SafetyKernel({ upstream: rawUpstream, secret: 'adapter-secret-0123456789ab', log: { info() {}, warn() {}, error() {} } });
  await assert.rejects(
    kernel.previewQuote({ quote: { merchant_id: 'm_123', items: [] } }, CTX),
    (e) => e.code === 'MERCHANT_UNAVAILABLE' && e.detail?.reason === 'unchargeable_amount_for_currency',
  );
});

test('Codex P1-4: previewQuote rejects a NON-INTEGER (non-minor) total even if the adapter is bypassed', async () => {
  // Raw upstream returns an already-"normalized"-looking quote but with a fractional total (95.5) — the
  // canonical model is integer minor units, so the kernel must reject at its own boundary.
  const rawUpstream = async () => ({ currency: 'USD', merchant_of_record: 'm_123', locked_totals: { total: 95.5 } });
  const kernel = new SafetyKernel({ upstream: rawUpstream, secret: 'adapter-secret-0123456789ab', log: { info() {}, warn() {}, error() {} } });
  await assert.rejects(
    kernel.previewQuote({ quote: { merchant_id: 'm_123', items: [] } }, CTX),
    (e) => e.code === 'MERCHANT_UNAVAILABLE',
  );
});

test('adapter still fails CLOSED when the real response is malformed (no fabricated quote)', async () => {
  const rawUpstream = async () => ({ currency: 'USD', pricing: { /* no total */ } });
  const kernel = new SafetyKernel({ upstream: wrapUpstream(rawUpstream), secret: 'adapter-secret-0123456789ab', log: { info() {}, warn() {}, error() {} } });
  await assert.rejects(
    kernel.previewQuote({ quote: { merchant_id: 'm_123', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX),
    (e) => e.code === 'MERCHANT_UNAVAILABLE',
  );
});

test('normalizeSubmitPayment maps the real checkout-session shape → kernel fields', () => {
  const raw = {
    payment_status: 'requires_action', confirmation_owner: 'client', requires_client_confirmation: true,
    payment_intent_id: 'pi_123',
    payment_action: { type: 'redirect_url', url: 'https://psp/3ds', client_secret: 'cs_secret' },
  };
  const out = normalizeUpstream('submit_payment', raw, {});
  assert.equal(out.payment_id, 'pi_123');
  assert.equal(out.redirect_url, 'https://psp/3ds');
  assert.equal(out.client_secret, 'cs_secret');
  assert.equal(out.confirmation_owner, 'client');
  assert.equal(out.requires_client_confirmation, true);
  // reads still pass through untouched
  assert.deepEqual(normalizeUpstream('find_products', { results: [] }, {}), { results: [] });
});
