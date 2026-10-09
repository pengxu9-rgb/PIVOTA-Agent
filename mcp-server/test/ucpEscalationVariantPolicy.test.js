// What a UCP storefront escalation does when the store no longer sells the variant the catalog names.
//
// Live 2026-10-09: judydoll's own UCP door answered create_cart with variant_invalid for the catalog's variant; store
// pricing fell back to the catalog, and the escalation handed out a continue_url naming that variant (the page was
// gone too). Pinned here:
//   - the seller door reports a STRUCTURED variant_invalid to its caller, and nothing else (an HTML "Page not found"
//     or a re-read is not a claim about a variant);
//   - the store's own product page decides: gone refuses; a variant the page does not list is dropped from a direct
//     link with a warning; a variant the BUYER chose is refused only when the door ALSO said variant_invalid;
//   - create and re-read hand out the same link; with the switch OFF nothing changes (the door's word is still logged).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  UCP_ESCALATION_FLAG,
  VARIANT_POLICY_FLAG,
  variantPolicyEnabled,
  encodeEscalationId,
  tryEscalateUcpCheckout,
} from '../src/ucpCheckoutEscalation.js';
import { MERCHANT_PRICING_FLAG, priceOnMerchantDoor } from '../src/ucpMerchantDoorPricing.js';

const ESC = { [UCP_ESCALATION_FLAG]: '1' };
const POLICY = { ...ESC, [VARIANT_POLICY_FLAG]: '1' };
const PRICED_POLICY = { ...POLICY, [MERCHANT_PRICING_FLAG]: '1' };
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const STALE = '49869804110101';
const CURRENT = '51000000000001';
const LINK = `https://judydoll.com/products/glow-highlighter?variant=${STALE}&utm_source=pivota&utm_medium=affiliate`;

