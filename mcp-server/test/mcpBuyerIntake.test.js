// MCP commerce door — buyer / address / item-identity INTAKE.
//
// The defects these cover were MEASURED through the real wiring, not inferred. `create_checkout_session` was
// a pure ALLOWLIST (`pickQuote`), and an allowlist is a filter, not a validator, so every one of these
// reached the backend:
//
//   | tool args                          | body the backend received                                        |
//   |------------------------------------|------------------------------------------------------------------|
//   | no `customer_email`                | no `buyer_context` -> the session mints, then order-create 400s   |
//   |                                    | INVALID_BUYER_CONTEXT                                            |
//   | `items:[{sku_id:'s1'}]`            | `offer_refs` ENTIRELY ABSENT -> prices an EMPTY cart              |
//   | `items:[{product_id:'p1'}]`        | `offer_refs:[{product_id:'p1', variant_id:'p1'}]` -> the variant  |
//   |                                    | FORGED from the product id                                       |
//   | `customer_email:'model@evil.test'` | passed through even for a signed-in buyer whose credential       |
//   |                                    | attests a different address                                      |
//   | `shipping_address:{city:'London'}` | a partial destination priced for shipping/tax                    |
//
// The middle two are MONEY-CORRECTNESS bugs — the priced cart is not the requested cart, and both fail
// SILENTLY with a 200.
//
// The load-bearing assertions here are the same three the ACP door's suite pins, because both doors now run
// the SAME intake (safety-kernel/src/protocol/buyerIntake.js):
//   1. PRECEDENCE — an ATTESTED email from the verified session's claims beats a conflicting tool argument.
//   2. PII — the captured email reaches the QUOTE PAYLOAD and nothing else: not an error body, not a result.
//   3. FAIL BEFORE PRICING — every refusal happens before upstream `preview_quote` is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../../safety-kernel/src/kernel.js';
import { createCanonicalExecutor } from '../../safety-kernel/src/protocol/canonicalExecutor.js';
import { createCommerceToolSurface, toToolError } from '../src/commerceToolSurface.js';

const MERCHANT = 'merch_A';
const SECRET = 'mcp-intake-secret-0123456789abcdef';
const FIXED_NOW = 1_900_000_000_000;
const quiet = { info() {}, warn() {}, error() {} };
const QUOTE = {
  merchant_of_record: MERCHANT, currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: {},
};
const ATTESTED = 'attested@example.com';
const ADDRESS = {
  recipient_name: 'Ada Lovelace', address_line1: '1 Analytical Way',
  city: 'London', postal_code: 'EC1A 1BB', country: 'GB',
};

/**
 * @param claims what the VERIFIED session context carries (src/server.js puts the whole verified JWT payload
 *               there). `null` = a signed-in buyer whose credential attests nothing.
 * @param productRead stand-in for the canonical `get_product` read the door resolves a default variant
 *               through. Omitted, it answers `{}` (no variants) — which REFUSES, by design.
 */
function setup({ claims = { iss: 'https://idp.test', sub: 'b1', email: ATTESTED, email_verified: true }, productRead } = {}) {
  const priced = [];
  const productReads = [];
  const linkCalls = [];
  const kernelUpstream = async (op, payload) => {
    if (op === 'preview_quote') { priced.push(payload?.quote ?? {}); return QUOTE; }
    if (op === 'create_order') return { order_id: 'o_mcp', acp_state: {} };
    if (op === 'submit_payment') return { order_id: 'o_mcp', payment_id: 'pay1', payment_status: 'succeeded' };
    return {};
  };
  const readUpstream = async (op, payload) => {
    if (op === 'create_payment_link') {
      linkCalls.push(payload);
      return { checkout_url: 'https://checkout.example.com/pay/abc' };
    }
    if (op === 'get_product_detail') {
      productReads.push(payload);
      return typeof productRead === 'function' ? productRead(payload) : (productRead ?? {});
    }
    return {};
  };
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log: quiet, now: () => FIXED_NOW });
  const executor = createCanonicalExecutor({
    kernel, upstream: readUpstream, hostedLinkEnabled: true,
    verifyPaymentAuthorization: async () => ({ ok: true }),
  });
  const surface = createCommerceToolSurface(executor);
  const sess = { user_ref: 'usr_mcp', acp_session_id: 'sess_mcp', ...(claims ? { claims } : {}) };
  return { surface, sess, priced: () => priced, productReads: () => productReads, linkCalls: () => linkCalls };
}

const CART = (items = [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], extra = {}) => ({
  merchant_id: MERCHANT, items, ...extra,
});
let seq = 0;
const create = (surface, sess, quote) =>
  surface.callTool('create_checkout_session', { idempotency_key: `idem-mcp-${++seq}`, quote }, sess);
