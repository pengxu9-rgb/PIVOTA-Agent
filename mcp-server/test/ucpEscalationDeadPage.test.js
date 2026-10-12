// The UCP storefront escalation must not hand a buyer a continue_url to a product page the store says is gone.
//
// Live 2026-10-09: judydoll removed "Sheer Tinted Highlighter"; its UCP door rejected the variant, store pricing fell
// back to the catalog price, and the escalation answered `requires_escalation` with a continue_url to the 404.
// Pinned here: the check is behind its own switch (OFF = byte-identical answer, no read); only `gone` refuses, and
// it refuses by name; a hop link is checked at its destination; a seller-priced checkout is never checked; a re-read
// is checked exactly like a create.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  UCP_ESCALATION_FLAG,
  DEAD_PAGE_CHECK_FLAG,
  deadPageCheckEnabled,
  encodeEscalationId,
  tryEscalateUcpCheckout,
} from '../src/ucpCheckoutEscalation.js';
import { MERCHANT_PRICING_FLAG } from '../src/ucpMerchantDoorPricing.js';

const ESC = { [UCP_ESCALATION_FLAG]: '1' };
const CHECK = { ...ESC, [DEAD_PAGE_CHECK_FLAG]: '1' };
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const PAGE = 'https://judydoll.com/products/sheer-tinted-highlighter?variant=49869804110101&utm_source=pivota&utm_medium=affiliate';

const REMOVED = Object.freeze({
  product_id: 'sig_d4f93c2b9b88ac7bd32f44d13ebe9d31', title: 'Sheer Tinted Highlighter', brand: 'Judydoll',
  price: 12.99, currency: 'USD', merchant_id: 'merch_obs_a25cbba37ef98c52', external_redirect_url: PAGE,
});
const SIBLING = Object.freeze({
  ...REMOVED, product_id: 'sig_judydoll_live', title: 'Glow Magnify Highlighter',
  external_redirect_url: 'https://judydoll.com/products/judydoll-glow-magnify-highlighter',
});

function executorWith(rowsById) {
  return {
    async execute(op, params) {
      if (op === 'get_product') {
        const row = rowsById[params.payload.product.product_id];
        return row ? { product: structuredClone(row) } : { product: null };
      }
      return { session_id: 'q_kernel' };
    },
  };
}
const CREATE = { id: 'create_checkout_session', capability: 'checkout' };
const GET = { id: 'get_checkout_session', capability: 'checkout' };
const createParams = (...ids) => ({ idempotency_key: 'idem-dead-page-1', quote: { items: ids.map((product_id) => ({ product_id, quantity: 1 })) } });
const rejected = (p) => p.then(() => null, (e) => e);

/** A page reader double: answers by handle, records every URL it was asked about. */
function reader(states) {
  const asked = [];
  const read = async (url) => {
    asked.push(url);
    const handle = new URL(url).pathname.split('/').pop();
    const state = states[handle] || 'live';
    return { state, reason: state === 'gone' ? 'http_404' : 'ok', host: new URL(url).hostname, handle };
  };
  read.asked = asked;
  return read;
}
function recordingLog() {
  const lines = [];
  return { lines, info: (d) => lines.push(d), warn: (d) => lines.push(d) };
}

const run = ({ op = CREATE, ids = [REMOVED.product_id], env = CHECK, storefrontPage, log, rows = { [REMOVED.product_id]: REMOVED, [SIBLING.product_id]: SIBLING }, params, merchantDoor } = {}) =>
  tryEscalateUcpCheckout({
    op, params: params || createParams(...ids), ctx: {}, executor: executorWith(rows), ucpArgs: {}, now: NOW, env,
    storefrontPage, log, merchantDoor,
  });

describe('the switch', () => {
  test('OFF by default; truthy spellings only', () => {
    assert.equal(deadPageCheckEnabled({}), false);
    assert.equal(deadPageCheckEnabled({ [DEAD_PAGE_CHECK_FLAG]: '0' }), false);
    for (const v of ['1', 'true', 'on', ' YES ']) assert.equal(deadPageCheckEnabled({ [DEAD_PAGE_CHECK_FLAG]: v }), true, v);
  });

  test('OFF: no page is read and the answer is exactly today\'s, dead link included', async () => {
    const read = reader({ 'sheer-tinted-highlighter': 'gone' });
    const out = await run({ env: ESC, storefrontPage: read });
    assert.equal(read.asked.length, 0);
    assert.equal(out.status, 'requires_escalation');
    assert.equal(out.continue_url, PAGE);
  });
});

