// The UCP↔canonical ARGUMENT adapter, exercised end to end.
//
// WHY THIS FILE EXISTS, AND WHAT IT IS BUILT TO KILL. #1962 shipped the UCP dialect's tool NAMES with zero
// execution coverage: a review mutant that deleted `{ dialect: 'ucp' }` — making every UCP call throw
// UNKNOWN_TOOL in production — survived all 213 tests. ucpDialectSurface.test.js closed that hole for routing.
// This file closes it for ARGUMENTS, on a money path, so each test below is written to fail against a specific
// wrong implementation rather than to describe the right one:
//
//   - reading the line-item id from anywhere but `item.id`      -> "maps a real UCP create_checkout body"
//   - defaulting or transposing `quantity`                      -> same test (distinct quantities per line)
//   - reading update's checkout id from inside `checkout`       -> "the checkout id is TOP-LEVEL"
//   - promoting `context` hints into a shipping address         -> "context hints are not an address"
//   - letting a body-supplied buyer beat the verified session   -> "an attested email wins"
//   - forwarding a `payment` field on create/update             -> "payment is refused on the quote lane"
//   - drifting the published schema away from the mapper        -> "schema and mapper cannot drift"
//
// Every assertion inspects what the EXECUTOR actually received, because that is the boundary the kernel and
// the charge live behind. Nothing here asserts on the adapter's return value alone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCommerceToolSurface,
  ucpDialectSurface,
  ucpCommerceToolDefinitions,
} from '../src/commerceToolSurface.js';
import {
  UCP_INPUT_SCHEMAS,
  UCP_ACCEPTED_BUT_UNMAPPED,
  ucpToNativeToolArgs,
} from '../src/ucpArgumentAdapter.js';
import { canonicalOpForUcpTool } from '../../safety-kernel/src/protocol/canonicalContract.js';

// ---- harness ---------------------------------------------------------------------------------------------

/**
 * An executor that records every canonical call and answers `get_product` with ONE real variant per product,
 * so default-variant resolution succeeds and the mapped cart reaches the checkout op intact. The answer is
 * built from the REQUESTED product id because buyerIntake's assertProductIdentity refuses a read that answered
 * about a different product.
 */
function recordingExecutor() {
  const seen = [];
  return {
    seen,
    calls(op) {
      return seen.filter((c) => c.op === op);
    },
    /** The single checkout call, asserting there was exactly one — a silent double-call is itself a defect. */
    only(op) {
      const matching = seen.filter((c) => c.op === op);
      assert.equal(matching.length, 1, `expected exactly one ${op} call, saw ${matching.length}`);
      return matching[0];
    },
    async execute(op, params, ctx) {
      seen.push({ op, params, ctx });
      if (op === 'get_product') {
        const product_id = params?.payload?.product?.product_id;
        return { product: { product_id, variants: [{ variant_id: `v_${product_id}` }] } };
      }
      return { session_id: 'q_1' };
    },
  };
}

function ucpSurface() {
  const executor = recordingExecutor();
  const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
  return { executor, ucp };
}

const AGENT_META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' } };
const IDEMPOTENT_META = { ...AGENT_META, 'idempotency-key': 'idem-key-0001' };

// A verified session with NO attested buyer email: the body may then legitimately fill the gap.
const SESSION = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };
// A verified session whose credential ATTESTS an email. Nothing in a request body may override it.
const SESSION_ATTESTED = {
  ...SESSION,
  claims: { iss: 'https://idp.example', sub: 'u1', email: 'attested@example.test', email_verified: true },
};

/** A complete, spec-shaped create_checkout body. Values are distinct so a transposition cannot pass. */
function createBody(overrides = {}) {
  return {
    meta: IDEMPOTENT_META,
    checkout: {
      line_items: [
        { item: { id: 'p_alpha' }, quantity: 3 },
        { item: { id: 'p_beta' }, quantity: 1 },
      ],
      buyer: { email: 'shopper@example.test' },
      ...overrides,
    },
  };
}

const rejected = (promise) => promise.then(() => null, (e) => e);

// ---- 1. the cart --------------------------------------------------------------------------------------------

