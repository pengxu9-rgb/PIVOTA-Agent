// PR-E — ACP door buyer/address/item INTAKE (design gaps P1-P3).
//
// The defect these cover: the ACP REST door could create checkout sessions but could not complete an order
// for ANYONE, because it never captured a buyer email and pivota-backend `POST /agent/v2/orders` hard-requires
// one (`routes/agent_v2.py`: empty customer_email -> 400 INVALID_BUYER_CONTEXT). Two adjacent intake gaps —
// a partial fulfillment address, and an item whose variant_id gets synthesised from its product_id — fail
// later for the same structural reason. All three are now refused (or captured) AT INTAKE.
//
// The load-bearing assertions here are:
//   1. PRECEDENCE — an ATTESTED email from the verified buyer credential beats a conflicting body value.
//   2. PII — the captured email reaches the QUOTE PAYLOAD and nothing else: not an error body, not a log
//      line, not the session/order response.
//   3. FAIL BEFORE PRICING — every refusal happens before upstream `preview_quote` is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { SafetyKernel } from '../src/kernel.js';
import { InMemoryKvStore } from '../src/stores.js';
import { redact } from '../src/redact.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { createAcpRestAdapter } from '../src/protocol/acpRestAdapter.js';
import { attestedBuyerFromClaims } from '../src/identity/userTokenVerifier.js';

const SECRET = 'acp-signing-secret-0123456789abcdef';
const KSECRET = 'acp-kernel-secret-0123456789abcdef';
const FIXED_NOW = 1_900_000_000_000;
const QUOTE = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: {},
};
const okVerify = async (_a, b) => ({ ok: true, amount: b.amount, currency: b.currency, user_ref: b.user_ref });

const ADDRESS = {
  recipient_name: 'Ada Lovelace', address_line1: '1 Analytical Way',
  city: 'London', postal_code: 'EC1A 1BB', country: 'GB',
};

/**
 * @param identity what the injected resolveUserRef returns — a bare STRING (the historical shape, no
 *                 attested claims) or a buyer-identity OBJECT (attested email/name).
 * @param productRead OPTIONAL stand-in for the executor's `get_product_detail` READ — the same read the door
 *                 now resolves an item's default variant through. Omitted, it answers `{}` (no variants),
 *                 which is what every pre-existing test in this file expects.
 * @param variantResolutionTimeoutMs the door's bound on that read.
 */
function setup({ identity = 'buyer_1', productRead, variantResolutionTimeoutMs } = {}) {
  const upstreamCalls = [];
  const readCalls = [];
  const logLines = [];
  const capturingLog = {
    info: (...a) => logLines.push(a), warn: (...a) => logLines.push(a), error: (...a) => logLines.push(a),
  };
  const kernelUpstream = async (op, payload) => {
    upstreamCalls.push({ op, payload });
    return op === 'preview_quote' ? QUOTE
      : op === 'create_order' ? { order_id: 'o_acp', acp_state: {} }
      : op === 'submit_payment' ? { order_id: 'o_acp', payment_id: 'pay1', payment_status: 'succeeded' }
      : {};
  };
  const readUpstream = async (op, payload) => {
    readCalls.push({ op, payload });
    return typeof productRead === 'function' ? productRead(payload) : {};
  };
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: KSECRET, log: capturingLog, now: () => FIXED_NOW });
  const executor = createCanonicalExecutor({ kernel, upstream: readUpstream, verifyPaymentAuthorization: okVerify });
  const adapter = createAcpRestAdapter({
    executor,
    sessionStore: new InMemoryKvStore({ now: () => FIXED_NOW }),
    signingSecret: SECRET,
    resolveUserRef: async () => identity,
    variantResolutionTimeoutMs,
    now: () => FIXED_NOW,
  });
  const priced = () => upstreamCalls.filter((c) => c.op === 'preview_quote');
  const productReads = () => readCalls.filter((c) => c.op === 'get_product_detail');
  return { adapter, upstreamCalls, priced, logLines, readCalls, productReads };
}

// A product-detail read result carrying `variants` — the shape the canonical get_product read returns.
//
// It ECHOES the identity it was asked about (product_id, and merchant_id when the request scoped one), which
// is what a correct read does. This used to hardcode `product_id: 'p1'` regardless of what was requested —
// so tests asking about `sig_abc` were asserting against a read that answered about a DIFFERENT product, and
// the fixture's unrealism is precisely what hid the missing identity check. `productReadOf` builds an
// explicitly WRONG answer for the tests that need one.
const productWith = (...variants) => (payload) => ({
  product: {
    product_id: payload?.product?.product_id,
    ...(payload?.product?.merchant_id ? { merchant_id: payload.product.merchant_id } : {}),
    variants,
  },
});

function req({ body = {}, id, idem = 'idem-intake-1' } = {}) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(FIXED_NOW);
  const headers = { timestamp, signature: createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex') };
  if (idem) headers['idempotency-key'] = idem;
  return { headers, rawBody, body, params: id ? { checkout_session_id: id } : {} };
}

const ITEM = { product_id: 'p1', variant_id: 'v1', quantity: 1 };
const cart = (over = {}) => ({ merchant_id: 'merch_A', items: [ITEM], ...over });
const quoteOf = (priced) => priced.at(-1).payload.quote;

// ---- 1. buyer email: attested vs body vs absent -----------------------------------------------------------

