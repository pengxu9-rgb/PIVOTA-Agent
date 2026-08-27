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