// One seller variant on the row (its own seller id), and the link naming it.
const ROW = Object.freeze({
  product_id: 'sig_judydoll_glow', title: 'Glow Highlighter', price: 12.99, currency: 'USD',
  merchant_id: 'merch_obs_a25cbba37ef98c52', external_redirect_url: LINK,
  variants: [{ variant_id: 'sig_judydoll_glow', source_variant_id: STALE }],
});
// Two shades; the buyer picks one by id.
const SHADES = Object.freeze({
  ...ROW, product_id: 'sig_judydoll_shades', external_redirect_url: 'https://judydoll.com/products/shades',
  variants: [
    { variant_id: 'shade_01', title: 'Shade 01', source_variant_id: STALE },
    { variant_id: 'shade_02', title: 'Shade 02', source_variant_id: '49869804110102' },
  ],
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
const rejected = (p) => p.then(() => null, (e) => e);

/** A page reader double: `pages[handle]` is the store's answer; records every URL asked. */
function reader(pages) {
  const asked = [];
  const read = async (url) => {
    asked.push(url);
    const u = new URL(url);
    const handle = u.pathname.split('/').pop();
    const answer = pages[handle] || { state: 'unknown' };
    return { reason: 'x', host: u.hostname, handle, ...answer };
  };
  read.asked = asked;
  return read;
}
const live = (...ids) => ({ state: 'live', variantIds: new Set(ids) });
function recordingLog() {
  const lines = [];
  return { lines, info: (d) => lines.push(d), warn: (d) => lines.push(d) };
}
/** A seller door whose create_cart answers a structured "variant not found" tool error. */
function variantInvalidDoor() {
  return {
    async endpointFor() { return 'https://judydoll.com/api/ucp/mcp'; },
    async createCart() { return { ok: true, status: 200, error: { message: 'Variant not found' } }; },
    async getCart() { throw new Error('unused'); },
  };
}

const create = ({ row = ROW, items, env = POLICY, storefrontPage, merchantDoor, log } = {}) => tryEscalateUcpCheckout({
  op: CREATE, ctx: {}, ucpArgs: {}, now: NOW, env, storefrontPage, merchantDoor, log,
  params: { idempotency_key: 'idem-variant-1', quote: { items: items || [{ product_id: row.product_id, quantity: 1 }] } },
  executor: executorWith({ [row.product_id]: row }),
});

describe('the seller door reports what it was told', () => {
  const rows = new Map([[ROW.product_id, ROW]]);
  const base = (over = {}) => ({
    items: [{ product_id: ROW.product_id, quantity: 1 }], rows, sellerHost: 'judydoll.com', env: { [MERCHANT_PRICING_FLAG]: '1' }, ...over,
  });
  const doorAnswering = (answer) => ({
    async endpointFor() { return 'https://judydoll.com/api/ucp/mcp'; },
    async createCart() { return answer; },
    async getCart() { return answer; },
  });

  test('a structured variant_invalid is reported with every line, and still falls back', async () => {
    const signals = [];
    const out = await priceOnMerchantDoor(base({ merchantDoor: variantInvalidDoor(), signals }));
    assert.equal(out, null);
    assert.deepEqual(signals, [{ reason: 'variant_invalid', lines: [{ product_id: ROW.product_id, gid: `gid://shopify/ProductVariant/${STALE}`, chosen: false }] }]);
  });

  test('a non-2xx "Page not found", an outage, or a re-read is NOT reported', async () => {
    for (const answer of [
      { ok: false, status: 404, error: { message: 'Page not found. Redirecting...' } },
      { ok: false, status: 503, error: { message: 'Service Unavailable' } },
      { ok: true, status: 200, error: { message: 'Product temporarily unavailable' } },
    ]) {
      const signals = [];
      await priceOnMerchantDoor(base({ merchantDoor: doorAnswering(answer), signals }));
      assert.deepEqual(signals, [], JSON.stringify(answer));
    }
    const signals = [];
    await priceOnMerchantDoor(base({ merchantDoor: doorAnswering({ ok: true, status: 200, error: { message: 'Variant not found' } }), signals, cartId: 'gid://shopify/Cart/c1' }));
    assert.deepEqual(signals, [], 'a get_cart re-read is not a claim about a variant');
  });
});

describe('the switch', () => {
  test('OFF by default; truthy spellings only', () => {
    assert.equal(variantPolicyEnabled({}), false);
    for (const v of ['1', 'true', 'on', ' YES ']) assert.equal(variantPolicyEnabled({ [VARIANT_POLICY_FLAG]: v }), true, v);
  });

  test('OFF: no page is read, the link is today\'s, and the door\'s variant_invalid is still logged as a refresh hint', async () => {
    const read = reader({ 'glow-highlighter': live(CURRENT) });
    const log = recordingLog();
    const out = await create({ env: { ...ESC, [MERCHANT_PRICING_FLAG]: '1' }, storefrontPage: read, merchantDoor: variantInvalidDoor(), log });
    assert.equal(read.asked.length, 0);
    assert.equal(out.continue_url, LINK);
    assert.equal(out.messages.length, 1);
    const hint = log.lines.find((l) => l.event === 'ucp_storefront_page_check');
    assert.equal(hint.reason, 'door_variant_invalid');
    assert.equal(hint.outcome, 'not_checked');
  });
});

describe('ON: the store\'s own page decides', () => {
  test('the page no longer lists the catalog\'s variant: the link drops it, and the checkout says why', async () => {
    const log = recordingLog();
    const out = await create({ env: PRICED_POLICY, storefrontPage: reader({ 'glow-highlighter': live(CURRENT) }), merchantDoor: variantInvalidDoor(), log });
    assert.equal(out.status, 'requires_escalation');
    const url = new URL(out.continue_url);
    assert.equal(url.pathname, '/products/glow-highlighter');
    assert.equal(url.searchParams.has('variant'), false, 'the stale variant is still on the link');
    assert.equal(url.searchParams.get('utm_source'), 'pivota', 'attribution is kept');
    const warning = out.messages.find((m) => m.code === 'checkout.storefront_variant_not_listed');
    assert.equal(warning.type, 'warning');
    assert.match(warning.content, /sig_judydoll_glow/);
    const hint = log.lines.find((l) => l.event === 'ucp_storefront_page_check');
    assert.deepEqual(hint.stale_variants, [{ handle: 'glow-highlighter', variant: STALE }]);
    assert.equal(hint.door_variant_invalid, true);
  });

  test('the page itself is the trigger: with no door at all the same stale variant is dropped', async () => {
    const out = await create({ storefrontPage: reader({ 'glow-highlighter': live(CURRENT) }) });
    assert.equal(new URL(out.continue_url).searchParams.has('variant'), false);
  });

  test('the page still lists the variant: the link and the answer are unchanged, and a door disagreement is logged', async () => {
    const log = recordingLog();
    const out = await create({ env: PRICED_POLICY, storefrontPage: reader({ 'glow-highlighter': live(STALE, CURRENT) }), merchantDoor: variantInvalidDoor(), log });
    assert.equal(out.continue_url, LINK);
    assert.equal(out.messages.length, 1);
    assert.equal(log.lines.find((l) => l.event === 'ucp_storefront_page_check').outcome, 'variant_listed');
  });

  test('an unreadable page changes nothing', async () => {
    const out = await create({ storefrontPage: reader({}) });
    assert.equal(out.continue_url, LINK);
  });

  test('a gone page refuses by name, as the dead-page check does', async () => {
    const err = await rejected(create({ env: PRICED_POLICY, storefrontPage: reader({ 'glow-highlighter': { state: 'gone' } }), merchantDoor: variantInvalidDoor() }));
    assert.equal(err.code, 'NO_MERCHANT_OFFER');
    assert.equal(err.detail.reason, 'ucp_storefront_product_gone');
  });

  test('a BUYER-CHOSEN option is refused only when the door AND the page both say it is gone', async () => {
    const items = [{ product_id: SHADES.product_id, quantity: 1, variant_id: 'shade_01' }];
    const pages = { shades: live('49869804110102') };
    const err = await rejected(create({ row: SHADES, items, env: PRICED_POLICY, storefrontPage: reader(pages), merchantDoor: variantInvalidDoor() }));
    assert.ok(err, 'a checkout was built for an option the store no longer sells');
    assert.equal(err.code, 'NO_MERCHANT_OFFER');
    assert.equal(err.detail.reason, 'ucp_storefront_variant_gone');
    assert.deepEqual(err.detail.acp_detail.storefront_items, ['sig_judydoll_shades::v::shade_01']);
    // the page alone (no door said so): warned, not refused
    const out = await create({ row: SHADES, items, storefrontPage: reader(pages) });
    assert.equal(out.status, 'requires_escalation');
    assert.ok(out.messages.some((m) => m.code === 'checkout.storefront_variant_not_listed'));
  });

  test('a re-read hands out the SAME link the create did', async () => {
    const pages = { 'glow-highlighter': live(CURRENT) };
    const made = await create({ storefrontPage: reader(pages) });
    const again = await tryEscalateUcpCheckout({
      op: GET, params: { session_id: encodeEscalationId([{ product_id: ROW.product_id, quantity: 1 }]) }, ctx: {}, ucpArgs: {},
      now: NOW, env: POLICY, storefrontPage: reader(pages), executor: executorWith({ [ROW.product_id]: ROW }),
    });
    assert.equal(again.continue_url, made.continue_url);
    assert.deepEqual(again.messages, made.messages);
  });

  test('a signed Pivota hop is never edited; it is handed out with the warning', async () => {
    const hop = `https://api.pivota.cc/r?token=${Buffer.from(JSON.stringify({ dest: LINK }), 'utf8').toString('base64url')}.c2ln`;
    const read = reader({ 'glow-highlighter': live(CURRENT) });
    const out = await create({ row: { ...ROW, external_redirect_url: hop }, storefrontPage: read });
    assert.equal(out.continue_url, hop);
    assert.deepEqual(read.asked, [LINK], 'the hop is checked at its destination');
    assert.ok(out.messages.some((m) => m.code === 'checkout.storefront_variant_not_listed'));
  });
});