test('email via TOKEN: an attested email is captured into the quote payload', async () => {
  const { adapter, priced } = setup({ identity: { user_ref: 'buyer_1', customer_email: 'attested@example.com', customer_name: 'Ada L' } });
  const r = await adapter.createCheckoutSession(req({ body: cart() }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(quoteOf(priced()).customer_email, 'attested@example.com');
  assert.equal(quoteOf(priced()).customer_name, 'Ada L');
});

test('PRECEDENCE: an ATTESTED email WINS over a conflicting body value (body never overrides)', async () => {
  const { adapter, priced } = setup({ identity: { user_ref: 'buyer_1', customer_email: 'attested@example.com' } });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ buyer: { email: 'attacker@evil.example', first_name: 'Not', last_name: 'Ada' }, customer_email: 'also-attacker@evil.example' }),
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const q = quoteOf(priced());
  assert.equal(q.customer_email, 'attested@example.com', 'the verified credential is authoritative');
  assert.ok(!JSON.stringify(q).includes('evil.example'), 'no caller-asserted address survives anywhere in the quote');
});

test('email via BODY only: used when the credential carries none (bare-string resolveUserRef back-compat)', async () => {
  const { adapter, priced } = setup({ identity: 'buyer_1' }); // historical string shape → no attested claims
  const r = await adapter.createCheckoutSession(req({ body: cart({ buyer: { email: 'body@example.com', first_name: 'Grace', last_name: 'Hopper' } }) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(quoteOf(priced()).customer_email, 'body@example.com');
  assert.equal(quoteOf(priced()).customer_name, 'Grace Hopper');
});

test('email via BODY only: the top-level `customer_email` spelling is also accepted', async () => {
  const { adapter, priced } = setup();
  const r = await adapter.createCheckoutSession(req({ body: cart({ customer_email: 'top@example.com' }) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(quoteOf(priced()).customer_email, 'top@example.com');
});

test('email ABSENT entirely: refused at CREATE, before pricing, with a named detail', async () => {
  const { adapter, priced } = setup();
  const r = await adapter.createCheckoutSession(req({ body: cart() }));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'QUOTE_REQUIRED');
  assert.equal(r.body.detail.reason, 'acp_buyer_email_required');
  assert.deepEqual(r.body.detail.accepted_body_fields, ['buyer.email', 'customer_email']);
  assert.equal(r.body.detail.attested_wins, true);
  assert.equal(priced().length, 0, 'a session that could never complete is never priced');
});

test('email MALFORMED in the body (and none attested): refused, and the bad value is NOT echoed', async () => {
  const { adapter, priced } = setup();
  const bad = 'not an <email> at all';
  const r = await adapter.createCheckoutSession(req({ body: cart({ buyer: { email: bad } }) }));
  assert.equal(r.status, 400);
  assert.equal(r.body.detail.reason, 'acp_buyer_email_required');
  assert.ok(!JSON.stringify(r.body).includes('not an'), 'the rejected value must not appear in the error body');
  assert.equal(priced().length, 0);
});

test('attested `email_verified:false` is NOT an attestation: the body may then supply the email', async () => {
  // The IdP is explicitly disclaiming the address, so it is treated as absent rather than trusted.
  const claims = { email: 'unconfirmed@example.com', email_verified: false };
  assert.deepEqual(attestedBuyerFromClaims(claims), {}, 'disclaimed email is not surfaced as attested');
  const { adapter, priced } = setup({ identity: { user_ref: 'buyer_1', ...attestedBuyerFromClaims(claims) } });
  const r = await adapter.createCheckoutSession(req({ body: cart({ buyer: { email: 'body@example.com' } }) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(quoteOf(priced()).customer_email, 'body@example.com');
});

test('attestedBuyerFromClaims: shape rules', () => {
  assert.deepEqual(attestedBuyerFromClaims({ email: ' a@b.co ' }), { attested_email: 'a@b.co' }, 'trimmed; absent email_verified is accepted');
  assert.deepEqual(attestedBuyerFromClaims({ email: 'a@b.co', email_verified: true, name: 'A B' }), { attested_email: 'a@b.co', attested_name: 'A B' });
  // Review F4: ANY falsy email_verified is the issuer disclaiming, not just a strict boolean false —
  // a non-conformant IdP emitting "false"/0 must not have its disclaimed address promoted to attested.
  for (const disclaimer of [false, 'false', 0, '', null]) {
    assert.deepEqual(
      attestedBuyerFromClaims({ email: 'a@b.co', email_verified: disclaimer }), {},
      `email_verified:${JSON.stringify(disclaimer)} must disclaim the address`,
    );
  }
  // ...but a MISSING claim is not a disclaimer (many IdPs omit it), and a truthy one attests.
  assert.deepEqual(attestedBuyerFromClaims({ email: 'a@b.co' }), { attested_email: 'a@b.co' });
  assert.deepEqual(attestedBuyerFromClaims({ email: 'a@b.co', email_verified: 'true' }), { attested_email: 'a@b.co' });
  assert.deepEqual(attestedBuyerFromClaims({ given_name: 'Ada', family_name: 'Lovelace' }), { attested_name: 'Ada Lovelace' });
  assert.deepEqual(attestedBuyerFromClaims({ email: 'garbage' }), {}, 'a malformed attested address is dropped, not trusted');
  assert.deepEqual(attestedBuyerFromClaims(null), {});
  assert.deepEqual(attestedBuyerFromClaims('nope'), {});
});

// ---- 2. fulfillment address -------------------------------------------------------------------------------

test('address ABSENT: allowed at create (ACP prices before the buyer picks a destination)', async () => {
  const { adapter, priced } = setup();
  const r = await adapter.createCheckoutSession(req({ body: cart({ customer_email: 'a@b.co' }) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(quoteOf(priced()).shipping_address, undefined);
});

test('address COMPLETE: mapped through, recipient_name preserved (not renamed)', async () => {
  const { adapter, priced } = setup();
  const r = await adapter.createCheckoutSession(req({ body: cart({ customer_email: 'a@b.co', fulfillment_address: ADDRESS }) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const addr = quoteOf(priced()).shipping_address;
  assert.equal(addr.recipient_name, 'Ada Lovelace', 'src/server.js buildInvokeBuyerContext maps recipient_name -> name');
  assert.equal(addr.address_line1, '1 Analytical Way');
  assert.equal(addr.country, 'GB');
});

test('address COMPLETE via the plain `name` spelling is no longer silently stripped', async () => {
  const { adapter, priced } = setup();
  const { recipient_name, ...rest } = ADDRESS;
  const r = await adapter.createCheckoutSession(req({ body: cart({ customer_email: 'a@b.co', fulfillment_address: { ...rest, name: recipient_name } }) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(quoteOf(priced()).shipping_address.name, 'Ada Lovelace');
});

test('address INCOMPLETE: refused before pricing, naming exactly the missing fields', async () => {
  const { adapter, priced } = setup();
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', fulfillment_address: { address_line1: '1 Analytical Way', country: 'GB' } }),
  }));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'QUOTE_REQUIRED');
  assert.equal(r.body.detail.reason, 'acp_fulfillment_address_incomplete');
  assert.deepEqual(r.body.detail.missing_fields, ['name', 'city', 'postal_code']);
  assert.deepEqual(r.body.detail.required_fields, ['name', 'address_line1', 'city', 'postal_code', 'country']);
  assert.equal(priced().length, 0, 'a partial destination must never price shipping/tax');
});

test('address supplied LATER via update: the update op genuinely re-maps it into a fresh snapshot', async () => {
  const { adapter, priced } = setup({ identity: { user_ref: 'buyer_1', customer_email: 'attested@example.com' } });
  const created = await adapter.createCheckoutSession(req({ body: cart(), idem: 'idem-upd-create' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(quoteOf(priced()).shipping_address, undefined);

  const updated = await adapter.updateCheckoutSession(req({
    id: created.body.id, idem: 'idem-upd-1', body: cart({ fulfillment_address: ADDRESS }),
  }));
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const q = quoteOf(priced());
  assert.equal(q.shipping_address.city, 'London');
  assert.equal(q.customer_email, 'attested@example.com', 'the re-minted snapshot still carries the attested buyer');
});

test('update is held to the SAME intake rules (its snapshot replaces, it does not merge)', async () => {
  const { adapter } = setup(); // no attested email
  const created = await adapter.createCheckoutSession(req({ body: cart({ customer_email: 'a@b.co' }), idem: 'idem-upd2-create' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const updated = await adapter.updateCheckoutSession(req({ id: created.body.id, idem: 'idem-upd2-1', body: cart() }));
  assert.equal(updated.status, 400);
  assert.equal(updated.body.detail.reason, 'acp_buyer_email_required');
});

// ---- 3. item identity: RESOLVE the default variant, never forge one ----------------------------------------
//
// PR-E refused any item with no `variant_id`. That refusal was unsatisfiable from Pivota's OWN ACP feed,
// which publishes no variant identity at all — so the door now RESOLVES the default variant through the same
// canonical `get_product` read the executor already exposes, and refuses only when resolution is ambiguous or
// impossible. The invariant that survives untouched: an id is NEVER synthesised from a product id.

test('item with a REAL variant_id is accepted, reaches pricing verbatim, and triggers NO resolution read', async () => {
  const { adapter, priced, productReads } = setup({ productRead: productWith({ variant_id: 'SHOULD_NOT_BE_USED' }) });
  const r = await adapter.createCheckoutSession(req({ body: cart({ customer_email: 'a@b.co' }) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(quoteOf(priced()).items[0], { product_id: 'p1', variant_id: 'v1', quantity: 1 });
  assert.equal(productReads().length, 0, 'a fully-specified item is never looked up');
});

test('product_id ONLY + exactly ONE variant: resolved, and the RESOLVED id is what reaches the quote payload', async () => {
  const { adapter, priced, productReads } = setup({ productRead: productWith({ variant_id: 'v_resolved', title: 'Default' }) });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 2 }] }),
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(quoteOf(priced()).items[0], { product_id: 'p1', variant_id: 'v_resolved', quantity: 2 });
  // resolved through the canonical get_product read (kernel op get_product_detail), merchant-scoped from the body
  assert.equal(productReads().length, 1);
  assert.deepEqual(productReads()[0].payload.product, { product_id: 'p1', merchant_id: 'merch_A' });
});

test('the resolved id is NEVER derived from the product id (the forging bug this path exists to remove)', async () => {
  const { adapter, priced } = setup({ productRead: productWith({ variant_id: 'v_real' }) });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 1 }] }),
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.notEqual(quoteOf(priced()).items[0].variant_id, 'p1', 'variant_id must never be the product_id');
});

test('a SYNTHETIC canonical variant id resolves like any other (no shape special-casing at a protocol door)', async () => {
  // Live feed products resolve to BOTH real storefront ids (`48930014462260`) and canonical placeholders
  // (`merit:c7e0303d89a516b5::canonical`). Telling them apart is index-lane knowledge; this door must not.
  for (const id of ['merit:c7e0303d89a516b5::canonical', '48930014462260']) {
    const { adapter, priced } = setup({ productRead: productWith({ variant_id: id }) });
    const r = await adapter.createCheckoutSession(req({
      body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'sig_x', quantity: 1 }] }),
    }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(quoteOf(priced()).items[0].variant_id, id);
  }
});

test('a NUMERIC upstream variant id is accepted (stringified) — the read`s own id, not a derived one', async () => {
  const { adapter, priced } = setup({ productRead: productWith({ id: 48930014462260 }) });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'sig_x', quantity: 1 }] }),
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(quoteOf(priced()).items[0].variant_id, '48930014462260');
});

test('product_id ONLY + MULTIPLE variants: refused as AMBIGUOUS, with the count, before pricing', async () => {
  const { adapter, priced } = setup({
    productRead: productWith({ variant_id: 'v1' }, { variant_id: 'v2' }, { variant_id: 'v3' }),
  });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 1 }] }),
  }));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'QUOTE_REQUIRED');
  assert.equal(r.body.detail.reason, 'acp_item_identity_required');
  assert.equal(r.body.detail.variant_resolution, 'ambiguous');
  assert.equal(r.body.detail.variant_count, 3, 'the count is what makes this actionable');
  assert.match(r.body.message, /3 variants/);
  assert.equal(priced().length, 0, 'the door never guesses which option the buyer meant');
});

