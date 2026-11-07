// verifyCodeOnMerchantDoor: ONE code, ONE store variant at quantity 1, on the seller's own UCP door — the coupon
// verifier's check. What is pinned, and why:
//   - input is refused before any seller is contacted (host, variant, market, code content, currency);
//   - no door, or a seller that does not advertise discount codes on carts: no cart is built;
//   - the cart carries the code, the variant at quantity 1 and the market hint — never buyer data;
//   - applied / rejected / not_confirmed / not_priced are read exactly as the checkout door reads them;
//   - the code never reaches a log.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { verifyCodeOnMerchantDoor, verifyInputProblem, VERIFY_DOOR_CLIENT_OPTIONS } from '../src/ucpMerchantDoorPricing.js';

const GID = (n) => `gid://shopify/ProductVariant/${n}`;
const V = '44012345678901';
const ENDPOINT = 'https://brand.example/api/ucp/mcp';
const CART_URL = 'https://brand.example/cart/c/abc123?key=k';
const CODE = 'Save10';
const SELLER_TEXT = 'SELLER-TEXT-NEVER-FORWARDED';

function cart({ price = 2500, discount = 0, discounts, messages, currency = 'USD', lines } = {}) {
  const ls = lines || [[GID(V), 1, price]];
  const sub = ls.reduce((a, [, q, p]) => a + q * p, 0);
  const totals = [{ type: 'subtotal', amount: sub }];
  if (discount) totals.push({ type: 'items_discount', amount: -discount });
  totals.push({ type: 'total', amount: sub - discount });
  const payload = {
    id: 'gid://shopify/Cart/c1', currency, continue_url: CART_URL,
    line_items: ls.map(([gid, quantity, p], i) => ({ id: `l${i}`, item: { id: gid, title: SELLER_TEXT, price: p }, quantity,
      totals: [{ type: 'subtotal', amount: quantity * p }, { type: 'total', amount: quantity * p }] })),
    totals, ...(discounts ? { discounts } : {}), ...(messages ? { messages } : {}),
  };
  return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}

function fakeDoor({ endpoint = { mcpEndpoint: ENDPOINT, acceptsDiscountCodes: true }, create = () => cart() } = {}) {
  const calls = [];
  return {
    calls,
    async endpointFor(host) { calls.push(['discover', host]); return typeof endpoint === 'function' ? endpoint() : endpoint; },
    async createCart(ep, args) { calls.push(['create_cart', ep, structuredClone(args)]); return create(args); },
    async getCart() { throw new Error('a verification never re-reads'); },
  };
}
function fakeLog() {
  const lines = [];
  return { lines, info: (o) => lines.push(o), warn: (o) => lines.push(o) };
}
const base = { sellerHost: 'brand.example', variantGid: V, market: 'US', code: CODE, expectedCurrency: 'USD' };
const run = (over = {}, door = fakeDoor(), log) => verifyCodeOnMerchantDoor({ ...base, ...over, merchantDoor: door, log }).then((out) => ({ out, door }));

