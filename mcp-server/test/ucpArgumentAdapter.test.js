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
  commerceToolDefinitions,
} from '../src/commerceToolSurface.js';
import {
  UCP_INPUT_SCHEMAS,
  UCP_ACCEPTED_BUT_UNMAPPED,
  SEARCH_PAGE_SIZE_MAX,
  SEARCH_CURSOR_EXAMPLE,
  ucpToNativeToolArgs,
} from '../src/ucpArgumentAdapter.js';
import { encodeSearchCursor } from '../src/ucpResponseShaper.js';
import { canonicalOpForUcpTool } from '../../safety-kernel/src/protocol/canonicalContract.js';
import { surfaceableIntakeRefusal } from '../../safety-kernel/src/protocol/buyerIntake.js';

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
        // A PRICED row: on the UCP dialect the response is now shaped to the spec, and a row with no priced
        // offer is (correctly) refused as NO_MERCHANT_OFFER — which would fail every get_product test here for
        // a reason unrelated to argument mapping. Native rows carry major-unit price + currency; so does this.
        return { product: { product_id, title: `Product ${product_id}`, price: 12.5, currency: 'USD', variants: [{ variant_id: `v_${product_id}` }] } };
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

// ---- 7b. search_catalog ------------------------------------------------------------------------------------------