test('product_id ONLY + ZERO variants: refused, count 0, distinguishable from the ambiguous case', async () => {
  const { adapter, priced } = setup({ productRead: productWith() });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 1 }] }),
  }));
  assert.equal(r.status, 400);
  assert.equal(r.body.detail.reason, 'acp_item_identity_required');
  assert.equal(r.body.detail.variant_resolution, 'no_variants');
  assert.equal(r.body.detail.variant_count, 0);
  assert.equal(priced().length, 0);
});

test('resolution THROWS: refused (fail-closed), never forged, nothing priced', async () => {
  const { adapter, priced, upstreamCalls } = setup({
    productRead: () => { throw new Error('upstream exploded: product p1 at merchant merch_A'); },
  });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 1 }] }),
  }));
  assert.equal(r.status, 400);
  assert.equal(r.body.detail.reason, 'acp_item_identity_required');
  assert.equal(r.body.detail.variant_resolution, 'resolution_unavailable');
  assert.equal(priced().length, 0, 'a failed resolution must not fall through to pricing');
  assert.equal(upstreamCalls.filter((c) => c.op === 'preview_quote').length, 0);
  assert.ok(!JSON.stringify(r.body).includes('exploded'), 'the internal cause is never surfaced');
});

test('resolution TIMES OUT: refused on expiry — a hanging read cannot stall session creation', async () => {
  const { adapter, priced } = setup({
    productRead: () => new Promise(() => {}), // never settles
    variantResolutionTimeoutMs: 25,
  });
  const started = Date.now();
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 1 }] }),
  }));
  assert.ok(Date.now() - started < 2000, 'the door answered on its own deadline, not the read`s');
  assert.equal(r.status, 400);
  assert.equal(r.body.detail.variant_resolution, 'resolution_unavailable');
  assert.equal(priced().length, 0);
});