describe('input is refused before any seller is contacted', () => {
  const cases = {
    seller_host_invalid: [{ sellerHost: '10.0.0.1' }, { sellerHost: 'localhost' }, { sellerHost: 'https://brand.example' }, { sellerHost: 'Brand.example' }, { sellerHost: 'brand.example/x' }],
    // Our own estate and names that are never a merchant (review of gw#2552, P2-2).
    seller_host_refused: [{ sellerHost: 'mcp.pivota.cc' }, { sellerHost: 'gateway-42ogcsuwxq-uw.a.run.app' }, { sellerHost: 'metadata.google.internal' },
      { sellerHost: 'svc.default.svc.cluster.local' }, { sellerHost: 'printer.local' }, { sellerHost: 'app.localhost' }, { sellerHost: '169.254.169.254.nip.io' }, { sellerHost: 'x.sslip.io' }],
    discovery_host_mismatch: [{ discoveryHost: 'other.example' }, { discoveryHost: 'shop.brand.example' }],
    discovery_host_invalid: [{ discoveryHost: '10.0.0.1' }, { discoveryHost: 7 }],
    variant_invalid: [{ variantGid: 44012345678901 }, { variantGid: ['44012345678901'] }, { variantGid: '123' }, { variantGid: '12345' }, { variantGid: 'gid://shopify/Product/44012345678901' }, { variantGid: 'abc' }, { variantGid: undefined },
      // a gid buried in a longer string is not the variant (the shared parser would fish it out)
      { variantGid: 'https://x.example/?v=gid://shopify/ProductVariant/44012345678901' }, { variantGid: '44012345678901x' }],
    market_invalid: [{ market: 'us' }, { market: 'USA' }, { market: undefined }],
    code_invalid: [{ code: '   ' }, { code: 'A‮B' }, { code: 'X'.repeat(129) }, { code: 7 }],
    currency_invalid: [{ expectedCurrency: 'usd' }, { expectedCurrency: 'DOLLARS' }, { expectedCurrency: undefined }, { expectedCurrency: null }],
  };
  for (const [reason, overs] of Object.entries(cases)) {
    test(reason, async () => {
      for (const over of overs) {
        assert.equal(verifyInputProblem({ ...base, ...over }), reason, JSON.stringify(over));
        const { out, door } = await run(over);
        assert.deepEqual(out, { result: 'invalid', reason }, JSON.stringify(over));
        assert.equal(door.calls.length, 0);
      }
    });
  }
  test('a store variant gid or its bare id are both accepted; the www. form of the seller host is its discovery host', () => {
    assert.equal(verifyInputProblem({ ...base, variantGid: GID(V) }), null);
    assert.equal(verifyInputProblem(base), null);
    assert.equal(verifyInputProblem({ ...base, discoveryHost: 'www.brand.example' }), null);
    assert.equal(verifyInputProblem({ ...base, sellerHost: 'www.brand.example', discoveryHost: 'brand.example' }), null);
  });
});

describe('no cart unless the seller has a door that takes codes on carts', () => {
  test('no door: not_priced, no cart', async () => {
    const { out, door } = await run({}, fakeDoor({ endpoint: null }));
    assert.deepEqual(out, { result: 'not_priced', reason: 'no_seller_door' });
    assert.deepEqual(door.calls.map((c) => c[0]), ['discover']);
  });
  test('a seller that does not advertise codes on carts: not_evaluated, no cart', async () => {
    for (const endpoint of [ENDPOINT, { mcpEndpoint: ENDPOINT, acceptsDiscountCodes: false }]) {
      const { out, door } = await run({}, fakeDoor({ endpoint }));
      assert.deepEqual(out, { result: 'not_evaluated', reason: 'seller_does_not_advertise' });
      assert.deepEqual(door.calls.map((c) => c[0]), ['discover']);
    }
  });
  test('an endpoint the profile names on our own estate, a never-merchant name or plain http: no cart', async () => {
    for (const mcpEndpoint of ['https://svc-abc-uw.a.run.app/mcp', 'https://mcp.pivota.cc/ucp/mcp', 'http://brand.example/api/ucp/mcp',
      'https://metadata.google.internal/computeMetadata/v1', 'not a url']) {
      const { out, door } = await run({}, fakeDoor({ endpoint: { mcpEndpoint, acceptsDiscountCodes: true } }));
      assert.deepEqual(out, { result: 'not_priced', reason: 'endpoint_refused' }, mcpEndpoint);
      assert.deepEqual(door.calls.map((c) => c[0]), ['discover'], mcpEndpoint);
    }
  });

  test("the verifier's own client never carries the token tier and never retries", () => {
    assert.equal(VERIFY_DOOR_CLIENT_OPTIONS.allowTokenTier, false);
    assert.equal(VERIFY_DOOR_CLIENT_OPTIONS.retryAttempts, 0);
    assert.ok(Object.isFrozen(VERIFY_DOOR_CLIENT_OPTIONS));
  });

  test('discovery uses the discovery host when given, else the seller host', async () => {
    const a = await run({ discoveryHost: 'www.brand.example' });
    assert.equal(a.door.calls[0][1], 'www.brand.example');
    const b = await run();
    assert.equal(b.door.calls[0][1], 'brand.example');
  });
});