describe('UCP create_checkout maps onto the canonical quote', () => {
  test('a real UCP body prices the cart it names: item.id -> product_id, quantity preserved per line', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('create_checkout', createBody(), SESSION);

    const call = executor.only('create_checkout_session');
    assert.equal(call.params.idempotency_key, 'idem-key-0001', 'meta["idempotency-key"] is the canonical key');
    // The whole cart, exactly: ids come from `item.id` (NOT from the line, NOT from a flat variant field) and
    // each line keeps ITS OWN quantity. The two lines carry different quantities on purpose — a mapper that
    // defaults quantity, or reads it from the wrong line, produces a different array here.
    assert.deepEqual(call.params.quote.items, [
      { product_id: 'p_alpha', quantity: 3, variant_id: 'v_p_alpha' },
      { product_id: 'p_beta', quantity: 1, variant_id: 'v_p_beta' },
    ]);
  });

  test('the variant is RESOLVED through the shared canonical read, never derived from the product id', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('create_checkout', createBody(), SESSION);

    // One read per distinct product, through the same `get_product` op every other door resolves through.
    assert.deepEqual(
      executor.calls('get_product').map((c) => c.params.payload.product.product_id).sort(),
      ['p_alpha', 'p_beta'],
    );
    // And the resolved id is the catalog's, not a restatement of the product id.
    for (const item of executor.only('create_checkout_session').params.quote.items) {
      assert.notEqual(item.variant_id, item.product_id, 'a variant id must never be the product id restated');
    }
  });

  test('a line item without `item.id` is refused BEFORE anything is priced, naming the UCP field', async () => {
    const { executor, ucp } = ucpSurface();
    const err = await rejected(ucp.callTool('create_checkout', {
      meta: IDEMPOTENT_META,
      checkout: { line_items: [{ quantity: 1 }] },
    }, SESSION));

    assert.ok(err, 'a line with no item.id must be refused');
    assert.equal(executor.seen.length, 0, 'a refused cart must cost no upstream read and no pricing call');
    // The message must name the field the caller can actually send. `product_id`/`sku_id` — what the shared
    // cart rule would have said — do not exist in the UCP line-item shape, so a model following that advice
    // would retry the identical body and be refused identically.
    const message = String(err.detail?.acp_message ?? err.message);
    assert.match(message, /item\.id/);
    assert.equal(message.includes('sku_id'), false);
  });

  test('a FLAT variant_id/product_id on the line is refused, not silently read as the item identity', async () => {
    const { executor, ucp } = ucpSurface();
    const err = await rejected(ucp.callTool('create_checkout', {
      meta: IDEMPOTENT_META,
      // The native spelling. It is not the UCP shape; accepting it here would make the door's real contract
      // differ from the one it publishes.
      checkout: { line_items: [{ variant_id: 'v_1', product_id: 'p_alpha', quantity: 1 }] },
    }, SESSION));

    assert.ok(err);
    assert.equal(executor.seen.length, 0);
    assert.equal(JSON.stringify(executor.seen).includes('p_alpha'), false);
  });

  test('a line with NO quantity is refused, never defaulted to 1', async () => {
    const { executor, ucp } = ucpSurface();
    const err = await rejected(ucp.callTool('create_checkout', {
      meta: IDEMPOTENT_META,
      checkout: { line_items: [{ item: { id: 'p_alpha' } }], buyer: { email: 'shopper@example.test' } },
    }, SESSION));

    // Defaulting is the quiet version of pricing a cart the buyer never named: it succeeds with a 200 and a
    // wrong total. The mapper copies `quantity` through UNTOUCHED so the shared cart rule refuses it.
    assert.ok(err, 'a quantity-less line must be refused');
    assert.equal(executor.calls('create_checkout_session').length, 0);
    assert.equal(JSON.stringify(executor.seen).includes('"quantity":1'), false, 'no quantity may be invented');
  });

  test('a non-positive or fractional quantity is refused rather than coerced', async () => {
    for (const quantity of [0, -2, 1.5, '3']) {
      const { executor, ucp } = ucpSurface();
      const err = await rejected(ucp.callTool('create_checkout', {
        meta: IDEMPOTENT_META,
        checkout: { line_items: [{ item: { id: 'p_alpha' }, quantity }], buyer: { email: 'shopper@example.test' } },
      }, SESSION));
      assert.ok(err, `quantity ${JSON.stringify(quantity)} must be refused`);
      assert.equal(executor.calls('create_checkout_session').length, 0);
    }
  });

  test('an empty cart is refused rather than priced as nothing', async () => {
    const { executor, ucp } = ucpSurface();
    const err = await rejected(ucp.callTool('create_checkout', {
      meta: IDEMPOTENT_META, checkout: { line_items: [] },
    }, SESSION));
    assert.ok(err);
    assert.equal(executor.seen.length, 0);
  });
});

// ---- 2. idempotency -----------------------------------------------------------------------------------------

describe('the idempotency key comes from meta, and is never minted', () => {
  test('a state-changing call with no meta["idempotency-key"] is refused, not auto-keyed', async () => {
    const { executor, ucp } = ucpSurface();
    const body = createBody();
    body.meta = AGENT_META; // profile only — no idempotency key
    const err = await rejected(ucp.callTool('create_checkout', body, SESSION));

    assert.ok(err, 'a mutating UCP call without an idempotency key must be refused');
    assert.equal(executor.seen.length, 0, 'nothing may be quoted under a server-minted key');
    assert.match(String(err.detail?.acp_message ?? err.message), /idempotency-key/);
  });

  test('a READ does not require an idempotency key (the rule is per-op, not blanket)', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('get_checkout', { meta: AGENT_META, id: 'sess_abc' }, SESSION);
    assert.equal(executor.only('get_checkout_session').params.session_id, 'sess_abc');
  });

  test('`meta` itself is required on every UCP call', async () => {
    const { executor, ucp } = ucpSurface();
    const err = await rejected(ucp.callTool('get_product', { catalog: { id: 'p_alpha' } }, SESSION));
    assert.ok(err);
    assert.equal(executor.seen.length, 0);
    assert.match(String(err.detail?.acp_message ?? err.message), /meta/);
  });
});

// ---- 3. update: the id is TOP-LEVEL -------------------------------------------------------------------------