test('the SAME product twice in one cart costs ONE read, and both items get the resolved id', async () => {
  const { adapter, priced, productReads } = setup({ productRead: productWith({ variant_id: 'v_shared' }) });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 1 }, { product_id: 'p1', quantity: 4 }] }),
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(productReads().length, 1, 'one read per DISTINCT product_id');
  assert.deepEqual(quoteOf(priced()).items.map((i) => i.variant_id), ['v_shared', 'v_shared']);
});

test('ONE ambiguous item refuses the WHOLE request (a partially-resolved cart is never priced)', async () => {
  const { adapter, priced } = setup({
    productRead: (payload) => (payload.product.product_id === 'p_ok'
      ? productWith({ variant_id: 'v_ok' })(payload)
      : productWith({ variant_id: 'a' }, { variant_id: 'b' })(payload)),
  });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p_ok', quantity: 1 }, { product_id: 'p_multi', quantity: 1 }] }),
  }));
  assert.equal(r.status, 400);
  assert.equal(r.body.detail.variant_resolution, 'ambiguous');
  assert.equal(priced().length, 0);
});

test('resolution runs on UPDATE too (the update op re-mints the snapshot, so it re-resolves)', async () => {
  const { adapter, priced } = setup({
    identity: { user_ref: 'buyer_1', customer_email: 'attested@example.com' },
    productRead: productWith({ variant_id: 'v_upd' }),
  });
  const created = await adapter.createCheckoutSession(req({ body: cart(), idem: 'idem-res-create' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const updated = await adapter.updateCheckoutSession(req({
    id: created.body.id, idem: 'idem-res-upd', body: cart({ items: [{ product_id: 'p1', quantity: 1 }] }),
  }));
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(quoteOf(priced()).items[0].variant_id, 'v_upd');
});

test('an UNSCOPED cart (no merchant_id) resolves too — the ACP feed publishes sig_* ids with no merchant', async () => {
  const { adapter, priced, productReads } = setup({ productRead: productWith({ variant_id: 'v_sig' }) });
  const r = await adapter.createCheckoutSession(req({
    body: { customer_email: 'a@b.co', items: [{ product_id: 'sig_abc', quantity: 1 }] },
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(productReads()[0].payload.product, { product_id: 'sig_abc' }, 'no merchant_id is invented');
  assert.equal(quoteOf(priced()).items[0].variant_id, 'v_sig');
});

test('a CHEAP refusal (missing buyer email) is answered without spending an upstream read', async () => {
  const { adapter, productReads } = setup({ productRead: productWith({ variant_id: 'v1' }) });
  const r = await adapter.createCheckoutSession(req({ body: cart({ items: [{ product_id: 'p1', quantity: 1 }] }) }));
  assert.equal(r.status, 400);
  assert.equal(r.body.detail.reason, 'acp_buyer_email_required');
  assert.equal(productReads().length, 0, 'resolution runs last, after every free refusal');
});

// --- PR-E refusals that SURVIVE the change (same code, same reason, same required_item_fields) ---

test('item with product_id ONLY and NOTHING resolvable is still refused', async () => {
  const { adapter, priced } = setup(); // default read answers {} → no variants
  const r = await adapter.createCheckoutSession(req({ body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 1 }] }) }));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'QUOTE_REQUIRED');
  assert.equal(r.body.detail.reason, 'acp_item_identity_required');
  assert.deepEqual(r.body.detail.required_item_fields, ['product_id', 'variant_id']);
  assert.equal(priced().length, 0);
});

test('item with sku_id ONLY is refused OUTRIGHT (sku_id is not resolvable; it would price an EMPTY cart)', async () => {
  const { adapter, priced, productReads } = setup({ productRead: productWith({ variant_id: 'v1' }) });
  const r = await adapter.createCheckoutSession(req({ body: cart({ customer_email: 'a@b.co', items: [{ sku_id: 'sku_1', quantity: 1 }] }) }));
  assert.equal(r.status, 400);
  assert.equal(r.body.detail.reason, 'acp_item_identity_required');
  assert.equal(r.body.detail.variant_resolution, 'product_id_required');
  assert.equal(productReads().length, 0, 'there is no product to resolve against');
  assert.equal(priced().length, 0);
});

test('item with product_id + sku_id but no variant_id resolves via the product_id (sku_id is not the key)', async () => {
  const { adapter, priced } = setup({ productRead: productWith({ variant_id: 'v_from_product' }) });
  const r = await adapter.createCheckoutSession(req({ body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', sku_id: 'sku_1', quantity: 1 }] }) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(quoteOf(priced()).items[0].variant_id, 'v_from_product');
});

test('item with product_id + sku_id and NOTHING resolvable is still refused', async () => {
  const { adapter } = setup();
  const r = await adapter.createCheckoutSession(req({ body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', sku_id: 'sku_1', quantity: 1 }] }) }));
  assert.equal(r.status, 400);
  assert.equal(r.body.detail.reason, 'acp_item_identity_required');
});

// ---- 3a. THE P0: a resolved id that is the requested product_id RESTATED must be REFUSED --------------------
//
// The commit that introduced default-variant resolution claimed "the only value ever written into
// `variant_id` is one the product read returned". True but insufficient: on the UNSCOPED lane the read is
// answered by this gateway's OWN get_pdp_v2, whose variants come from src/pdpBuilder.js `buildVariants`,
// which MANUFACTURES `variant_id: product.product_id` (product with no variants) and
// `` `${product.product_id}-${idx+1}` `` (variant with no id). Both "came back from the read" and both are
// byte-identical to the `variant_id || sku || product_id` forgery this door exists to eliminate.
//
// Section 3b below drives the REAL pdpBuilder to prove those two strings are what that lane actually emits;
// these tests pin the door's response to them.

const idsFrom = (r) => quoteOf(r).items[0].variant_id;

test('P0: a resolved variant_id EQUAL to the requested product_id is REFUSED, not priced', async () => {
  const { adapter, priced } = setup({ productRead: productWith({ variant_id: 'sig_9f2c1a' }) });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'sig_9f2c1a', quantity: 1 }] }),
  }));
  assert.equal(r.status, 400, `a product-id restatement must never price: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'QUOTE_REQUIRED');
  assert.equal(r.body.detail.reason, 'acp_item_identity_required');
  assert.equal(r.body.detail.variant_resolution, 'no_real_variant_identity');
  assert.equal(r.body.detail.variant_count, 1, 'the catalog DID publish a variant — it just has no identity');
  assert.equal(priced().length, 0);
});

test('P0: a resolved variant_id of `${product_id}-1` (pdpBuilder`s id-less-variant shape) is REFUSED', async () => {
  const { adapter, priced } = setup({ productRead: productWith({ variant_id: 'sig_9f2c1a-1' }) });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'sig_9f2c1a', quantity: 1 }] }),
  }));
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.detail.variant_resolution, 'no_real_variant_identity');
  assert.equal(priced().length, 0);
});