describe('search_catalog speaks the UCP nested-catalog shape and takes the unscoped lane', () => {
  test('`catalog.query` becomes the native `query`, and NO merchant is invented', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('search_catalog', { meta: AGENT_META, catalog: { query: 'niacinamide serum' } }, SESSION);

    const call = executor.only('search_catalog');
    // toParams' allowlist wraps the native args as payload.search; the query survives, nothing else appears.
    assert.deepEqual(call.params.payload.search, { query: 'niacinamide serum' });

    // …and it is trimmed on the way through, as `catalog.id` is: the cache key downstream is the allowlisted
    // params, so " retinol" and "retinol" must be one entry, not two.
    const { executor: ex2, ucp: ucp2 } = ucpSurface();
    await ucp2.callTool('search_catalog', { meta: AGENT_META, catalog: { query: '  retinol  ' } }, SESSION);
    assert.deepEqual(ex2.only('search_catalog').params.payload.search, { query: 'retinol' });
    assert.equal(call.params.payload.search.merchant_id, undefined, 'the UCP shape names no merchant');
    // The executor selects the lane from the ABSENCE of merchant_id (canonicalExecutor: unscoped ->
    // find_products_multi). The op id it receives is the canonical one, so the dialect forked nothing.
    assert.equal(call.op, 'search_catalog');
  });

  test('a FLAT top-level query is refused — the live shape nests it under `catalog`', async () => {
    const { executor, ucp } = ucpSurface();
    const err = await rejected(ucp.callTool('search_catalog', { meta: AGENT_META, query: 'retinol' }, SESSION));
    assert.ok(err, 'a flat top-level query is not the live wire shape');
    assert.equal(executor.seen.length, 0);
    assert.match(String(err.detail?.acp_message ?? err.message), /catalog/);
  });

  test('a missing `catalog` object is refused, naming the nested field', async () => {
    const { executor, ucp } = ucpSurface();
    const err = await rejected(ucp.callTool('search_catalog', { meta: AGENT_META }, SESSION));
    assert.ok(err);
    assert.equal(executor.seen.length, 0);
    assert.match(String(err.detail?.acp_message ?? err.message), /catalog\.query/);
  });

  test('a query-less call is LEGAL on the wire and reaches the lane with no query, not an empty string', async () => {
    // The live schema declares no required member under `catalog`. A door stricter than the spec turns a
    // conforming caller away; passing "" instead would change what the native lane sees for the same call.
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('search_catalog', { meta: AGENT_META, catalog: {} }, SESSION);
    const call = executor.only('search_catalog');
    assert.equal(Object.prototype.hasOwnProperty.call(call.params.payload.search, 'query'), false);
  });

  test('a blank query is treated the same as an absent one, and a non-string query is refused', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('search_catalog', { meta: AGENT_META, catalog: { query: '   ' } }, SESSION);
    assert.equal(Object.prototype.hasOwnProperty.call(executor.only('search_catalog').params.payload.search, 'query'), false);

    // EVERY non-string, not just a number: a mutant that checked `typeof query === "number"` let an array
    // or object query through as ABSENT and ran a query-less search — silently answering a different
    // question than the one asked (review of #2016).
    for (const bad of [12345, ['niacinamide'], { text: 'niacinamide' }, true, null]) {
      const { executor: ex2, ucp: ucp2 } = ucpSurface();
      const err = await rejected(ucp2.callTool('search_catalog', { meta: AGENT_META, catalog: { query: bad } }, SESSION));
      assert.ok(err, `a ${Array.isArray(bad) ? 'array' : typeof bad} query must be refused`);
      assert.equal(ex2.seen.length, 0, 'nothing may reach the executor');
      assert.match(String(err.detail?.acp_message ?? err.message), /catalog\.query/);
    }
  });

  test('the live catalog members are accepted; the declared-unread ones never reach the lane', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('search_catalog', {
      meta: AGENT_META,
      catalog: {
        query: 'vitamin c',
        pagination: { unknown_member: 'PAG_SENTINEL' },
        context: {
          address_country: 'CTRY_SENTINEL', address_region: 'REG_SENTINEL', postal_code: 'PC_SENTINEL',
          language: 'LANG_SENTINEL', intent: 'INT_SENTINEL', unknown_member: 'CTX_SENTINEL',
        },
        signals: { 'dev.ucp.buyer_ip': 'IP_SENTINEL', 'dev.ucp.user_agent': 'UA_SENTINEL', s: 'SIG_SENTINEL' },
        filters: { categories: ['CAT_SENTINEL'], unknown_member: 'FIL_SENTINEL' },
      },
    }, SESSION);
    const wire = JSON.stringify(executor.only('search_catalog').params);
    for (const s of [
      'PAG_SENTINEL', 'CTRY_SENTINEL', 'REG_SENTINEL', 'PC_SENTINEL', 'LANG_SENTINEL',
      'INT_SENTINEL', 'CTX_SENTINEL', 'IP_SENTINEL', 'UA_SENTINEL', 'SIG_SENTINEL', 'CAT_SENTINEL', 'FIL_SENTINEL',
    ]) {
      assert.equal(wire.includes(s), false, `${s} must not be forwarded`);
    }
    assert.match(wire, /vitamin c/);
    // …and nothing but the query reached the lane from that body: no page_size, no filter, no currency.
    assert.deepEqual(executor.only('search_catalog').params.payload.search, { query: 'vitamin c' });
  });

  test('`meta` is required on the read, exactly as on every other UCP call', async () => {
    const { executor, ucp } = ucpSurface();
    const err = await rejected(ucp.callTool('search_catalog', { catalog: { query: 'toner' } }, SESSION));
    assert.ok(err);
    assert.equal(executor.seen.length, 0);
    assert.match(String(err.detail?.acp_message ?? err.message), /meta/);
  });

  test('search is not user-scoped: it answers an ANONYMOUS session (no user_ref) as get_product does', async () => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('search_catalog', { meta: AGENT_META, catalog: { query: 'sunscreen' } }, {});
    assert.equal(executor.only('search_catalog').params.payload.search.query, 'sunscreen');
  });

  test('a `merchant_id` is refused at BOTH depths — the lane cannot be flipped from the wire', async () => {
    // Review of #2016 found this unpinned: a mutant that let `catalog.merchant_id` through survived the
    // whole suite. That value would flip canonicalExecutor's lane selection from the unscoped
    // multi-merchant index to the merchant-scoped per-store `find_products` (the Python backend), AND
    // enter the caller-independent cache key. The strict-depth walk only injects `not_a_ucp_field`, so a
    // by-name allowlist widening was invisible to it. Both placements a caller might try are refused
    // before anything reaches the executor.
    for (const body of [
      { meta: AGENT_META, catalog: { query: 'serum', merchant_id: 'm_1' } },
      { meta: AGENT_META, merchant_id: 'm_1', catalog: { query: 'serum' } },
    ]) {
      const { executor, ucp } = ucpSurface();
      const err = await rejected(ucp.callTool('search_catalog', body, SESSION));
      assert.ok(err, `merchant_id must be refused: ${JSON.stringify(body)}`);
      assert.equal(executor.seen.length, 0, 'nothing may reach the executor');
      assert.equal(JSON.stringify(err.detail ?? {}).includes('m_1'), false, 'the refusal never echoes the value');
    }
  });

  test('a search wire-shape refusal carries a stable code and retriable:false, and reads as intake', async () => {
    // Also unpinned per the review: SEARCH_REFUSAL_CODE could be swapped for QUOTE_REQUIRED, or for
    // MERCHANT_UNAVAILABLE (retriable:true — the property the code choice calls load-bearing) with every
    // search test green. Pin what a client actually branches on. The comparison target is the OTHER read's
    // refusal, so the two discovery tools cannot silently diverge in retry semantics either.
    const { ucp } = ucpSurface();
    const read = await rejected(ucp.callTool('get_product', { meta: AGENT_META, catalog: {} }, SESSION));
    assert.equal(read.retriable, false, 'both discovery refusals must be terminal');
    // EVERY search refusal site, not one: the verify pass found a per-site literal swap (`"MERCHANT_UNAVAILABLE"`
    // at the query-string or catalog-object throw) survived a pin that only drove the flat-query path. Each
    // reason is driven by the body that reaches it, and each must carry the shared code + retriable:false.
    const SITES = [
      ['ucp_query_must_nest_under_catalog', { meta: AGENT_META, query: 'flat' }],
      ['ucp_unknown_field', { meta: AGENT_META, catalog: { query: 'x' }, extra: 1 }],
      ['ucp_meta_required', { catalog: { query: 'x' } }],
      ['ucp_catalog_object_required', { meta: AGENT_META }],
      ['ucp_query_string_required', { meta: AGENT_META, catalog: { query: 42 } }],
    ];
    for (const [reason, body] of SITES) {
      const err = await rejected(ucp.callTool('search_catalog', body, SESSION));
      assert.ok(err, `${reason}: must refuse`);
      assert.equal(err.code, 'OPERATION_NOT_ALLOWED', `${reason}: code`);
      assert.equal(err.retriable, false, `${reason}: retriable`);
      // …and it surfaces through the shared intake opt-in: a curated message + a field-naming detail block,
      // not the catalog's generic userMessage. `reason` is the discriminator a client can branch on.
      const surfaced = surfaceableIntakeRefusal(err);
      assert.ok(surfaced, `${reason}: must be a surfaceable intake refusal`);
      assert.equal(surfaced.detail.dialect, 'ucp', `${reason}: dialect`);
      assert.equal(surfaced.detail.reason, reason);
    }
    const flat = surfaceableIntakeRefusal(await rejected(ucp.callTool('search_catalog', SITES[0][1], SESSION)));
    assert.match(flat.message, /catalog\.query/);
  });
});