describe('the cart and the answer', () => {
  test('the cart: the variant at quantity 1, the market hint and the code; nothing else', async () => {
    const { door } = await run();
    assert.deepEqual(door.calls[1][2], { lineItems: [{ item: { id: GID(V) }, quantity: 1 }], context: { address_country: 'US' }, discountCodes: [CODE] });
  });

  test('APPLIED: amount, allocation and the seller totals', async () => {
    const create = () => cart({ discount: 500, discounts: { codes: [CODE], applied: [{ code: CODE, title: SELLER_TEXT, amount: 500, method: 'each', allocations: [{ path: '$.line_items[0]', amount: 500 }] }] } });
    const { out } = await run({}, fakeDoor({ create }));
    assert.deepEqual(out, {
      result: 'applied', reason: null, currency: 'USD',
      totals: { subtotal: 2500, discount: 500, total: 2000 }, unit_price: 2500,
      discount: { amount: 500, method: 'each', allocations: [{ path: '$.line_items[0]', amount: 500 }] },
      automatic: [],
    });
    assert.equal(JSON.stringify(out).includes(SELLER_TEXT), false);
  });

  test('REJECTED the way Shopify says it (no path, one code): the seller code', async () => {
    const create = () => cart({ discounts: { codes: [CODE], applied: [] }, messages: [{ type: 'warning', code: 'discount_code_invalid', content: SELLER_TEXT }] });
    const { out } = await run({}, fakeDoor({ create }));
    assert.equal(out.result, 'rejected');
    assert.equal(out.reason, 'discount_code_invalid');
    assert.equal(out.discount, null);
    assert.equal(out.totals.total, 2500);
  });

  test('NOT CONFIRMED: silent seller; applied entry the totals do not carry', async () => {
    const silent = await run({}, fakeDoor({ create: () => cart({ discounts: { codes: [CODE], applied: [] } }) }));
    assert.deepEqual([silent.out.result, silent.out.reason], ['not_confirmed', 'seller_did_not_apply']);
    const noRow = await run({}, fakeDoor({ create: () => cart({ discounts: { codes: [CODE], applied: [{ code: CODE, amount: 500 }] } }) }));
    assert.deepEqual([noRow.out.result, noRow.out.reason], ['not_confirmed', 'totals_show_no_discount']);
    const noBlock = await run({}, fakeDoor({ create: () => cart() }));
    assert.deepEqual([noBlock.out.result, noBlock.out.reason], ['not_confirmed', 'seller_did_not_apply']);
  });

  test('NOT PRICED: tool error, out of stock, wrong currency, a cart that is not this variant, a timeout', async () => {
    const err = await run({}, fakeDoor({ create: () => ({ ok: false, status: 503, error: { message: 'down' } }) }));
    assert.equal(err.out.result, 'not_priced');
    const oos = await run({}, fakeDoor({ create: () => cart({ messages: [{ type: 'error', code: 'out_of_stock' }] }) }));
    assert.deepEqual(oos.out, { result: 'not_priced', reason: 'out_of_stock' });
    const ccy = await run({ expectedCurrency: 'SGD' }, fakeDoor());
    assert.deepEqual(ccy.out, { result: 'not_priced', reason: 'cart_mismatch' });
    const other = await run({}, fakeDoor({ create: () => cart({ lines: [[GID('44012345678999'), 1, 2500]] }) }));
    assert.deepEqual(other.out, { result: 'not_priced', reason: 'cart_mismatch' });
    const slow = await verifyCodeOnMerchantDoor({ ...base, budgetMs: 30, merchantDoor: fakeDoor({ create: () => new Promise((r) => setTimeout(() => r(cart()), 200)) }) });
    assert.equal(slow.result, 'not_priced');
    assert.equal(slow.reason, 'timeout');
  });

  test('the code never reaches a log; the outcome does', async () => {
    const log = fakeLog();
    await run({}, fakeDoor({ create: () => cart({ discounts: { codes: [CODE], applied: [] }, messages: [{ type: 'warning', code: 'discount_code_expired' }] }) }), log);
    assert.equal(JSON.stringify(log.lines).toLowerCase().includes(CODE.toLowerCase()), false);
    assert.ok(log.lines.some((l) => l.outcome === 'verify' && l.result === 'rejected' && l.reason === 'discount_code_expired'));
  });
});