describe('update_checkout reads its checkout id from the top level only', () => {
  test('the TOP-LEVEL `id` becomes session_id', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('update_checkout', { ...createBody(), id: 'sess_TOP' }, SESSION);

    const call = executor.only('update_checkout_session');
    assert.equal(call.params.session_id, 'sess_TOP');
    // The cart is re-mapped on update exactly as on create (an update RE-MINTS the snapshot).
    assert.deepEqual(call.params.quote.items, [
      { product_id: 'p_alpha', quantity: 3, variant_id: 'v_p_alpha' },
      { product_id: 'p_beta', quantity: 1, variant_id: 'v_p_beta' },
    ]);
  });

  test('an id nested inside `checkout` cannot stand in for the top-level one', async () => {
    const { executor, ucp } = ucpSurface();
    // No top-level id; `checkout.id` names a session. A mapper that reads the nested field would happily
    // re-price sess_NESTED here — so this call MUST be refused, and nothing may reach the executor.
    const err = await rejected(ucp.callTool('update_checkout', createBody({ id: 'sess_NESTED' }), SESSION));

    assert.ok(err, 'checkout.id must not satisfy update_checkout');
    assert.equal(executor.seen.length, 0);
    for (const call of executor.seen) {
      assert.notEqual(call.params?.session_id, 'sess_NESTED');
    }
  });

  test('get_checkout takes a TOP-LEVEL id and has no `checkout` wrapper at all (live-verified)', async () => {
    const { executor, ucp } = ucpSurface();
    // LIVE: get_checkout's whole input is { meta, id }. A `checkout` object is not part of it.
    const err = await rejected(ucp.callTool('get_checkout', {
      meta: IDEMPOTENT_META, id: 'sess_TOP', checkout: { id: 'sess_NESTED' },
    }, SESSION));
    assert.ok(err, 'get_checkout must refuse a checkout wrapper rather than reading an id out of it');
    assert.equal(JSON.stringify(executor.seen).includes('sess_NESTED'), false);
  });

  test('complete_checkout reads the session id from the TOP LEVEL, never from `checkout`', async () => {
    const { executor, ucp } = ucpSurface();
    // complete_checkout DOES have a `checkout` object (it carries `payment`) — but the id is still the
    // top-level one. A body whose only id sits inside `checkout` must be refused, not re-priced blind.
    const err = await rejected(ucp.callTool('complete_checkout', {
      meta: IDEMPOTENT_META, checkout: { payment: { instruments: [] }, id: 'sess_NESTED' },
    }, SESSION));
    assert.ok(err, 'a nested id must not satisfy complete_checkout');
    assert.equal(JSON.stringify(executor.seen).includes('sess_NESTED'), false);
  });

  test('a top-level id wins even when `checkout` also carries one — by refusing the ambiguous body outright', async () => {
    const { ucp } = ucpSurface();
    const err = await rejected(ucp.callTool('update_checkout', {
      ...createBody({ id: 'sess_NESTED' }), id: 'sess_TOP',
    }, SESSION));
    // `checkout` declares additionalProperties:false, so an id smuggled inside it is a refusal rather than a
    // second, silently-ignored source of the session identity.
    assert.ok(err, 'an ambiguous body must be refused, not silently resolved in the top level`s favour');
  });
});

// ---- 4. context hints are not an address --------------------------------------------------------------------

describe('destination hints never become a shipping address', () => {
  const HINTS = { address_country: 'US', address_region: 'CA', postal_code: '94107' };

  test('context is accepted on the wire and carried NOWHERE into the quote', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('create_checkout', createBody({ context: HINTS }), SESSION);

    const call = executor.only('create_checkout_session');
    assert.equal(call.params.quote.shipping_address, undefined, 'three hints are not a complete address');
    // Nothing from the hints may appear anywhere in what the executor received — not under another name,
    // not inside a partially-built address.
    const wire = JSON.stringify(call.params);
    assert.equal(wire.includes('94107'), false, 'the postal hint must not reach pricing');
    assert.equal(wire.includes('address_country'), false);
    assert.equal(wire.includes('address_region'), false);
  });

  test('a MISSING context fabricates nothing either', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('create_checkout', createBody(), SESSION);
    const call = executor.only('create_checkout_session');
    assert.equal(call.params.quote.shipping_address, undefined);
    assert.equal(JSON.stringify(call.params).includes('shipping_address'), false);
  });

  test('cart_id and attribution are accepted and likewise never forwarded', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('create_checkout', createBody({
      cart_id: 'gid://shopify/Cart/CART_SENTINEL',
      attribution: { source: 'ATTRIBUTION_SENTINEL' },
    }), SESSION);

    const wire = JSON.stringify(executor.only('create_checkout_session').params);
    assert.equal(wire.includes('CART_SENTINEL'), false, 'Pivota mints no cart; a foreign cart id is inert');
    assert.equal(wire.includes('ATTRIBUTION_SENTINEL'), false);
    // …and accepting them must not have cost the cart: the priced lines are still there.
    assert.equal(executor.only('create_checkout_session').params.quote.items.length, 2);
  });
});

// ---- 5. buyer identity --------------------------------------------------------------------------------------