/** Resolve to the thrown error rather than throwing, so a test can assert on it without try/catch noise. */
const refusal = (p) => p.then(() => null, (e) => e);
const productWith = (...variants) => ({ product: { product_id: 'p1', merchant_id: MERCHANT, variants } });

// ---- 1. buyer email: ATTESTED WINS -------------------------------------------------------------------------

test('email via CLAIMS: the attested address is captured into the quote payload', async () => {
  const { surface, sess, priced } = setup();
  await create(surface, sess, CART());
  assert.equal(priced()[0].customer_email, ATTESTED);
});

test('PRECEDENCE: an ATTESTED email WINS over a conflicting tool argument (the model never picks the receipt)', async () => {
  const { surface, sess, priced } = setup();
  await create(surface, sess, CART(undefined, { customer_email: 'model-asserted@evil.example' }));
  assert.equal(priced()[0].customer_email, ATTESTED, 'a caller-supplied address must never override an attested one');
});

test('email via TOOL ARGS only: used when the verified session attests none', async () => {
  const { surface, sess, priced } = setup({ claims: { iss: 'https://idp.test', sub: 'b1' } });
  await create(surface, sess, CART(undefined, { customer_email: 'body@example.com' }));
  assert.equal(priced()[0].customer_email, 'body@example.com');
});

test('email ABSENT entirely: refused BEFORE pricing, with a named, actionable detail', async () => {
  const { surface, sess, priced } = setup({ claims: null });
  const err = await refusal(create(surface, sess, CART()));
  assert.ok(err, 'must refuse');
  assert.equal(err.code, 'QUOTE_REQUIRED');
  assert.equal(err.detail.acp_detail.reason, 'acp_buyer_email_required');
  assert.equal(err.detail.acp_detail.attested_wins, true);
  assert.equal(priced().length, 0, 'nothing may be priced without a buyer_context the order lane will accept');
});

test('the model gets the ACTIONABLE message, not the generic per-code one', async () => {
  const { surface, sess } = setup({ claims: null });
  const err = await refusal(create(surface, sess, CART()));
  const body = JSON.parse(toToolError(err).content[0].text).error;
  assert.equal(body.code, 'QUOTE_REQUIRED');
  assert.match(body.message, /buyer email is required/i);
  assert.notEqual(body.message, err.userMessage, 'the generic "I need a fresh price quote" names nothing to fix');
  assert.equal(body.detail.reason, 'acp_buyer_email_required');
});

test('email MALFORMED in the tool args (and none attested): refused, and the bad value is NOT echoed', async () => {
  const { surface, sess, priced } = setup({ claims: null });
  const bad = 'not an <email>';
  const err = await refusal(create(surface, sess, CART(undefined, { customer_email: bad })));
  assert.equal(err.detail.acp_detail.reason, 'acp_buyer_email_required');
  assert.ok(!JSON.stringify(toToolError(err)).includes(bad), 'a refusal names FIELDS, never the rejected value');
  assert.equal(priced().length, 0);
});

test('attested `email_verified:false` is NOT an attestation: the tool args may then supply the email', async () => {
  const { surface, sess, priced } = setup({ claims: { iss: 'https://idp.test', sub: 'b1', email: ATTESTED, email_verified: false } });
  await create(surface, sess, CART(undefined, { customer_email: 'body@example.com' }));
  assert.equal(priced()[0].customer_email, 'body@example.com', 'a disclaimed address is not attested');
});

test('an attested NAME also wins over a caller-supplied one', async () => {
  const { surface, sess, priced } = setup({
    claims: { iss: 'https://idp.test', sub: 'b1', email: ATTESTED, email_verified: true, name: 'Ada Lovelace' },
  });
  await create(surface, sess, CART(undefined, { customer_name: 'Someone Else' }));
  assert.equal(priced()[0].customer_name, 'Ada Lovelace');
});

// ---- 2. item identity: RESOLVE, never forge ----------------------------------------------------------------

test('MONEY-CORRECTNESS: a `sku_id`-only item is REFUSED (it would price an EMPTY cart)', async () => {
  const { surface, sess, priced, productReads } = setup({ productRead: productWith({ variant_id: 'v1' }) });
  const err = await refusal(create(surface, sess, CART([{ sku_id: 's1', quantity: 1 }])));
  assert.equal(err.code, 'QUOTE_REQUIRED');
  assert.equal(err.detail.acp_detail.reason, 'acp_item_identity_required');
  assert.equal(err.detail.acp_detail.variant_resolution, 'product_id_required');
  assert.equal(productReads().length, 0, 'there is no product to resolve against');
  assert.equal(priced().length, 0);
});

