'use strict';

// The merchant's checkout id was in `raw` all along and never lifted out.
//
// That single omission is why the card rail and the link rail looked like separate worlds:
// `CardIssueRequest` (pivota-backend routes/agent_cards.py) requires a UCP `checkout_id`, and
// `resolve_merchant_quote` reads the total via `get_checkout` against the merchant's own door —
// but nothing in this repo ever surfaced an id to hand it, even though `createCheckoutPreview`
// already calls `create_checkout` on that same door, from the same numeric variant identity the
// cart permalink is built from, and keeps the entire response.
//
// WHY IT MATTERS BEYOND TIDINESS. A pre-address checkout cannot carry shipping or tax (the
// backend audit's B7: `total === subtotal`, `shipping_options: []`, `tax: null`), so a card
// capped at a preview total is declined the moment an address is entered. Re-reading
// `get_checkout` on THIS id after the address is filled is the only way to learn a total that
// includes them. `continue_url` is where the agent types; `checkout_id` is what the cap is
// minted against. The pair is the handoff.
//
// The tests below pin both halves and, deliberately, the null cases: a merchant that names no id
// must yield `null`, never a fabricated or borrowed one.

const test = require('node:test');
const assert = require('node:assert');

const { createUcpBuyerAgentClient } = require('../src/services/ucpBuyerAgentClient.js');
const { pricedTotals } = require('../src/services/ucpWarmHandoffInternalRoute.js');

const { normalizePricedCheckout } = createUcpBuyerAgentClient({ env: {} });

// The MCP envelope the client's own unwrapper expects.
const wrap = (payload) => ({ content: [{ type: 'json', json: payload }] });

const PRICED = {
  line_items: [{ title: 'Toner', quantity: 1 }],
  subtotal: '4250',
  currency: 'USD',
  continue_url: 'https://brand.com/checkouts/cn/TOKEN',
};

test('the merchant id is lifted out of the payload', () => {
  const out = normalizePricedCheckout(wrap({ ...PRICED, id: 'gid://shopify/Checkout/abc123' }));
  assert.strictEqual(out.checkout_id, 'gid://shopify/Checkout/abc123');
});

test('a merchant naming it `checkout_id` is accepted too', () => {
  const out = normalizePricedCheckout(wrap({ ...PRICED, checkout_id: 'chk_789' }));
  assert.strictEqual(out.checkout_id, 'chk_789');
});

test('`id` wins over `checkout_id` when a merchant sends both', () => {
  // update_checkout's required top-level param is `id`, so that is the name the protocol uses.
  const out = normalizePricedCheckout(wrap({ ...PRICED, id: 'from_id', checkout_id: 'from_alias' }));
  assert.strictEqual(out.checkout_id, 'from_id');
});

test('no id means NULL, never a borrowed one', () => {
  // The failure that would matter: quietly substituting continue_url, a cart id, or a line-item
  // id would hand the mint a key that names something other than this checkout.
  const out = normalizePricedCheckout(wrap(PRICED));
  assert.strictEqual(out.checkout_id, null);
  assert.strictEqual(out.continue_url, 'https://brand.com/checkouts/cn/TOKEN');
});

test('the empty-payload shape carries the key, so the field never simply vanishes', () => {
  const out = normalizePricedCheckout(null);
  assert.ok('checkout_id' in out, 'callers destructure this shape; a missing key reads as undefined');
  assert.strictEqual(out.checkout_id, null);
});

test('lifting the id does not disturb what was already lifted', () => {
  const out = normalizePricedCheckout(wrap({ ...PRICED, id: 'chk_1' }));
  assert.strictEqual(out.subtotal, '4250');
  assert.strictEqual(out.currency, 'USD');
  assert.strictEqual(out.continue_url, 'https://brand.com/checkouts/cn/TOKEN');
  assert.ok(out.raw, 'raw is still kept');
});

// ---------------------------------------------------------------- the projection the route ships

test('pricedTotals projects the id so a caller can mint against it', () => {
  const out = pricedTotals({ subtotal: '4250', currency: 'USD', checkout_id: 'chk_42' });
  assert.strictEqual(out.checkout_id, 'chk_42');
});