// ---- 7c. search_catalog filters / pagination / currency ---------------------------------------------------------

describe('search_catalog reads the live filters, pagination and currency the way the native lane means them', () => {
  const search = async (catalog) => {
    const { executor, ucp } = ucpSurface();
    await ucp.callTool('search_catalog', { meta: AGENT_META, catalog }, SESSION);
    return executor.only('search_catalog').params.payload.search;
  };
  const refused = async (catalog) => {
    const { executor, ucp } = ucpSurface();
    const err = await rejected(ucp.callTool('search_catalog', { meta: AGENT_META, catalog }, SESSION));
    assert.ok(err, `expected a refusal for ${JSON.stringify(catalog)}`);
    assert.equal(executor.seen.length, 0, 'nothing may reach the executor');
    assert.equal(err.code, 'OPERATION_NOT_ALLOWED');
    assert.equal(err.retriable, false);
    return String(err.detail?.acp_message ?? err.message);
  };

  test('the UCP page-size cap IS the native tool\'s published `page_size.maximum` (hand-copied, so pinned)', () => {
    const native = commerceToolDefinitions.find((d) => d.name === 'search_catalog');
    assert.equal(native.inputSchema.properties.page_size.maximum, SEARCH_PAGE_SIZE_MAX,
      'a UCP call must not be able to ask the lane for more than the native tool advertises');
  });

  test('`pagination.limit` becomes `page_size`, capped at the native ceiling', async () => {
    assert.deepEqual(await search({ query: 'q', pagination: { limit: 24 } }), { query: 'q', page_size: 24 });
    assert.deepEqual(await search({ query: 'q', pagination: { limit: 1 } }), { query: 'q', page_size: 1 });
    // The live schema declares no maximum; the native tool publishes 50. Capped, not refused.
    assert.deepEqual(await search({ query: 'q', pagination: { limit: 500 } }), { query: 'q', page_size: 50 });
    assert.deepEqual(await search({ query: 'q', pagination: { limit: 50 } }), { query: 'q', page_size: 50 });
    for (const bad of [0, -1, 1.5, '10', true, null]) {
      assert.match(await refused({ query: 'q', pagination: { limit: bad } }), /pagination\.limit/);
    }
  });

  test('`pagination.cursor` is OUR token and decodes to the native `page`; anything else is refused, never page 1', async () => {
    // A cursor minted by the response shaper for page 2 / page 7 comes back as exactly that page.
    assert.deepEqual(await search({ query: 'q', pagination: { cursor: encodeSearchCursor(2) } }), { query: 'q', page: 2 });
    assert.deepEqual(
      await search({ query: 'q', pagination: { cursor: encodeSearchCursor(7), limit: 10 } }),
      { query: 'q', page: 7, page_size: 10 },
    );
    // The schema's published example IS a real cursor (page 2) — the fixture relies on it.
    assert.deepEqual(await search({ query: 'q', pagination: { cursor: SEARCH_CURSOR_EXAMPLE } }), { query: 'q', page: 2 });
    // Junk, a foreign token, a tampered page, an empty string, a non-string: refused. Treating any of these as
    // "start over" is the infinite-page loop, and it looks exactly like an infinite catalog.
    const forged = Buffer.from(JSON.stringify({ v: 1, page: 1 }), 'utf8').toString('base64url');   // page 1 is not a continuation
    const wrongVersion = Buffer.from(JSON.stringify({ v: 2, page: 3 }), 'utf8').toString('base64url');
    for (const bad of ['abc', 'opaque', forged, wrongVersion, 'eyJwYWdlIjozfQ', 12, null, { page: 2 }]) {
      assert.match(await refused({ query: 'q', pagination: { cursor: bad } }), /pagination\.cursor/);
    }
    // A BLANK cursor is not a token — it is a first-page request, and is absent, as for query/currency.
    assert.deepEqual(await search({ query: 'q', pagination: { cursor: '' } }), { query: 'q' });
    assert.deepEqual(await search({ query: 'q', pagination: { cursor: '   ', limit: 5 } }), { query: 'q', page_size: 5 });
  });

  test('`filters.available` becomes `in_stock_only` verbatim, and only when supplied', async () => {
    assert.deepEqual(await search({ query: 'q', filters: { available: false } }), { query: 'q', in_stock_only: false });
    assert.deepEqual(await search({ query: 'q', filters: { available: true } }), { query: 'q', in_stock_only: true });
    // Omitted => the native default (in-stock only) applies downstream; nothing is minted here.
    assert.deepEqual(await search({ query: 'q', filters: {} }), { query: 'q' });
    for (const bad of ['true', 1, null]) {
      assert.match(await refused({ query: 'q', filters: { available: bad } }), /filters\.available/);
    }
  });

  test('`filters.price` is MINOR units on the wire and MAJOR on the lane — by the currency exponent, not ÷100', async () => {
    // USD (default when context.currency is absent): cents -> dollars.
    assert.deepEqual(
      await search({ query: 'q', filters: { price: { min: 500, max: 2599 } } }),
      { query: 'q', price_min: 5, price_max: 25.99 },
    );
    // JPY is ZERO-decimal: 1500 minor units IS 1500 yen. A ÷100 mapper would filter to ¥15 — every real
    // product silently gone.
    assert.deepEqual(
      await search({ query: 'q', context: { currency: 'JPY' }, filters: { price: { min: 1500, max: 8000 } } }),
      { query: 'q', currency: 'JPY', price_min: 1500, price_max: 8000 },
    );
    // BHD is THREE-decimal: 1500 fils is 1.5 dinar.
    assert.deepEqual(
      await search({ query: 'q', context: { currency: 'BHD' }, filters: { price: { max: 1500 } } }),
      { query: 'q', currency: 'BHD', price_max: 1.5 },
    );
    // UGX and ISK are exponent 0 in ISO 4217 but 2 in the kernel's CHARGE table (Stripe divisibility). A UCP
    // filter is a counterparty amount "in minor units" = ISO, so 5000 UGX minor units is 5000 shillings — the
    // charge exponent would read it as 50 and hide every real product. isoMinorUnitExponent, not
    // minorUnitExponent, and this line is why.
    assert.deepEqual(
      await search({ query: 'q', context: { currency: 'UGX' }, filters: { price: { min: 5000, max: 20000 } } }),
      { query: 'q', currency: 'UGX', price_min: 5000, price_max: 20000 },
    );
    assert.deepEqual(
      await search({ query: 'q', context: { currency: 'ISK' }, filters: { price: { max: 3000 } } }),
      { query: 'q', currency: 'ISK', price_max: 3000 },
    );
    // …and LOWERCASE, because the currency is forwarded verbatim: a case-sensitive ISO table would fall
    // back to the charge exponent and reproduce the ×100 under-read one commit after fixing it.
    assert.deepEqual(
      await search({ query: 'q', context: { currency: 'ugx' }, filters: { price: { min: 5000 } } }),
      { query: 'q', currency: 'ugx', price_min: 5000 },
    );
    // Lower-case currency: the exponent lookup is case-insensitive; the code itself is forwarded trimmed,
    // otherwise verbatim (the native lane normalizes).
    assert.deepEqual(
      await search({ query: 'q', context: { currency: ' jpy ' }, filters: { price: { min: 300 } } }),
      { query: 'q', currency: 'jpy', price_min: 300 },
    );
    // One bound alone is fine; zero is a legal bound.
    assert.deepEqual(await search({ query: 'q', filters: { price: { min: 0 } } }), { query: 'q', price_min: 0 });
  });

  test('a price bound that is not a non-negative integer, or an inverted range, is refused — not answered empty', async () => {
    for (const bad of [-1, 1.5, '500', true, null]) {
      assert.match(await refused({ query: 'q', filters: { price: { min: bad } } }), /price\.min/);
      assert.match(await refused({ query: 'q', filters: { price: { max: bad } } }), /price\.max/);
    }
    assert.match(await refused({ query: 'q', filters: { price: { min: 2000, max: 1000 } } }), /min.*max|max.*min/);
    // …but an equal pair is a legal (point) range.
    assert.deepEqual(await search({ query: 'q', filters: { price: { min: 1000, max: 1000 } } }), { query: 'q', price_min: 10, price_max: 10 });
    for (const bad of ['500-2000', 5, [5, 20], null]) {
      assert.match(await refused({ query: 'q', filters: { price: bad } }), /filters\.price/);
    }
  });

  test('`context.currency` reaches the lane; an empty one is refused; other context members do not', async () => {
    assert.deepEqual(await search({ query: 'q', context: { currency: 'EUR' } }), { query: 'q', currency: 'EUR' });
    assert.deepEqual(
      await search({ query: 'q', context: { currency: 'EUR', address_country: 'FR', language: 'fr-FR', intent: 'gift' } }),
      { query: 'q', currency: 'EUR' },
    );
    // Blank is ABSENT, as for `query` — the schema types it as a string and a blank string is a string.
    assert.deepEqual(await search({ query: 'q', context: { currency: '' } }), { query: 'q' });
    assert.deepEqual(await search({ query: 'q', context: { currency: '   ' } }), { query: 'q' });
    // …and with a blank currency the price exponent is the default (USD), not something minted from ''.
    assert.deepEqual(
      await search({ query: 'q', context: { currency: '' }, filters: { price: { min: 500 } } }),
      { query: 'q', price_min: 5 },
    );
    for (const bad of [840, null, ['USD'], { code: 'USD' }]) {
      assert.match(await refused({ query: 'q', context: { currency: bad } }), /context\.currency/);
    }
  });

  test('`filters.categories` and `signals` are accepted and NEVER forwarded, whatever they carry', async () => {
    assert.deepEqual(
      await search({ query: 'q', filters: { categories: ['skincare', 'Serums'] } }),
      { query: 'q' },
    );
    // Signals are caller-identifying. The shared cache key is the allowlisted params, so if either of these
    // ever reached the params two shoppers' searches would stop sharing an entry — and an IP would sit in it.
    const params = await search({ query: 'q', signals: { 'dev.ucp.buyer_ip': '203.0.113.7', 'dev.ucp.user_agent': 'Minds/1.0' } });
    assert.deepEqual(params, { query: 'q' });
    assert.equal(JSON.stringify(params).includes('203.0.113.7'), false);
  });

  test('a fully-populated live body maps to exactly the documented native args and nothing else', async () => {
    // Every permissive sub-object — INCLUDING `price` — also carries an UNDECLARED member, and the exact
    // deepEqual below is what proves none of them is read. The review of this PR found the previous form
    // unpinned: a mapper reading `price.currency` for the exponent, or forwarding `pagination.page` as the
    // native `page`, stayed green because nothing sent an unknown member at those depths and asserted the
    // FULL output.
    const params = await search({
      query: '  niacinamide serum ',
      pagination: { cursor: encodeSearchCursor(3), limit: 20, page: 7, unknown_member: 'PAG_X' },
      filters: {
        categories: ['skincare'], available: true, unknown_member: 'FIL_X',
        price: { min: 1000, max: 4000, currency: 'JPY', unknown_member: 'PRC_X' },
      },
      context: {
        address_country: 'US', address_region: 'CA', postal_code: '94107', language: 'en-US', currency: 'USD',
        intent: 'buy', merchant_id: 'm_ctx', unknown_member: 'CTX_X',
      },
      signals: { 'dev.ucp.buyer_ip': '198.51.100.9', 'dev.ucp.user_agent': 'ua', unknown_member: 'SIG_X' },
    });
    assert.deepEqual(params, {
      query: 'niacinamide serum', page_size: 20, page: 3, price_min: 10, price_max: 40, in_stock_only: true, currency: 'USD',
    });
    // No merchant_id — the lane stays unscoped no matter how much arrives. `page` came from OUR cursor (3),
    // never from the undeclared `pagination.page: 7`; the exponent came from context.currency (USD), never
    // from a `price.currency` the live schema does not have.
    assert.equal(params.merchant_id, undefined);
  });
});