describe('buyer identity comes from the verified session', () => {
  test('an ATTESTED email beats a body-supplied one (the body cannot pick the receipt address)', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('create_checkout', createBody({ buyer: { email: 'attacker@evil.test' } }), SESSION_ATTESTED);

    const call = executor.only('create_checkout_session');
    assert.equal(call.params.quote.customer_email, 'attested@example.test');
    assert.equal(
      JSON.stringify(call.params).includes('attacker@evil.test'), false,
      'the body-supplied address must not survive anywhere in the quote',
    );
  });

  test('with NO attested email the body value DOES fill the gap (both sides of the precedence rule)', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('create_checkout', createBody(), SESSION);
    assert.equal(executor.only('create_checkout_session').params.quote.customer_email, 'shopper@example.test');
  });

  test('no email anywhere is refused, and the refusal names UCP`s own field', async () => {
    const { executor, ucp } = ucpSurface();
    const body = createBody();
    delete body.checkout.buyer;
    const err = await rejected(ucp.callTool('create_checkout', body, SESSION));

    assert.ok(err);
    assert.equal(executor.calls('create_checkout_session').length, 0);
    // `quote.customer_email` is the MCP door's spelling and does not exist on this dialect; a caller told to
    // send it would retry the identical body and be refused identically.
    const message = String(err.detail?.acp_message ?? err.message);
    assert.match(message, /checkout\.buyer\.email/);
    assert.equal(message.includes('quote.customer_email'), false);
  });

  test('user_ref comes from the session context and has no wire field that could set it', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('create_checkout', createBody(), SESSION);
    assert.equal(executor.only('create_checkout_session').ctx.user_ref, 'buyer_1');

    // An identity field smuggled into the arguments is refused by the schema's additionalProperties:false,
    // which the mapper enforces too — it is not quietly dropped.
    const { executor: e2, ucp: u2 } = ucpSurface();
    const err = await rejected(u2.callTool('create_checkout', { ...createBody(), user_ref: 'attacker' }, SESSION));
    assert.ok(err, 'an identity field in the arguments must be refused');
    assert.equal(e2.seen.length, 0);
  });

  test('a user-scoped UCP call with no verified buyer is refused before any mapping', async () => {
    const { executor, ucp } = ucpSurface();
    const err = await rejected(ucp.callTool('create_checkout', createBody(), {}));
    assert.ok(err);
    assert.equal(String(err.code), 'USER_AUTH_REQUIRED');
    assert.equal(executor.seen.length, 0);
  });
});

// ---- 6. payment never travels on the quote lane ---------------------------------------------------------------

describe('a payment field on create/update is refused, never forwarded', () => {
  for (const tool of ['create_checkout', 'update_checkout']) {
    test(`${tool} refuses checkout.payment and points at complete_checkout`, async () => {
      const { executor, ucp } = ucpSurface();
      const withPayment = createBody({ payment: { token: 'PAYMENT_SENTINEL' } });
      // update carries a top-level id; create declares no such field, so each tool gets its own valid frame
      // and the refusal under test is the PAYMENT one, not a shape mismatch.
      const body = tool === 'update_checkout' ? { ...withPayment, id: 'sess_TOP' } : withPayment;
      const err = await rejected(ucp.callTool(tool, body, SESSION));

      assert.ok(err, `${tool} must refuse a payment field`);
      assert.equal(executor.seen.length, 0, 'a refused body must not be priced');
      // Not merely dropped: the caller believes it authorized a charge and must be told where it belongs.
      assert.match(String(err.detail?.acp_message ?? err.message), /complete_checkout/);
      assert.equal(JSON.stringify(executor.seen).includes('PAYMENT_SENTINEL'), false);
    });
  }

  // The LIVE complete_checkout LOCATION (cosrx tools/list, 2026-08-13): { meta, id, checkout: { payment } }.
  // The envelope CONTENTS are Pivota's published contract — a method discriminator plus a signed grant — and
  // NOT the merchant's own `instruments` shape. That distinction is the #1966 defect: getting `payment`'s
  // location right while publishing contents the kernel's verifier refuses left the charge unexecutable.
  // test/ucpPaymentAuthorizationContract.test.js is what proves this envelope verifies at the real gate; here
  // we only pin that the door maps it.
  const GRANT_PAYMENT = { method: 'ucp_handler', token: 'signed.grant.jwt' };

  test('complete_checkout carries the published payment envelope through as payment_authorization', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('complete_checkout', {
      meta: IDEMPOTENT_META, id: 'sess_TOP', checkout: { payment: GRANT_PAYMENT },
    }, SESSION);

    const call = executor.only('complete_checkout_session');
    assert.equal(call.params.session_id, 'sess_TOP');
    assert.equal(call.params.idempotency_key, 'idem-key-0001');
    assert.deepEqual(call.params.payment_authorization, GRANT_PAYMENT);
  });

  test('a UCP payment-handler INSTRUMENT is refused at the door, naming what to send instead', async () => {
    const { executor, ucp } = ucpSurface();
    // Exactly what #1966 advertised, and what a platform following that schema sent: an opaque PSP credential
    // Pivota has no rail to charge. Forwarding it reached the kernel and died as
    // CONFIRMATION_INVALID{unknown_authorization_method} — a code naming no field, raised on the money path.
    const err = await rejected(ucp.callTool('complete_checkout', {
      meta: IDEMPOTENT_META,
      id: 'sess_TOP',
      checkout: {
        payment: {
          instruments: [{
            id: 'inst_1', handler_id: 'shopify.card', type: 'card',
            credential: { token: 'INSTRUMENT_SENTINEL', type: 'stripe.token' },
          }],
        },
      },
    }, SESSION));

    assert.ok(err, 'an instrument must not be accepted as authorization');
    assert.equal(executor.seen.length, 0, 'nothing may reach the executor on an unauthorizable completion');
    assert.equal(JSON.stringify(executor.seen).includes('INSTRUMENT_SENTINEL'), false);
    // Refused, not dropped — and the message must name the remedy, not just the problem.
    const message = String(err.detail?.acp_message ?? err.message);
    assert.match(message, /instruments/);
    assert.match(message, /ucp_handler/);
    assert.match(message, /token/);
  });

  test('a TOP-LEVEL payment is refused — the live shape nests it under `checkout`', async () => {
    const { executor, ucp } = ucpSurface();
    // This is the shape this adapter's first revision extrapolated and published. Asserting it is REFUSED
    // is what stops the wrong shape quietly coming back: the door would then accept a body no conforming
    // platform sends, while refusing the one they all do.
    const err = await rejected(ucp.callTool('complete_checkout', {
      meta: IDEMPOTENT_META, id: 'sess_TOP', payment: GRANT_PAYMENT,
    }, SESSION));
    assert.ok(err, 'a top-level payment is not the live wire shape');
    assert.equal(executor.seen.length, 0);
  });

  test('complete_checkout without a payment is refused rather than completed unauthorized', async () => {
    for (const body of [
      { meta: IDEMPOTENT_META, id: 'sess_TOP' },                    // no checkout at all
      { meta: IDEMPOTENT_META, id: 'sess_TOP', checkout: {} },       // checkout with no payment
    ]) {
      const { executor, ucp } = ucpSurface();
      const err = await rejected(ucp.callTool('complete_checkout', body, SESSION));
      assert.ok(err, `must refuse: ${JSON.stringify(body)}`);
      assert.equal(executor.seen.length, 0);
    }
  });

  test('complete_checkout accepts checkout.attribution and does not forward it', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('complete_checkout', {
      meta: IDEMPOTENT_META,
      id: 'sess_TOP',
      checkout: { payment: GRANT_PAYMENT, attribution: { source: 'ATTR_SENTINEL' } },
    }, SESSION);
    const wire = JSON.stringify(executor.only('complete_checkout_session').params);
    assert.equal(wire.includes('ATTR_SENTINEL'), false);
    assert.match(wire, /signed\.grant\.jwt/, 'the payment envelope itself must still travel');
  });
});