test('pricedTotals trims, and refuses anything that is not a usable string', () => {
  assert.strictEqual(
    pricedTotals({ subtotal: '4250', currency: 'USD', checkout_id: '  chk_42  ' }).checkout_id,
    'chk_42',
  );
  for (const bad of ['', '   ', 42, null, undefined, {}, []]) {
    const out = pricedTotals({ subtotal: '4250', currency: 'USD', checkout_id: bad });
    assert.strictEqual(out.checkout_id, null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('an absent id does not suppress the totals themselves', () => {
  // The money answer and the mint key are independent; losing one must not lose the other.
  const out = pricedTotals({ subtotal: '4250', currency: 'USD' });
  assert.strictEqual(out.subtotal_minor, 4250);
  assert.strictEqual(out.currency, 'USD');
  assert.strictEqual(out.checkout_id, null);
});


// ------------------------------------------------------- the hop that actually delivers it

test('the id survives the REAL warm-handoff preview builder, not just the normalizer', async () => {
  // THE TEST THAT WOULD HAVE CAUGHT THE FIRST CUT OF THIS CHANGE. `buildPreview` in
  // ucpWarmHandoff.js copies a HARD-CODED WHITELIST out of the client's normalized object, and
  // that copy — not the normalizer's return — is what the internal route receives as
  // `handoff.preview`. Lifting `checkout_id` in the client while omitting it from that whitelist
  // publishes a constant `null` from the route while every unit test stays green: the feature is
  // inert on the only path that delivers it.
  //
  // So this drives the REAL service with only the MCP transport faked, and asserts through to
  // the projection the route ships. A hand-built preview object cannot catch a whitelist.
  const { createWarmHandoffService, FLAG_ENV, INCHAT_PREVIEW_FLAG_ENV } =
    require('../src/services/ucpWarmHandoff.js');

  const prior = { [FLAG_ENV]: process.env[FLAG_ENV], [INCHAT_PREVIEW_FLAG_ENV]: process.env[INCHAT_PREVIEW_FLAG_ENV] };
  process.env[FLAG_ENV] = '1';
  process.env[INCHAT_PREVIEW_FLAG_ENV] = '1';
  try {
    // The fake stops at the transport: `priced` is produced by the REAL normalizer from a
    // spec-shaped payload, so the field names crossing each hop are the real ones.
    const priced = normalizePricedCheckout(wrap({
      ...PRICED,
      id: 'gid://shopify/Checkout/abc123',
    }));
    const client = {
      discoverEndpoint: async () => ({ ok: true, mcpEndpoint: 'https://brand.com/api/ucp/mcp' }),
      createCart: async () => ({ ok: true, cartId: 'cart_1' }),
      extractHandoffUrl: () => PRICED.continue_url,
      createCheckoutPreview: async () => ({ ok: true, priced, requires_escalation: true, tool_result: {} }),
    };
    const service = createWarmHandoffService({ client });
    const handoff = await service.resolveWarmHandoff({
      brandDomain: 'brand.com',
      variantGid: 'gid://shopify/ProductVariant/111',
    });

    assert.ok(handoff && handoff.preview, 'the lane produced no preview to assert on');
    assert.strictEqual(
      handoff.preview.checkout_id, 'gid://shopify/Checkout/abc123',
      'buildPreview dropped the id — the route can then only ever publish null',
    );
    assert.strictEqual(pricedTotals(handoff.preview).checkout_id, 'gid://shopify/Checkout/abc123');
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('a realistic payload full of OTHER ids still yields null when no checkout id is named', () => {
  // The first version of the "never borrowed" test used a fixture with no ids in it at all, so a
  // mutant that fell through to `cart_id` or a line-item id passed 9/9 — and would have handed the
  // card mint a VARIANT GID as a checkout id. Every id a real payload carries is present here.
  const out = normalizePricedCheckout(wrap({
    ...PRICED,
    cart_id: 'gid://shopify/Cart/CART',
    cart: { id: 'gid://shopify/Cart/NESTED' },
    line_items: [{ id: 'line_1', quantity: 1, item: { id: 'gid://shopify/ProductVariant/111' } }],
  }));
  assert.strictEqual(out.checkout_id, null);
});

test('our OWN door names it session_id, and that is not speculative', () => {
  // mcp-server/test/ucpFulfillmentAddressContract.test.js reads `created.session_id ?? created.id`
  // and feeds it to update_checkout's `id`. An `id`-only read returns null against Pivota itself.
  assert.strictEqual(normalizePricedCheckout(wrap({ ...PRICED, session_id: 'sess_1' })).checkout_id, 'sess_1');
  // ...but a merchant's own `id` still wins when both are present.
  assert.strictEqual(
    normalizePricedCheckout(wrap({ ...PRICED, id: 'chk_real', session_id: 'sess_1' })).checkout_id,
    'chk_real',
  );
});