test('P0: `no_real_variant_identity` is DISTINCT from `no_variants` (ops can tell the two apart)', async () => {
  const { adapter } = setup({ productRead: productWith() }); // genuinely zero variants
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'sig_9f2c1a', quantity: 1 }] }),
  }));
  assert.equal(r.body.detail.variant_resolution, 'no_variants', 'a product with NO variants is a different fact');
  assert.equal(r.body.detail.variant_count, 0);
});

test('NOT over-refused: a real id that merely CONTAINS the product id is ACCEPTED', async () => {
  // `v_p1_red` contains `p1` but does not START with it — it is a genuine, distinct catalog identity.
  const { adapter, priced } = setup({ productRead: productWith({ variant_id: 'v_p1_red' }) });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 1 }] }),
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(idsFrom(priced()), 'v_p1_red');
});

test('NOT over-refused: a real id that STARTS with the product id but continues alphanumerically is ACCEPTED', async () => {
  // `sig_9f2c` is a prefix of `sig_9f2c1a` only by hash-prefix accident; the next character is alphanumeric,
  // so the id is a different id and not the product id plus a suffix. Refusing this WOULD be over-refusal.
  const { adapter, priced } = setup({ productRead: productWith({ variant_id: 'sig_9f2c1a' }) });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'sig_9f2c', quantity: 1 }] }),
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(idsFrom(priced()), 'sig_9f2c1a');
});