test('`product_id` ONLY + exactly ONE real variant: RESOLVED, and the resolved id is what reaches pricing', async () => {
  const { surface, sess, priced } = setup({ productRead: productWith({ variant_id: 'v_real' }) });
  await create(surface, sess, CART([{ product_id: 'p1', quantity: 1 }]));
  assert.deepEqual(priced()[0].items, [{ product_id: 'p1', quantity: 1, variant_id: 'v_real' }]);
});

test('MONEY-CORRECTNESS: the resolved id is NEVER the product id restated — the forging bug, refused', async () => {
  // This is exactly what src/pdpBuilder.js buildVariants fabricates for a variant-less product, and exactly
  // what `variant_id || sku || product_id` in the shared quote-body builder used to write here.
  const { surface, sess, priced } = setup({ productRead: productWith({ variant_id: 'p1' }) });
  const err = await refusal(create(surface, sess, CART([{ product_id: 'p1', quantity: 1 }])));
  assert.equal(err.detail.acp_detail.variant_resolution, 'no_real_variant_identity');
  assert.equal(priced().length, 0, 'a forged variant prices a cart nobody asked for — and does it silently');
});

test('MONEY-CORRECTNESS: the `${product_id}-1` shape is a restatement too, and is refused', async () => {
  const { surface, sess, priced } = setup({ productRead: productWith({ variant_id: 'p1-1' }) });
  const err = await refusal(create(surface, sess, CART([{ product_id: 'p1', quantity: 1 }])));
  assert.equal(err.detail.acp_detail.variant_resolution, 'no_real_variant_identity');
  assert.equal(priced().length, 0);
});

test('`product_id` ONLY + MULTIPLE variants: refused as AMBIGUOUS with the count, before pricing', async () => {
  const { surface, sess, priced } = setup({ productRead: productWith({ variant_id: 'v1' }, { variant_id: 'v2' }) });
  const err = await refusal(create(surface, sess, CART([{ product_id: 'p1', quantity: 1 }])));
  assert.equal(err.detail.acp_detail.variant_resolution, 'ambiguous');
  assert.equal(err.detail.acp_detail.variant_count, 2);
  assert.equal(priced().length, 0, 'guessing an option prices a cart the buyer did not choose');
});

test('`product_id` ONLY + ZERO variants: refused, count 0, distinguishable from the ambiguous case', async () => {
  const { surface, sess, priced } = setup({ productRead: productWith() });
  const err = await refusal(create(surface, sess, CART([{ product_id: 'p1', quantity: 1 }])));
  assert.equal(err.detail.acp_detail.variant_resolution, 'no_variants');
  assert.equal(err.detail.acp_detail.variant_count, 0);
  assert.equal(priced().length, 0);
});

test('a read answering about a DIFFERENT product is refused; its variants are NOT used', async () => {
  const { surface, sess, priced } = setup({ productRead: { product: { product_id: 'SOMETHING_ELSE', variants: [{ variant_id: 'v_of_other' }] } } });
  const err = await refusal(create(surface, sess, CART([{ product_id: 'p1', quantity: 1 }])));
  assert.equal(err.detail.acp_detail.variant_resolution, 'identity_mismatch');
  assert.equal(priced().length, 0);
});

test('an item with an EXPLICIT variant_id is accepted verbatim and triggers NO resolution read', async () => {
  const { surface, sess, priced, productReads } = setup({ productRead: productWith({ variant_id: 'v_other' }) });
  await create(surface, sess, CART([{ product_id: 'p1', variant_id: 'v_chosen', quantity: 1 }]));
  assert.equal(priced()[0].items[0].variant_id, 'v_chosen');
  assert.equal(productReads().length, 0);
});

test('an EMPTY cart is refused (it used to reach kernel.previewQuote with no line items at all)', async () => {
  const { surface, sess, priced } = setup();
  const err = await refusal(create(surface, sess, { merchant_id: MERCHANT, items: [] }));
  assert.equal(err.code, 'QUOTE_REQUIRED');
  assert.equal(priced().length, 0);
});

test('a CHEAP refusal (missing buyer email) is answered without spending an upstream read', async () => {
  const { surface, sess, productReads } = setup({ claims: null, productRead: productWith({ variant_id: 'v1' }) });
  const err = await refusal(create(surface, sess, CART([{ product_id: 'p1', quantity: 1 }])));
  assert.equal(err.detail.acp_detail.reason, 'acp_buyer_email_required');
  assert.equal(productReads().length, 0, 'resolution runs last, after every free refusal');
});

// ---- 3. address: optional, COMPLETE if present -------------------------------------------------------------

test('address ABSENT: allowed at create (price first, pick a destination later)', async () => {
  const { surface, sess, priced } = setup();
  await create(surface, sess, CART());
  assert.equal(priced()[0].shipping_address, undefined);
});