// ---- 7. get_product -------------------------------------------------------------------------------------------

describe('get_product speaks the UCP nested-catalog shape', () => {
  test('`catalog.id` becomes the canonical product_id (and no merchant is invented)', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('get_product', { meta: AGENT_META, catalog: { id: 'sig_abc' } }, SESSION);

    const call = executor.only('get_product');
    assert.deepEqual(call.params.payload.product, { product_id: 'sig_abc' });
    assert.equal(call.params.payload.product.merchant_id, undefined, 'the UCP shape names no merchant');
  });

  test('a FLAT top-level id is refused — the live shape nests it under `catalog`', async () => {
    const { executor, ucp } = ucpSurface();
    // The shape this adapter first published, taken from the buyer client's `catalogSearch`. Asserting it is
    // refused is what stops the flat spelling drifting back in.
    const err = await rejected(ucp.callTool('get_product', { meta: AGENT_META, id: 'sig_abc', sku: 'SKU-1' }, SESSION));
    assert.ok(err, 'a flat top-level id is not the live wire shape');
    assert.equal(executor.seen.length, 0);
  });

  test('the live catalog members are accepted, and only `id` is read', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('get_product', {
      meta: AGENT_META,
      catalog: {
        id: 'sig_abc',
        selected: [{ name: 'Size', label: 'SEL_SENTINEL' }],
        preferences: [{ name: 'PREF_SENTINEL' }],
        context: { country: 'CTX_SENTINEL' },
        signals: { s: 'SIG_SENTINEL' },
        filters: { f: 'FIL_SENTINEL' },
      },
    }, SESSION);

    const wire = JSON.stringify(executor.only('get_product').params);
    // Variant narrowing is resolved server-side from the canonical product; honouring a caller's
    // pre-selection here would answer about something the read never confirmed.
    for (const s of ['SEL_SENTINEL', 'PREF_SENTINEL', 'CTX_SENTINEL', 'SIG_SENTINEL', 'FIL_SENTINEL']) {
      assert.equal(wire.includes(s), false, `${s} must not be forwarded`);
    }
    assert.match(wire, /sig_abc/);
  });

  test('a free-text query alone cannot be answered here', async () => {
    // `query` is not part of the live get_product input at all, so it is refused as an undeclared field.
    const { executor, ucp } = ucpSurface();
    const err = await rejected(ucp.callTool('get_product', { meta: AGENT_META, query: 'retinol serum' }, SESSION));
    assert.ok(err);
    assert.equal(executor.seen.length, 0);
  });

  test('a catalog with no id is refused, naming the nested field', async () => {
    const { executor, ucp } = ucpSurface();
    const err = await rejected(ucp.callTool('get_product', { meta: AGENT_META, catalog: {} }, SESSION));
    assert.ok(err);
    assert.equal(executor.seen.length, 0);
    assert.match(String(err.detail?.acp_message ?? err.message), /catalog\.id/);
  });
});

// ---- 8. the published schema IS the accepted shape --------------------------------------------------------------