test('a `${product_id}::canonical` id is a restatement too (separator, not a distinct identity)', async () => {
  const { adapter, priced } = setup({ productRead: productWith({ variant_id: 'merit:c7e0303d::canonical' }) });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'merit:c7e0303d', quantity: 1 }] }),
  }));
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.detail.variant_resolution, 'no_real_variant_identity');
  assert.equal(priced().length, 0);
  // ...but the SAME canonical id resolved from a `sig_*` product (the live shape) is still accepted —
  // see the pre-existing "SYNTHETIC canonical variant id" test above. The filter is about the RELATIONSHIP
  // between the two ids, never about how either one looks.
});

test('filtering happens BEFORE the unique/ambiguous decision: a forged id alongside a real one leaves ONE', async () => {
  const { adapter, priced } = setup({
    productRead: productWith({ variant_id: 'p1' }, { variant_id: 'v_real' }),
  });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 1 }] }),
  }));
  assert.equal(r.status, 201, `the one REAL identity resolves: ${JSON.stringify(r.body)}`);
  assert.equal(idsFrom(priced()), 'v_real', 'the forged sibling is dropped, never chosen');
});

test('two REAL ids are still `ambiguous`, and the count is of the REAL ones only', async () => {
  const { adapter, priced } = setup({
    productRead: productWith({ variant_id: 'p1' }, { variant_id: 'v_a' }, { variant_id: 'v_b' }),
  });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 1 }] }),
  }));
  assert.equal(r.status, 400);
  assert.equal(r.body.detail.variant_resolution, 'ambiguous');
  assert.equal(r.body.detail.variant_count, 2, 'the forged candidate is not offered as a choice');
  assert.equal(priced().length, 0);
});

// ---- 3b. THE REAL CHAIN: executor read -> get_product_detail -> pdpBuilder`s FABRICATION -------------------
//
// This is the gap that let the P0 ship: every safety-kernel case stubbed the executor, and the one e2e case
// sent `merchant_id: 'm1'` — the merchant-SCOPED lane, which goes to the Python backend and never reaches
// pdpBuilder at all. Nothing exercised the UNSCOPED (`sig_*` feed) lane the feature was built for.
//
// WHAT IS STUBBED, AND WHY IT STILL PROVES THE PROPERTY:
// the door -> executor.execute('get_product') -> canonicalExecutor read('get_product_detail') hop is REAL.
// Below that, src/server.js `invokeCommerceKernelRawUpstream` would (a) HTTP-loopback to this gateway's own
// `get_pdp_v2` and (b) unwrap `modules[canonical].data.pdp_payload.product` via
// `normalizePdpV2ToProductDetail`. The test replaces exactly those two steps — one network hop and one field
// projection, neither of which invents a variant — and calls the REAL `buildPdpPayload` from
// src/pdpBuilder.js in between. So `buildVariants`, the actual source of the forged ids, runs for real: the
// variant ids these tests feed the door are the ones production would feed it.
const pdpRequire = createRequire(import.meta.url);
const { buildPdpPayload } = pdpRequire('../../src/pdpBuilder.js');

// The unscoped lane as src/server.js assembles it, minus the loopback HTTP hop.
const unscopedPdpRead = (upstreamProduct) => (payload) => {
  const pid = payload?.product?.product_id;
  const pdpPayload = buildPdpPayload({ product: { ...upstreamProduct, product_id: pid } });
  return { product: pdpPayload.product }; // == normalizePdpV2ToProductDetail's projection
};

test('REAL CHAIN: pdpBuilder really does fabricate variant_id === product_id for a variant-less product', () => {
  // A positive control. If this ever stops holding, the door tests below stop meaning anything.
  const p = buildPdpPayload({ product: { product_id: 'sig_9f2c1a', title: 'Serum', price: 42, in_stock: true } });
  assert.deepEqual(p.product.variants.map((v) => v.variant_id), ['sig_9f2c1a'],
    'src/pdpBuilder.js buildVariants synthesises the product id as the variant id');
  const q = buildPdpPayload({ product: { product_id: 'sig_9f2c1a', title: 'Serum', price: 42, in_stock: true, variants: [{ title: 'Full size' }] } });
  assert.deepEqual(q.product.variants.map((v) => v.variant_id), ['sig_9f2c1a-1'],
    'and `${product_id}-${idx+1}` for a variant with no id of its own');
});