test('address COMPLETE: mapped through, recipient_name preserved (not renamed)', async () => {
  const { surface, sess, priced } = setup();
  await create(surface, sess, CART(undefined, { shipping_address: ADDRESS }));
  const addr = priced()[0].shipping_address;
  assert.equal(addr.recipient_name, 'Ada Lovelace');
  assert.equal(addr.city, 'London');
  assert.equal(addr.country, 'GB');
});

test('address PARTIAL: refused before pricing, naming exactly the missing fields', async () => {
  const { surface, sess, priced } = setup();
  const err = await refusal(create(surface, sess, CART(undefined, { shipping_address: { city: 'London' } })));
  assert.equal(err.code, 'QUOTE_REQUIRED');
  assert.equal(err.detail.acp_detail.reason, 'acp_fulfillment_address_incomplete');
  assert.deepEqual(err.detail.acp_detail.missing_fields, ['name', 'address_line1', 'postal_code', 'country']);
  assert.deepEqual(err.detail.acp_detail.required_fields, ['name', 'address_line1', 'city', 'postal_code', 'country']);
  assert.equal(priced().length, 0, 'a partial destination must never price shipping/tax');
});

test('address PARTIAL on complete_checkout_session is refused too (the ACP door checks it at the same point)', async () => {
  const { surface, sess } = setup();
  const created = await create(surface, sess, CART());
  const err = await refusal(surface.callTool('complete_checkout_session', {
    idempotency_key: 'idem-complete-1',
    session_id: created.session_id,
    payment_authorization: { method: 'acp_delegated_token', token: {} },
    shipping_address: { city: 'London' },
  }, sess));
  assert.equal(err.detail.acp_detail.reason, 'acp_fulfillment_address_incomplete');
});

// ---- 4. update is held to the SAME rules -------------------------------------------------------------------

test('update_checkout_session is held to the SAME intake (its snapshot REPLACES, it does not merge)', async () => {
  const { surface, sess, priced } = setup({ claims: null });
  const created = await surface.callTool('create_checkout_session', {
    idempotency_key: 'idem-upd-c', quote: CART(undefined, { customer_email: 'body@example.com' }),
  }, sess);
  const err = await refusal(surface.callTool('update_checkout_session', {
    idempotency_key: 'idem-upd-1', session_id: created.session_id, quote: CART(),
  }, sess));
  assert.equal(err.detail.acp_detail.reason, 'acp_buyer_email_required', 'an omitted email on update is DROPPED, not kept');
  assert.equal(priced().length, 1, 'only the create priced');
});

test('update_checkout_session advertises the SAME quote schema it enforces', () => {
  const { surface } = setup();
  const byName = Object.fromEntries(surface.tools.map((t) => [t.name, t]));
  assert.deepEqual(
    byName.update_checkout_session.inputSchema.properties.quote,
    byName.create_checkout_session.inputSchema.properties.quote,
    'advertising a looser shape than the door enforces teaches a model to send a body it will be refused for',
  );
});

// ---- 5. create_payment_link (guest hosted checkout) --------------------------------------------------------

test('create_payment_link: an ATTESTED email wins over the caller-supplied one', async () => {
  const { surface, sess, linkCalls } = setup();
  const created = await create(surface, sess, CART());
  await surface.callTool('create_payment_link', {
    idempotency_key: 'idem-link-1', session_id: created.session_id,
    customer_email: 'model-asserted@evil.example',
  }, sess);
  assert.equal(linkCalls()[0].customer_email, ATTESTED, 'the hosted receipt must go to the attested address');
});

test('create_payment_link: with NO attested email the caller-supplied one is still accepted (guest checkout)', async () => {
  const { surface, sess, linkCalls } = setup({ claims: null });
  const created = await surface.callTool('create_checkout_session', {
    idempotency_key: 'idem-link-c2', quote: CART(undefined, { customer_email: 'guest@example.com' }),
  }, sess);
  await surface.callTool('create_payment_link', {
    idempotency_key: 'idem-link-2', session_id: created.session_id, customer_email: 'guest@example.com',
  }, sess);
  assert.equal(linkCalls()[0].customer_email, 'guest@example.com');
});

// ---- 6. PII ------------------------------------------------------------------------------------------------

test('PII: the captured email reaches the QUOTE PAYLOAD and nothing else — not the tool result', async () => {
  const { surface, sess, priced } = setup();
  const created = await create(surface, sess, CART());
  assert.equal(priced()[0].customer_email, ATTESTED);
  assert.ok(!JSON.stringify(created).includes(ATTESTED), 'the session response must not carry the buyer email');
});

test('PII: a refusal raised AFTER the email was captured still carries no PII', async () => {
  const { surface, sess } = setup({ productRead: productWith({ variant_id: 'v1' }, { variant_id: 'v2' }) });
  const err = await refusal(create(surface, sess, CART([{ product_id: 'p1', quantity: 1 }])));
  assert.ok(!JSON.stringify(toToolError(err)).includes(ATTESTED));
});