describe('ON: only the store saying "gone" refuses', () => {
  test('a gone page refuses the checkout by name, terminally, naming the item and the seller', async () => {
    const log = recordingLog();
    const err = await rejected(run({ storefrontPage: reader({ 'sheer-tinted-highlighter': 'gone' }), log }));
    assert.ok(err, 'a checkout was built for a gone page');
    assert.equal(err.code, 'NO_MERCHANT_OFFER');
    assert.equal(err.detail.reason, 'ucp_storefront_product_gone');
    assert.deepEqual(err.detail.acp_detail.storefront_items, [REMOVED.product_id]);
    assert.deepEqual(err.detail.acp_detail.seller_hosts, ['judydoll.com']);
    assert.match(err.detail.acp_message, /no longer has a product page/);
    assert.match(err.detail.acp_message, /will not change on retry/);
    // the refresh hint: which handle to re-verify, and no buyer data
    const line = log.lines.find((l) => l.event === 'ucp_storefront_page_check');
    assert.deepEqual(line.handles, ['sheer-tinted-highlighter']);
    assert.equal(line.outcome, 'refused');
  });

  test('the page asked about is the row\'s own storefront link', async () => {
    const read = reader({});
    await run({ storefrontPage: read });
    assert.deepEqual(read.asked, [PAGE]);
  });

  test('a live page, or one that could not be read, hands out the link exactly as before', async () => {
    for (const state of ['live', 'unknown']) {
      const out = await run({ storefrontPage: reader({ 'sheer-tinted-highlighter': state }) });
      assert.equal(out.status, 'requires_escalation', state);
      assert.equal(out.continue_url, PAGE, state);
    }
  });

  test('a reader that throws is not a refusal', async () => {
    const out = await run({ storefrontPage: async () => { throw new Error('boom'); } });
    assert.equal(out.continue_url, PAGE);
  });

  test('one gone line in a one-seller cart refuses the cart, naming only that line', async () => {
    const err = await rejected(run({ ids: [SIBLING.product_id, REMOVED.product_id], storefrontPage: reader({ 'sheer-tinted-highlighter': 'gone' }) }));
    assert.equal(err.detail.reason, 'ucp_storefront_product_gone');
    assert.deepEqual(err.detail.acp_detail.storefront_items, [REMOVED.product_id]);
  });

  test('a Pivota hop link is checked at its DESTINATION, never at api.pivota.cc', async () => {
    const hop = `https://api.pivota.cc/r?token=${Buffer.from(JSON.stringify({ dest: PAGE }), 'utf8').toString('base64url')}.c2ln`;
    const read = reader({ 'sheer-tinted-highlighter': 'gone' });
    const err = await rejected(run({ storefrontPage: read, rows: { [REMOVED.product_id]: { ...REMOVED, external_redirect_url: hop } } }));
    assert.deepEqual(read.asked, [PAGE]);
    assert.equal(err.detail.reason, 'ucp_storefront_product_gone');
  });

  test('a re-read (get_checkout) of an escalation whose page has since gone is refused the same way', async () => {
    const sessionId = encodeEscalationId([{ product_id: REMOVED.product_id, quantity: 1 }]);
    const err = await rejected(run({ op: GET, params: { session_id: sessionId }, storefrontPage: reader({ 'sheer-tinted-highlighter': 'gone' }) }));
    assert.equal(err.detail.reason, 'ucp_storefront_product_gone');
    const ok = await run({ op: GET, params: { session_id: sessionId }, storefrontPage: reader({}) });
    assert.equal(ok.continue_url, PAGE);
  });
});

describe('a seller-priced checkout is not checked', () => {
  test('the seller built a cart for the variant, so the product exists: no page read', async () => {
    const GID = 'gid://shopify/ProductVariant/49869804110101';
    const cartUrl = 'https://judydoll.com/cart/c/abc?key=k';
    const payload = {
      id: 'gid://shopify/Cart/c1', currency: 'USD', continue_url: cartUrl,
      line_items: [{ id: 'l0', item: { id: GID, title: 't', price: 1299 }, quantity: 1,
        totals: [{ type: 'subtotal', amount: 1299 }, { type: 'total', amount: 1299 }] }],
      totals: [{ type: 'subtotal', amount: 1299 }, { type: 'total', amount: 1299 }],
    };
    const merchantDoor = {
      async endpointFor() { return 'https://judydoll.com/api/ucp/mcp'; },
      async createCart() { return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } }; },
      async getCart() { throw new Error('unused'); },
    };
    const read = reader({ 'sheer-tinted-highlighter': 'gone' });
    const row = { ...REMOVED, variants: [{ variant_id: REMOVED.product_id, source_variant_id: '49869804110101' }] };
    const out = await run({
      env: { ...CHECK, [MERCHANT_PRICING_FLAG]: '1' }, storefrontPage: read, merchantDoor,
      rows: { [REMOVED.product_id]: row },
    });
    assert.ok(out.continue_url.startsWith(cartUrl), out.continue_url); // the seller's cart (attribution appended)
    assert.equal(read.asked.length, 0);
  });
});