test('REAL CHAIN P0: an UNSCOPED sig_* cart over the real pdpBuilder is REFUSED, not priced 201', async () => {
  const { adapter, priced, productReads } = setup({
    productRead: unscopedPdpRead({ title: 'Niacinamide Serum', price: 42, currency: 'USD', in_stock: true }),
  });
  const r = await adapter.createCheckoutSession(req({
    body: { customer_email: 'a@b.co', items: [{ product_id: 'sig_9f2c1a', quantity: 1 }] },
  }));
  assert.equal(productReads().length, 1, 'the read really happened, unscoped');
  assert.deepEqual(productReads()[0].payload.product, { product_id: 'sig_9f2c1a' }, 'no merchant_id invented');
  assert.equal(r.status, 400, `the door must refuse the fabricated identity, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.detail.variant_resolution, 'no_real_variant_identity');
  assert.equal(priced().length, 0, 'and price nothing');
});

test('REAL CHAIN P0: the `sig_9f2c1a-1` shape from an id-less upstream variant is REFUSED too', async () => {
  const { adapter, priced } = setup({
    productRead: unscopedPdpRead({ title: 'Serum', price: 42, in_stock: true, variants: [{ title: 'Full size' }] }),
  });
  const r = await adapter.createCheckoutSession(req({
    body: { customer_email: 'a@b.co', items: [{ product_id: 'sig_9f2c1a', quantity: 1 }] },
  }));
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.detail.variant_resolution, 'no_real_variant_identity');
  assert.equal(priced().length, 0);
});

test('REAL CHAIN: a product whose upstream variants carry REAL ids still resolves through the same lane', async () => {
  // The filter must not have broken the case the feature exists for.
  const { adapter, priced } = setup({
    productRead: unscopedPdpRead({
      title: 'Serum', price: 42, in_stock: true,
      variants: [{ variant_id: '48930014462260', title: '30ml' }],
    }),
  });
  const r = await adapter.createCheckoutSession(req({
    body: { customer_email: 'a@b.co', items: [{ product_id: 'sig_9f2c1a', quantity: 1 }] },
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(idsFrom(priced()), '48930014462260', 'a real storefront id from the real builder resolves');
});

// ---- 3c. IDENTITY: the read must have answered about the product that was ASKED for ------------------------

// A read that answers about some OTHER product entirely.
const wrongProductRead = (over) => () => ({
  product: { product_id: 'SOME_OTHER_PRODUCT', merchant_id: 'other_merchant', variants: [{ variant_id: 'v_of_other' }], ...over },
});

test('IDENTITY: a read answering about a DIFFERENT product_id is refused, and its variants are NOT used', async () => {
  const { adapter, priced } = setup({ productRead: wrongProductRead() });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 1 }] }),
  }));
  assert.equal(r.status, 400, `got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'QUOTE_REQUIRED');
  assert.equal(r.body.detail.reason, 'acp_item_identity_required');
  assert.equal(r.body.detail.variant_resolution, 'identity_mismatch');
  assert.equal(priced().length, 0, 'another product`s variant must never reach pricing');
  assert.ok(!JSON.stringify(r.body).includes('v_of_other'), 'the refusal names fields, never values');
  assert.ok(!JSON.stringify(r.body).includes('SOME_OTHER_PRODUCT'));
});

test('IDENTITY: a read answering for a DIFFERENT merchant_id than the one requested is refused', async () => {
  // merchant_id is a caller-controlled body field selecting between two lanes with different resolution
  // semantics, so a response that silently re-homes the product must not be believed.
  const { adapter, priced } = setup({
    productRead: () => ({ product: { product_id: 'p1', merchant_id: 'other_merchant', variants: [{ variant_id: 'v_elsewhere' }] } }),
  });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 1 }] }), // cart() scopes merch_A
  }));
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.detail.variant_resolution, 'identity_mismatch');
  assert.equal(priced().length, 0);
});