// ---- 8. the published schema IS the accepted shape --------------------------------------------------------------

describe('schema and mapper cannot drift', () => {
  // THE MAXIMAL BODIES ARE DERIVED FROM `inputSchema`, NOT WRITTEN BY HAND.
  //
  // They used to be hand-written, and that quietly re-opened the hole this section exists to close: a field
  // could be ADVERTISED and then refused by the mapper, because the hand-built body simply never contained it.
  // Confirmed by mutation — adding `checkout.fulfillment` to the published schema (a real field on the live
  // merchant, and the one this door still owes) left the entire suite green while the mapper refused every body
  // carrying it. Deriving the body from the schema makes "everything advertised is accepted" a fact about the
  // published contract rather than about the fixture.
  //
  // Every string leaf gets a sentinel naming its own PATH, so what survives into the canonical params is
  // attributable to an exact field.
  const sentinelFor = (path) => `S<${path}>`;

  // EVERY generator below REFUSES an unrecognised schema construct rather than falling through to a default.
  // That trap is the load-bearing part. An earlier version dispatched on `schema.type` with a `default:` arm,
  // and three constructs slipped straight through it — all three demonstrated green while advertising a field
  // the mapper never read:
  //   - `integer`/`boolean` leaves produced no sentinel at all, so the mapped/unmapped ledger could not see them
  //   - a node written `{ properties: {...}, additionalProperties: false }` with NO `type` collapsed to a
  //     single string leaf AND escaped the strictness walk, so its own `additionalProperties:false` was
  //     enforced nowhere
  //   - `oneOf`/`anyOf`/`allOf`/`$ref`, tuple-form `items: [...]` and union `type: [...]` all collapsed silently
  // A test fixture that quietly ignores what it cannot model is worse than no fixture: it reports green over
  // exactly the drift it was written to catch. So an unknown construct is now a loud failure, and whoever adds
  // one has to teach this generator about it.
  const describeSchema = (schema, path) => `${path || '<root>'}: ${JSON.stringify(schema).slice(0, 120)}`;

  /** The schema's effective type, refusing anything this fixture cannot faithfully model. */
  function kindOf(schema, path) {
    for (const combinator of ['oneOf', 'anyOf', 'allOf', 'not', '$ref']) {
      assert.ok(!(combinator in schema), `${describeSchema(schema, path)} uses \`${combinator}\`, which this fixture cannot model — teach maximalFor/sentinelLeaves/strictPaths about it`);
    }
    assert.ok(!Array.isArray(schema.type), `${describeSchema(schema, path)} uses a union \`type\`, which this fixture cannot model`);
    if (schema.type === undefined) {
      // An omitted `type` beside `properties`/`items` is a routine authoring slip, and silently treating the
      // node as a string is what let a strict object escape the walk. Infer it, and refuse if it is ambiguous.
      if (schema.properties || schema.additionalProperties !== undefined) return 'object';
      if (schema.items) return 'array';
      if (schema.enum) return 'enum';
      assert.fail(`${describeSchema(schema, path)} declares no \`type\` and none can be inferred`);
    }
    if (Array.isArray(schema.enum)) return 'enum';
    const known = ['object', 'array', 'string', 'integer', 'number', 'boolean'];
    assert.ok(known.includes(schema.type), `${describeSchema(schema, path)} has an unhandled type \`${schema.type}\``);
    return schema.type;
  }

  function maximalFor(schema, path = '') {
    switch (kindOf(schema, path)) {
      case 'enum': return schema.enum[0];
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
        assert.ok(!Array.isArray(schema.items), `${describeSchema(schema, path)} uses tuple-form \`items\`, which this fixture cannot model`);
        const count = Math.max(schema.minItems ?? 1, 1);
        return Array.from({ length: count }, () => maximalFor(schema.items ?? {}, `${path}[]`));
      }
      // Non-string leaves get a sentinel VALUE too — a distinctive number / the non-default boolean — so the
      // ledger below can see them. Previously they were invisible and could be advertised-and-unread forever.
      // A `minimum` of 0 is NOT a distinctive marker ("0" is a substring of half the numbers a mapper can
      // emit), so it falls through to the sentinel, which is still schema-valid for a minimum of 0.
      case 'integer': case 'number': return schema.minimum || 424242;
      case 'boolean': return true;
      // A string leaf whose VALID values are constrained beyond `type` (an opaque cursor this door itself
      // minted) declares a real one in the schema's `examples` — a standard JSON Schema annotation, not a
      // constraint — and the fixture sends that, so "a maximal schema-valid body is ACCEPTED" stays true.
      default: return typeof schema.examples?.[0] === 'string' ? schema.examples[0] : sentinelFor(path);
    }
  }

  /** Every leaf path in a generated body, paired with the value that marks it. */
  function sentinelLeaves(schema, path = '') {
    switch (kindOf(schema, path)) {
      // An enum leaf carries no unique marker (its value is fixed by the schema), so it cannot be tracked by
      // value. It is asserted directly by the contract suite instead — see the note on `method` below.
      case 'enum': return [];
      case 'object': {
        const entries = Object.entries(schema.properties ?? {});
        if (entries.length === 0 && schema.additionalProperties !== false) {
          const p = path ? `${path}.*` : '*';
          return [{ path: p, marker: sentinelFor(p) }];
        }
        return entries.flatMap(([name, sub]) => sentinelLeaves(sub, path ? `${path}.${name}` : name));
      }
      case 'array': return sentinelLeaves(schema.items ?? {}, `${path}[]`);
      case 'integer': case 'number': return [{ path, marker: String(schema.minimum || 424242) }];
      case 'boolean': return [{ path, marker: 'true' }];
      default: return [{ path, marker: typeof schema.examples?.[0] === 'string' ? schema.examples[0] : sentinelFor(path) }];
    }
  }

  const opFor = (tool) => canonicalOpForUcpTool(tool);
  const schemaFor = (tool) => UCP_INPUT_SCHEMAS[opFor(tool).id];

  // BUILT LAZILY, INSIDE TESTS — never in this `describe` body. `node --test` (v24) reports a throwing
  // describe callback as a failure and then EXITS 0, so a fixture that blew up at suite-construction time
  // would print red locally and pass CI silently. Every trap in the generators above would have been
  // unenforceable in exactly the automation it exists for. Reproduced minimally before this was written; the
  // test immediately below is what gives those traps a home inside a real, counted test.
  let cache = null;
  const MAXIMAL = () => (cache ??= Object.fromEntries(
    ucpCommerceToolDefinitions.map((def) => [def.name, maximalFor(schemaFor(def.name))]),
  ));

  test('every published schema uses only constructs this fixture can faithfully model', () => {
    // The home for the generators' unknown-construct traps. A schema written with `oneOf`, a tuple `items`, a
    // union `type`, or a node with no `type` at all fails HERE, loudly and with a non-zero exit — instead of
    // being silently collapsed into a single string leaf and leaving the fields beneath it unchecked.
    assert.doesNotThrow(() => MAXIMAL());
    for (const def of ucpCommerceToolDefinitions) {
      assert.doesNotThrow(() => sentinelLeaves(schemaFor(def.name)), `${def.name}: leaves must be enumerable`);
    }
  });

  test('the derived maximal bodies really are the live wire shapes (the derivation is not vacuous)', () => {
    // A generator that silently produced `{}` would make every test below pass while asserting nothing. Pin
    // the shapes that matter against the live merchant's spelling, so the derivation itself is load-bearing.
    assert.equal(MAXIMAL().create_checkout.checkout.line_items.length, 1);
    assert.equal(MAXIMAL().create_checkout.checkout.line_items[0].item.id, 'S<checkout.line_items[].item.id>');
    assert.equal(MAXIMAL().create_checkout.checkout.line_items[0].quantity, 1);
    assert.equal(MAXIMAL().update_checkout.id, 'S<id>');
    assert.equal(MAXIMAL().get_product.catalog.id, 'S<catalog.id>');
    assert.equal(MAXIMAL().search_catalog.catalog.query, 'S<catalog.query>');
    // The payment envelope's discriminator comes from the schema's own enum, not from this file.
    assert.equal(MAXIMAL().complete_checkout.checkout.payment.method, 'ucp_handler');
    assert.equal(MAXIMAL().complete_checkout.checkout.payment.token, 'S<checkout.payment.token>');
  });

  test('every published UCP tool has a UCP schema and an argument mapping', () => {
    assert.equal(ucpCommerceToolDefinitions.length, 6);
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
      // …and the native search's flat top-level `query` / `merchant_id`: on the wire the query is nested.
      assert.equal(def.inputSchema.properties.query, undefined);
      assert.equal(def.inputSchema.properties.merchant_id, undefined);
      assert.ok(MAXIMAL()[def.name], `${def.name} needs a maximal body in this test`);
    }
  });

  test('a maximal schema-valid body is ACCEPTED by the mapper for every tool', () => {
    for (const def of ucpCommerceToolDefinitions) {
      assert.doesNotThrow(
        () => ucpToNativeToolArgs(opFor(def.name), MAXIMAL()[def.name]),
        `${def.name}: a body built to the published schema must map`,
      );
    }
  });

  test('every field the schema declares REQUIRED is enforced by the mapper', () => {
    for (const def of ucpCommerceToolDefinitions) {
      for (const field of def.inputSchema.required) {
        const body = { ...MAXIMAL()[def.name] };
        delete body[field];
        assert.throws(
          () => ucpToNativeToolArgs(opFor(def.name), body),
          `${def.name}: dropping the required \`${field}\` must be refused`,
        );
      }
      // …and the same for meta's own required member, which is where the idempotency key lives.
      const metaRequired = def.inputSchema.properties.meta.required ?? [];
      for (const field of metaRequired) {
        const meta = { ...MAXIMAL()[def.name].meta };
        delete meta[field];
        assert.throws(
          () => ucpToNativeToolArgs(opFor(def.name), { ...MAXIMAL()[def.name], meta }),
          `${def.name}: dropping the required \`meta.${field}\` must be refused`,
        );
      }
    }
  });

  test('additionalProperties:false is enforced by the mapper at EVERY depth, not just advertised', () => {
    // Walk the schema for every strict object ANYWHERE — including through arrays — and prove the mapper
    // refuses an undeclared member there. Restricting this to top-level `properties` (as it did) left the
    // strict objects inside `checkout.line_items[]` and `.item` unguarded: deleting BOTH their `rejectUnknown`
    // calls left the entire suite green. A guard no test can kill is not a guard.
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
          () => ucpToNativeToolArgs(opFor(def.name), injectAt(MAXIMAL()[def.name], path)),
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
    // Every member of a `destinations[]` entry EXCEPT its `id` must survive: this is the destination mapping,
    // and a field that stopped surviving would be one silently dropped out of a shipping address.
    const DESTINATION_SURVIVES = [
      'first_name', 'last_name', 'phone_number', 'street_address', 'extended_address',
      'address_locality', 'address_region', 'postal_code', 'address_country',
    ].map((f) => `checkout.fulfillment.methods[].destinations[].${f}`);

    // A leaf that survives TRANSFORMED cannot be found by its raw marker: `filters.price.min/max` arrive in
    // MINOR units (marker 424242) and leave in MAJOR units (4242.42 under the default USD exponent). The
    // transform is declared here, per leaf, so the ledger still asks "does THIS leaf reach the params?" —
    // and a mapper that divided by 1000, or forgot the currency exponent, changes the answer.
    const SURVIVES_AS = Object.freeze({
      'catalog.filters.price.min': (marker) => String(Number(marker) / 100),
      'catalog.filters.price.max': (marker) => String(Number(marker) / 100),
      // The cursor leaf is the schema's example (a real page-2 cursor) and survives as native `page: 2`.
      'catalog.pagination.cursor': (marker) => (marker === SEARCH_CURSOR_EXAMPLE ? '"page":2' : marker),
    });
    const markerFor = (leaf) => (SURVIVES_AS[leaf.path] ? SURVIVES_AS[leaf.path](leaf.marker) : leaf.marker);

    const EXPECTED_SURVIVING = Object.freeze({
      search_catalog: [
        'catalog.query', 'catalog.pagination.limit', 'catalog.pagination.cursor',
        'catalog.filters.price.min', 'catalog.filters.price.max', 'catalog.filters.available',
        'catalog.context.currency',
      ],
      get_product: ['catalog.id'],
      create_checkout: [
        'meta.idempotency-key', 'checkout.line_items[].item.id', 'checkout.line_items[].quantity',
        'checkout.buyer.email', ...DESTINATION_SURVIVES,
      ],
      update_checkout: [
        'meta.idempotency-key', 'id', 'checkout.line_items[].item.id', 'checkout.line_items[].quantity',
        'checkout.buyer.email', ...DESTINATION_SURVIVES,
      ],
      get_checkout: ['id'],
      complete_checkout: ['meta.idempotency-key', 'id', 'checkout.payment.token'],
    });

    for (const def of ucpCommerceToolDefinitions) {
      const mapped = JSON.stringify(ucpToNativeToolArgs(opFor(def.name), MAXIMAL()[def.name]));
      const declared = sentinelLeaves(schemaFor(def.name));
      const surviving = declared.filter((leaf) => mapped.includes(markerFor(leaf))).map((leaf) => leaf.path);
      // Set equality, not a one-way spot check: the complement (everything NOT listed) is asserted to be
      // absent from the canonical params by the same comparison.
      assert.deepEqual(
        surviving.sort(), [...EXPECTED_SURVIVING[def.name]].sort(),
        `${def.name}: the set of fields reaching the canonical args changed`,
      );
    }

    // And the unmapped set is DECLARED, not merely observed — so dropping a field from the mapper without
    // recording the decision fails this file rather than passing silently.
    //
    // MATCHED LEAF-EXACT, NOT BY ANCESTOR PREFIX. An earlier version let an entry cover any descendant, and
    // that blanket permit was a hole rather than a convenience: with `checkout.context` declared, a NEWLY
    // ADVERTISED `checkout.context.shipping_address` was silently accepted-and-unread with no test objecting
    // — on the one lane whose live blocker is a missing address. Every accepted-but-unread leaf now has to be
    // named, so the cost of adding a field is that someone classifies it.
    for (const def of ucpCommerceToolDefinitions) {
      const opId = opFor(def.name).id;
      const declaredUnmapped = UCP_ACCEPTED_BUT_UNMAPPED[opId];
      assert.ok(declaredUnmapped, `${def.name}: needs an UCP_ACCEPTED_BUT_UNMAPPED entry`);
      const mapped = JSON.stringify(ucpToNativeToolArgs(opFor(def.name), MAXIMAL()[def.name]));
      const unread = sentinelLeaves(schemaFor(def.name))
        // `meta` is protocol plumbing (the profile pointer, the idempotency key) rather than a checkout field.
        .filter((leaf) => !leaf.path.startsWith('meta.') && !mapped.includes(markerFor(leaf)))
        .map((leaf) => leaf.path);

      assert.deepEqual(
        [...unread].sort(), [...declaredUnmapped].sort(),
        `${def.name}: UCP_ACCEPTED_BUT_UNMAPPED must name EXACTLY the advertised leaves this door does not read`,
      );
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
      // search_catalog: same 2026-08-13 listing, read via the buyer client's `searchCatalog` note — required
      // ["meta","catalog"], and `catalog` declares no required member (a query-less call is legal).
      search_catalog: ['meta', 'catalog'],
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

    // …and the FULFILLMENT method, whose `required` GENUINELY DIFFERS between the two tools — verified in the
    // same 2026-08-13 listing. create_checkout's method requires `type`; update_checkout's requires
    // `line_item_ids` and additionally permits a method `id`. Publishing one shape for both would refuse a
    // conforming caller on whichever tool it got wrong, which is this module's whole failure mode.
    const LIVE_METHOD_REQUIRED = Object.freeze({
      create_checkout: ['type'],
      update_checkout: ['line_item_ids'],
    });

    for (const [tool, methodRequired] of Object.entries(LIVE_METHOD_REQUIRED)) {
      const def = ucpCommerceToolDefinitions.find((d) => d.name === tool);
      const method = def.inputSchema.properties.checkout.properties.fulfillment.properties.methods.items;
      assert.deepEqual([...method.required].sort(), [...methodRequired].sort(),
        `${tool}: published fulfillment method required must equal the live merchant's`);
      // The extra member is the OTHER live difference; asserted both ways so neither leaks into the wrong tool.
      assert.equal(Object.hasOwn(method.properties, 'id'), tool === 'update_checkout',
        `${tool}: only update_checkout's method carries an \`id\``);
    }

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