describe('schema and mapper cannot drift', () => {
  // THE MAXIMAL BODIES ARE DERIVED FROM `inputSchema`, NOT WRITTEN BY HAND.
  //
  // They used to be hand-written, and that quietly re-opened the hole this section exists to close: a field
  // could be ADVERTISED and then refused by the mapper, because the hand-built body simply never contained it.
  // Confirmed by mutation — adding `checkout.fulfillment` to the published schema (a real field on the live
  // merchant, and the one this door still owes) left all 61 tests green while the mapper refused every body
  // carrying it. Deriving the body from the schema makes "everything advertised is accepted" a fact about the
  // published contract rather than about the fixture.
  //
  // Every string leaf gets a sentinel naming its own PATH, so what survives into the canonical params is
  // attributable to an exact field.
  const sentinelFor = (path) => `S<${path}>`;

  function maximalFor(schema, path = '') {
    if (Array.isArray(schema.enum)) return schema.enum[0];
    switch (schema.type) {
      case 'object': {
        const out = {};
        for (const [name, sub] of Object.entries(schema.properties ?? {})) {
          out[name] = maximalFor(sub, path ? `${path}.${name}` : name);
        }
        // A free-form object (additionalProperties:true, nothing declared) still needs a sentinel, or "is it
        // forwarded?" would be unanswerable for exactly the fields most likely to be forwarded by accident.
        if (Object.keys(out).length === 0 && schema.additionalProperties !== false) {
          out.free_form = sentinelFor(path ? `${path}.*` : '*');
        }
        return out;
      }
      case 'array': {
        const count = Math.max(schema.minItems ?? 1, 1);
        return Array.from({ length: count }, () => maximalFor(schema.items ?? {}, `${path}[]`));
      }
      case 'integer':
      case 'number':
        return schema.minimum ?? 1;
      case 'boolean':
        return true;
      default:
        return sentinelFor(path);
    }
  }

  /** Every string-sentinel path present in a generated body. */
  function sentinelPaths(schema, path = '') {
    if (Array.isArray(schema.enum)) return [];
    switch (schema.type) {
      case 'object': {
        const entries = Object.entries(schema.properties ?? {});
        if (entries.length === 0 && schema.additionalProperties !== false) {
          return [path ? `${path}.*` : '*'];
        }
        return entries.flatMap(([name, sub]) => sentinelPaths(sub, path ? `${path}.${name}` : name));
      }
      case 'array':
        return sentinelPaths(schema.items ?? {}, `${path}[]`);
      case 'integer': case 'number': case 'boolean':
        return [];
      default:
        return [path];
    }
  }

  const opFor = (tool) => canonicalOpForUcpTool(tool);
  const schemaFor = (tool) => UCP_INPUT_SCHEMAS[opFor(tool).id];

  const MAXIMAL = Object.freeze(Object.fromEntries(
    ucpCommerceToolDefinitions.map((def) => [def.name, maximalFor(schemaFor(def.name))]),
  ));

  test('the derived maximal bodies really are the live wire shapes (the derivation is not vacuous)', () => {
    // A generator that silently produced `{}` would make every test below pass while asserting nothing. Pin
    // the shapes that matter against the live merchant's spelling, so the derivation itself is load-bearing.
    assert.equal(MAXIMAL.create_checkout.checkout.line_items.length, 1);
    assert.equal(MAXIMAL.create_checkout.checkout.line_items[0].item.id, 'S<checkout.line_items[].item.id>');
    assert.equal(MAXIMAL.create_checkout.checkout.line_items[0].quantity, 1);
    assert.equal(MAXIMAL.update_checkout.id, 'S<id>');
    assert.equal(MAXIMAL.get_product.catalog.id, 'S<catalog.id>');
    // The payment envelope's discriminator comes from the schema's own enum, not from this file.
    assert.equal(MAXIMAL.complete_checkout.checkout.payment.method, 'ucp_handler');
    assert.equal(MAXIMAL.complete_checkout.checkout.payment.token, 'S<checkout.payment.token>');
  });

  test('every published UCP tool has a UCP schema and an argument mapping', () => {
    assert.equal(ucpCommerceToolDefinitions.length, 5);
    for (const def of ucpCommerceToolDefinitions) {
      const op = opFor(def.name);
      assert.ok(op, `${def.name} must resolve to a canonical operation`);
      // The published schema must be the UCP one — not the Pivota-native schema this PR replaced.
      assert.equal(def.inputSchema, UCP_INPUT_SCHEMAS[op.id], `${def.name} must publish its UCP schema`);
      assert.ok(def.inputSchema.required.includes('meta'), `${def.name} must advertise meta as required`);
      // The native schemas' hallmark fields must be gone from the wire contract.
      assert.equal(def.inputSchema.properties.idempotency_key, undefined);
      assert.equal(def.inputSchema.properties.quote, undefined);
      assert.equal(def.inputSchema.properties.session_id, undefined);
      assert.ok(MAXIMAL[def.name], `${def.name} needs a maximal body in this test`);
    }
  });

  test('a maximal schema-valid body is ACCEPTED by the mapper for every tool', () => {
    for (const def of ucpCommerceToolDefinitions) {
      assert.doesNotThrow(
        () => ucpToNativeToolArgs(opFor(def.name), MAXIMAL[def.name]),
        `${def.name}: a body built to the published schema must map`,
      );
    }
  });

  test('every field the schema declares REQUIRED is enforced by the mapper', () => {
    for (const def of ucpCommerceToolDefinitions) {
      for (const field of def.inputSchema.required) {
        const body = { ...MAXIMAL[def.name] };
        delete body[field];
        assert.throws(
          () => ucpToNativeToolArgs(opFor(def.name), body),
          `${def.name}: dropping the required \`${field}\` must be refused`,
        );
      }
      // …and the same for meta's own required member, which is where the idempotency key lives.
      const metaRequired = def.inputSchema.properties.meta.required ?? [];
      for (const field of metaRequired) {
        const meta = { ...MAXIMAL[def.name].meta };
        delete meta[field];
        assert.throws(
          () => ucpToNativeToolArgs(opFor(def.name), { ...MAXIMAL[def.name], meta }),
          `${def.name}: dropping the required \`meta.${field}\` must be refused`,
        );
      }
    }
  });

  test('additionalProperties:false is enforced by the mapper at EVERY depth, not just advertised', () => {
    // Walk the schema for every strict object ANYWHERE — including through arrays — and prove the mapper
    // refuses an undeclared member there. Restricting this to top-level `properties` (as it did) left the
    // strict objects inside `checkout.line_items[]` and `.item` unguarded: deleting BOTH their `rejectUnknown`
    // calls left all 52 tests green. A guard no test can kill is not a guard.
    const strictPaths = (schema, path = []) => {
      if (schema?.type === 'array') return strictPaths(schema.items ?? {}, [...path, '[]']);
      if (schema?.type !== 'object') return [];
      const here = schema.additionalProperties === false ? [path] : [];
      return here.concat(
        Object.entries(schema.properties ?? {}).flatMap(([name, sub]) => strictPaths(sub, [...path, name])),
      );
    };
    /** Clone `body`, adding an undeclared field at `path` ('[]' descends into the first array element). */
    const injectAt = (body, path) => {
      const clone = structuredClone(body);
      let node = clone;
      for (const step of path) node = step === '[]' ? node[0] : node[step];
      node.not_a_ucp_field = 'UNDECLARED_SENTINEL';
      return clone;
    };

    let checked = 0;
    for (const def of ucpCommerceToolDefinitions) {
      const paths = strictPaths(def.inputSchema);
      assert.ok(paths.some((p) => p.length === 0), `${def.name}: the top level must be strict`);
      for (const path of paths) {
        assert.throws(
          () => ucpToNativeToolArgs(opFor(def.name), injectAt(MAXIMAL[def.name], path)),
          `${def.name}: an undeclared field at \`${['arguments', ...path].join('.')}\` must be refused`,
        );
        checked += 1;
      }
    }
    // The walk must actually reach the nested objects — a strictPaths that returned only the five top levels
    // would make this test pass while checking nothing new.
    assert.ok(checked >= 12, `expected the walk to reach nested strict objects, only checked ${checked}`);
  });

  test('every declared field is either MAPPED or recorded as deliberately unmapped', () => {
    // The pin, now over the DERIVED sentinel set: for each declared string leaf, does it survive into the
    // canonical params? Both directions fail loudly — a field that starts being read, and a field that stops.
    // Because the paths come from the schema, a NEWLY ADVERTISED field has to be classified here before this
    // test will pass, which is the property the hand-written version lacked.
    const EXPECTED_SURVIVING = Object.freeze({
      get_product: ['catalog.id'],
      create_checkout: ['meta.idempotency-key', 'checkout.line_items[].item.id', 'checkout.buyer.email'],
      update_checkout: ['meta.idempotency-key', 'id', 'checkout.line_items[].item.id', 'checkout.buyer.email'],
      get_checkout: ['id'],
      complete_checkout: ['meta.idempotency-key', 'id', 'checkout.payment.token'],
    });

    for (const def of ucpCommerceToolDefinitions) {
      const mapped = JSON.stringify(ucpToNativeToolArgs(opFor(def.name), MAXIMAL[def.name]));
      const declared = sentinelPaths(schemaFor(def.name));
      const surviving = declared.filter((p) => mapped.includes(sentinelFor(p)));
      // Set equality, not a one-way spot check: the complement (everything NOT listed) is asserted to be
      // absent from the canonical params by the same comparison.
      assert.deepEqual(
        surviving.sort(), [...EXPECTED_SURVIVING[def.name]].sort(),
        `${def.name}: the set of fields reaching the canonical args changed`,
      );
    }

    // And the unmapped set is DECLARED, not merely observed — so dropping a field from the mapper without
    // recording the decision fails this file rather than passing silently. Checked against the derived
    // complement in both directions, so the declaration cannot go stale either:
    //   - every accepted-but-unread leaf must be covered by an entry, and
    //   - every entry must still cover a real leaf (a field deleted from the schema leaves a dead entry).
    // An entry covers a leaf when it names the leaf itself or an ancestor of it — `checkout.context` covers
    // `checkout.context.postal_code`, and `catalog.selected` covers `catalog.selected[].*`. The separator may
    // therefore be `.` or `[`, which is why this is not a bare `startsWith(entry + '.')`.
    const covers = (entry, leaf) => leaf === entry || leaf.startsWith(`${entry}.`) || leaf.startsWith(`${entry}[`);

    for (const def of ucpCommerceToolDefinitions) {
      const opId = opFor(def.name).id;
      const declaredUnmapped = UCP_ACCEPTED_BUT_UNMAPPED[opId];
      assert.ok(declaredUnmapped, `${def.name}: needs an UCP_ACCEPTED_BUT_UNMAPPED entry`);
      const mapped = JSON.stringify(ucpToNativeToolArgs(opFor(def.name), MAXIMAL[def.name]));
      const unread = sentinelPaths(schemaFor(def.name))
        // `meta` is protocol plumbing (the profile pointer, the idempotency key) rather than a checkout field.
        .filter((p) => !p.startsWith('meta.') && !mapped.includes(sentinelFor(p)));

      for (const leaf of unread) {
        assert.ok(
          declaredUnmapped.some((entry) => covers(entry, leaf)),
          `${def.name}: \`${leaf}\` is advertised and silently unread — declare it in UCP_ACCEPTED_BUT_UNMAPPED`,
        );
      }
      for (const entry of declaredUnmapped) {
        assert.ok(
          unread.some((leaf) => covers(entry, leaf)),
          `${def.name}: UCP_ACCEPTED_BUT_UNMAPPED lists \`${entry}\`, which no longer exists or is now read`,
        );
      }
    }
  });

  test('the fields the LIVE schemas permit are accepted, not refused for being unlisted', () => {
    // Every one of these was REFUSED by this adapter's first revision, which narrowed the shapes it had not
    // yet verified. Each is a conforming platform being turned away at a door that advertised the tool.
    const op = opFor('create_checkout');
    assert.doesNotThrow(() => ucpToNativeToolArgs(op, createBody({
      buyer: { email: 'shopper@example.test', phone_number: '+15551234567' },
    })), 'buyer.phone_number is in the live schema');
    assert.doesNotThrow(() => ucpToNativeToolArgs(op, {
      meta: IDEMPOTENT_META,
      checkout: {
        line_items: [{ id: 'line_1', item: { id: 'p_alpha' }, quantity: 2 }],
        buyer: { email: 'shopper@example.test' },
      },
    }), 'a flat line `id` beside `item` is in the live schema');

    // …and being accepted must not mean being READ: `item.id` is still the priced identity.
    const mapped = ucpToNativeToolArgs(op, {
      meta: IDEMPOTENT_META,
      checkout: {
        line_items: [{ id: 'LINE_SENTINEL', item: { id: 'p_alpha' }, quantity: 2 }],
        buyer: { email: 'shopper@example.test', phone_number: 'PHONE_SENTINEL' },
      },
    });
    assert.deepEqual(mapped.quote.items, [{ product_id: 'p_alpha', quantity: 2 }]);
    assert.equal(JSON.stringify(mapped).includes('LINE_SENTINEL'), false);
    assert.equal(JSON.stringify(mapped).includes('PHONE_SENTINEL'), false);
  });

  test('the published schemas match the LIVE merchant schemas, field for field', () => {
    // PROVENANCE: captured from a real UCP merchant via the buyer client's own `listTools` —
    //   GET  https://cosrx.com/.well-known/ucp        -> services[mcp].endpoint
    //        = https://cosrx-renewal.myshopify.com/api/ucp/mcp
    //   POST that endpoint, JSON-RPC `tools/list`      -> 2026-08-13, anonymous tier, read-only
    // These four `required` arrays are the merchant's, transcribed verbatim. They are the reason
    // complete_checkout changed shape: it was the one tool whose arguments had never been fetched, and the
    // extrapolated `{meta,id,payment}` would have refused every conforming platform ON THE CHARGE.
    const LIVE_REQUIRED = Object.freeze({
      get_product: ['meta', 'catalog'],
      create_checkout: ['meta', 'checkout'],
      update_checkout: ['meta', 'checkout', 'id'],
      get_checkout: ['meta', 'id'],
      complete_checkout: ['meta', 'id', 'checkout'],
    });
    const LIVE_CHECKOUT_REQUIRED = Object.freeze({
      create_checkout: ['line_items'],
      update_checkout: ['line_items'],
      complete_checkout: ['payment'],
    });

    for (const def of ucpCommerceToolDefinitions) {
      const live = LIVE_REQUIRED[def.name];
      if (!live) continue;
      assert.deepEqual(
        [...def.inputSchema.required].sort(), [...live].sort(),
        `${def.name}: published required must equal the live merchant's`,
      );
      const liveCheckout = LIVE_CHECKOUT_REQUIRED[def.name];
      if (!liveCheckout) continue;
      assert.deepEqual(
        [...def.inputSchema.properties.checkout.required].sort(), [...liveCheckout].sort(),
        `${def.name}: published checkout.required must equal the live merchant's`,
      );
    }
  });

  test('the mapper refuses to translate an operation it has no mapping for', () => {
    // A UCP-dialect op added to the contract without an argument mapping would otherwise be published with a
    // native schema and fail at the executor — the exact defect this module closes.
    assert.throws(() => ucpToNativeToolArgs({ id: 'cancel_checkout_session' }, { meta: AGENT_META }),
      /no UCP argument mapping/);
  });

  test('the MCP dialect is untouched: native tool args still map natively', async () => {
    const executor = recordingExecutor();
    const mcp = createCommerceToolSurface(executor, { cache: false });
    await mcp.callTool('create_checkout_session', {
      idempotency_key: 'idem-key-0001',
      quote: { merchant_id: 'm1', items: [{ product_id: 'p_alpha', quantity: 3 }], customer_email: 'shopper@example.test' },
    }, SESSION);

    const call = executor.only('create_checkout_session');
    assert.equal(call.params.quote.merchant_id, 'm1');
    assert.deepEqual(call.params.quote.items, [{ product_id: 'p_alpha', quantity: 3, variant_id: 'v_p_alpha' }]);
  });
});