test('IDENTITY: a scoped read that simply OMITS merchant_id is still accepted (not every lane echoes it)', async () => {
  const { adapter, priced } = setup({
    productRead: () => ({ product: { product_id: 'p1', variants: [{ variant_id: 'v_ok' }] } }),
  });
  const r = await adapter.createCheckoutSession(req({
    body: cart({ customer_email: 'a@b.co', items: [{ product_id: 'p1', quantity: 1 }] }),
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(idsFrom(priced()), 'v_ok');
});

test('IDENTITY: the UNSCOPED lane legitimately answers with no merchant — still accepted', async () => {
  const { adapter, priced } = setup({ productRead: productWith({ variant_id: 'v_sig' }) });
  const r = await adapter.createCheckoutSession(req({
    body: { customer_email: 'a@b.co', items: [{ product_id: 'sig_abc', quantity: 1 }] },
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(idsFrom(priced()), 'v_sig');
});

// ---- 3d. LOAD: caps, a bounded limiter, and a deadline that stops launching work --------------------------
//
// Before this, mapItemsToQuote checked only `items.length !== 0`: one signed create naming 2000 distinct
// products issued 2000 CONCURRENT reads and answered 201. And the reads run BEFORE the create-claim, so a
// replayed create repeats them — the caps are what bounds that.

const bigCart = (n, { distinct = true } = {}) => ({
  customer_email: 'a@b.co',
  items: Array.from({ length: n }, (_, i) => ({ product_id: distinct ? `p_${i}` : 'p_same', quantity: 1 })),
});

test('LOAD: a cart over the ITEM cap is refused before any read', async () => {
  const { adapter, priced, productReads } = setup({ productRead: productWith({ variant_id: 'v' }) });
  const r = await adapter.createCheckoutSession(req({ body: bigCart(51, { distinct: false }) }));
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'QUOTE_REQUIRED');
  assert.equal(r.body.detail.reason, 'acp_cart_too_many_items');
  assert.equal(r.body.detail.max_items, 50);
  assert.equal(r.body.detail.item_count, 51);
  assert.equal(productReads().length, 0, 'an over-cap cart costs ZERO upstream reads');
  assert.equal(priced().length, 0);
});

test('LOAD: a cart over the DISTINCT-PRODUCT cap is refused before any read, under the item cap', async () => {
  const { adapter, priced, productReads } = setup({ productRead: productWith({ variant_id: 'v' }) });
  const r = await adapter.createCheckoutSession(req({ body: bigCart(26) })); // 26 items, 26 distinct
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.detail.reason, 'acp_cart_too_many_products');
  assert.equal(r.body.detail.max_distinct_products, 25);
  assert.equal(r.body.detail.distinct_product_count, 26);
  assert.equal(productReads().length, 0, 'the read count is capped BEFORE the reads are issued');
  assert.equal(priced().length, 0);
});

test('LOAD: a 50-line cart of ONE product is still legal — it is 1 read, not 50', async () => {
  const { adapter, productReads } = setup({ productRead: productWith({ variant_id: 'v_shared' }) });
  const r = await adapter.createCheckoutSession(req({ body: bigCart(50, { distinct: false }) }));
  assert.equal(r.status, 201, `the caps must not punish quantity: ${JSON.stringify(r.body)}`);
  assert.equal(productReads().length, 1);
});

test('LOAD: read concurrency never exceeds the limiter', async () => {
  let inFlight = 0;
  let peak = 0;
  const { adapter, productReads } = setup({
    productRead: async (payload) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return productWith({ variant_id: `v_${payload.product.product_id}` })(payload);
    },
  });
  const r = await adapter.createCheckoutSession(req({ body: bigCart(25), idem: 'idem-conc' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(productReads().length, 25, 'all 25 distinct products were read');
  assert.ok(peak <= 6, `concurrency must stay within the limiter, peaked at ${peak}`);
  assert.ok(peak > 1, `...but still be parallel, peaked at ${peak}`);
});

test('LOAD: the deadline STOPS LAUNCHING reads — an abandoned batch does not keep issuing them', async () => {
  let started = 0;
  const { adapter } = setup({
    productRead: () => { started += 1; return new Promise(() => {}); }, // never settles
    variantResolutionTimeoutMs: 25,
  });
  const r = await adapter.createCheckoutSession(req({ body: bigCart(25), idem: 'idem-deadline' }));
  assert.equal(r.status, 400);
  assert.equal(r.body.detail.variant_resolution, 'resolution_unavailable');
  const atRefusal = started;
  assert.ok(atRefusal <= 6, `at most the limiter width may be in flight, ${atRefusal} were started`);
  // Before the limiter, all 25 launched at once and kept running well past the refusal.
  await new Promise((r2) => setTimeout(r2, 60));
  assert.equal(started, atRefusal, 'no further read is launched after the deadline aborted the batch');
});

test('LOAD: product_id is TRIMMED, so " p1 " / "p1" / "p1  " are ONE product and ONE read', async () => {
  const { adapter, priced, productReads } = setup({ productRead: productWith({ variant_id: 'v_trim' }) });
  const r = await adapter.createCheckoutSession(req({
    body: {
      customer_email: 'a@b.co',
      items: [{ product_id: 'p1', quantity: 1 }, { product_id: ' p1 ', quantity: 1 }, { product_id: 'p1  ', quantity: 1 }],
    },
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(productReads().length, 1, 'untrimmed spellings were three distinct read keys before this');
  assert.deepEqual(productReads()[0].payload.product, { product_id: 'p1' });
  assert.deepEqual(quoteOf(priced()).items.map((i) => i.product_id), ['p1', 'p1', 'p1'],
    'and the NORMALIZED value is what reaches pricing');
});

// ---- 4. PII hygiene ---------------------------------------------------------------------------------------

test('PII: the captured email reaches the QUOTE PAYLOAD and nothing else — no response body, no log line', async () => {
  const EMAIL = 'pii-canary@example.com';
  const { adapter, upstreamCalls, logLines } = setup({ identity: { user_ref: 'buyer_1', customer_email: EMAIL } });

  const created = await adapter.createCheckoutSession(req({ body: cart({ fulfillment_address: ADDRESS }), idem: 'idem-pii-1' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const got = await adapter.getCheckoutSession(req({ id: created.body.id, idem: null }));
  const done = await adapter.completeCheckoutSession(req({ id: created.body.id, body: { payment_data: { token: 'tok' } }, idem: 'idem-pii-2' }));
  assert.equal(done.status, 200, JSON.stringify(done.body));

  // positive control: it DID flow to where the order lane needs it (otherwise this test proves nothing)
  assert.equal(upstreamCalls.find((c) => c.op === 'preview_quote').payload.quote.customer_email, EMAIL);
  assert.equal(upstreamCalls.find((c) => c.op === 'create_order').payload.order.customer_email, EMAIL);

  for (const [label, body] of [['create', created.body], ['get', got.body], ['complete', done.body]]) {
    assert.ok(!JSON.stringify(body).includes(EMAIL), `${label} response must not echo the buyer email`);
  }
  assert.ok(!JSON.stringify(logLines).includes(EMAIL), 'no log line may contain the buyer email');
});

test('PII: an error body raised AFTER the email was captured still carries no PII', async () => {
  const EMAIL = 'pii-canary2@example.com';
  const { adapter } = setup({ identity: { user_ref: 'buyer_1', customer_email: EMAIL } });
  // a second buyer probing the session id gets a linkage refusal — the refusal must say nothing about buyer 1
  const created = await adapter.createCheckoutSession(req({ body: cart(), idem: 'idem-pii-3' }));
  const { adapter: other } = setup({ identity: { user_ref: 'buyer_2', customer_email: 'other@example.com' } });
  const denied = await other.getCheckoutSession(req({ id: created.body.id, idem: null }));
  assert.equal(denied.status, 404); // unknown to buyer 2's store
  assert.ok(!JSON.stringify(denied.body).includes(EMAIL));

  const badItems = await adapter.createCheckoutSession(req({ body: cart({ items: [{ product_id: 'p1', quantity: 1 }] }), idem: 'idem-pii-4' }));
  assert.equal(badItems.status, 400);
  assert.ok(!JSON.stringify(badItems.body).includes(EMAIL), 'an intake refusal never echoes the attested buyer');
});

test('PII: redact() masks a buyer email anywhere in a logged payload', () => {
  const out = redact({ order: { customer_email: 'a@b.co', email: 'c@d.co', quote_id: 'q1' } });
  assert.equal(out.order.customer_email, '[REDACTED]');
  assert.equal(out.order.email, '[REDACTED]');
  assert.equal(out.order.quote_id, 'q1', 'non-PII fields still survive for diagnosis');
});
