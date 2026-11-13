// The market a native create names goes with its quote (commerceToolSurface.js step 3c; mcpStorefrontCart.js,
// kernelQuoteMarketParams). At the tool surface, over a recording executor: exactly what the executor is handed, on
// which door and for which operation. The rule the executor then applies is pinned in
// safety-kernel/test/quoteMarketCurrency.test.js, and the real doors in
// tests/kernel_row_market_currency_door.node.test.cjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createCommerceToolSurface, ucpDialectSurface } from '../src/commerceToolSurface.js';
import { kernelQuoteMarketParams, mcpStorefrontCartSurface, MCP_STOREFRONT_ESCALATION_FLAG } from '../src/mcpStorefrontCart.js';
import { CURRENCY_FOLLOWS_MARKET_FLAG, UCP_ESCALATION_FLAG, marketCurrencyOf } from '../src/ucpCheckoutEscalation.js';

const { resolveServingCurrency } = createRequire(import.meta.url)('../../src/services/buyerMarket.js');

const SESSION = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };
const CONNECTED = 'merch_shop_a';
const createArgs = (extra = {}) => ({
  idempotency_key: 'idem-native-0001',
  quote: { merchant_id: CONNECTED, items: [{ product_id: '9001', variant_id: 'v-9001-1', quantity: 1 }], customer_email: 'buyer@example.test' },
  ...extra,
});
const ON = Object.freeze({ storefrontCartDoor: true });

function recordingExecutor() {
  const seen = [];
  return {
    seen,
    async execute(op, params) {
      seen.push({ op, params: structuredClone(params) });
      return { session_id: 'q_kernel', status: 'ready_for_payment' };
    },
  };
}
async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const marketMembers = (params) => Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith('market')));

test('kernelQuoteMarketParams: nothing for an unnamed market; the code, upper-cased, with the source\'s currency; the code alone when the source has none', () => {
  for (const unnamed of [{}, { market: undefined }, { market: null }, { market: '' }, { market: '  ' }]) assert.deepEqual(kernelQuoteMarketParams(unnamed), {});
  assert.deepEqual(kernelQuoteMarketParams({ market: 'US' }), { market: 'US', market_currency: 'USD' });
  assert.deepEqual(kernelQuoteMarketParams({ market: ' sg ' }), { market: 'SG', market_currency: 'SGD' });
  assert.deepEqual(kernelQuoteMarketParams({ market: 'gb' }), { market: 'GB', market_currency: 'GBP' });
  // No currency in the source: the market alone. Never a currency of another market.
  assert.deepEqual(kernelQuoteMarketParams({ market: 'DE' }), { market: 'DE' });
  assert.deepEqual(kernelQuoteMarketParams({ market: 'zz' }), { market: 'ZZ' });
});

test('the currency is the one source\'s, market by market: this module keeps no table', () => {
  for (const code of ['US', 'SG', 'GB', 'FR', 'JP', 'AU', 'CA', 'DE', 'ZZ', 'XX']) {
    const expected = resolveServingCurrency(code) || undefined;
    assert.equal(kernelQuoteMarketParams({ market: code }).market_currency, expected, code);
    assert.equal(marketCurrencyOf(code) || undefined, expected, code);
  }
});

test('a native create on the marked door hands the executor the market and its currency, and nothing else changes', async () => {
  const plain = recordingExecutor();
  await createCommerceToolSurface(plain, { cache: false }).callTool('create_checkout_session', createArgs(), SESSION, ON);
  for (const [market, members] of [
    ['US', { market: 'US', market_currency: 'USD' }], ['sg', { market: 'SG', market_currency: 'SGD' }], ['GB', { market: 'GB', market_currency: 'GBP' }],
    ['DE', { market: 'DE' }], ['ZZ', { market: 'ZZ' }],
  ]) {
    const executor = recordingExecutor();
    await createCommerceToolSurface(executor, { cache: false }).callTool('create_checkout_session', createArgs({ market }), SESSION, ON);
    assert.equal(executor.seen.length, 1);
    assert.deepEqual(marketMembers(executor.seen[0].params), members, market);
    const { market: _m, market_currency: _c, ...rest } = executor.seen[0].params;
    assert.deepEqual(rest, plain.seen[0].params, 'the same params as a create that names no market');
  }
  assert.deepEqual(marketMembers(plain.seen[0].params), {}, 'no market named: nothing is added, nothing is assumed');
});

test('an unnamed market adds nothing', async () => {
  for (const market of [null, '', '  ']) {
    const executor = recordingExecutor();
    await createCommerceToolSurface(executor, { cache: false }).callTool('create_checkout_session', createArgs({ market }), SESSION, ON);
    assert.deepEqual(marketMembers(executor.seen[0].params), {}, JSON.stringify(market));
  }
});

test('without the mark, `market` is not an argument of create: refused, and the executor is never called', async () => {
  for (const options of [undefined, {}, { storefrontCartDoor: false }, { storefrontCartDoor: 'true' }]) {
    const executor = recordingExecutor();
    const call = createCommerceToolSurface(executor, { cache: false }).callTool('create_checkout_session', createArgs({ market: 'SG' }), SESSION, ...(options ? [options] : []));
    await assert.rejects(call, /unknown argument "market"/);
    assert.deepEqual(executor.seen, []);
  }
});

test('the `/mcp` view marks a create only while both switches are on, so only then does a market reach the executor', async () => {
  const both = { [UCP_ESCALATION_FLAG]: '1', [MCP_STOREFRONT_ESCALATION_FLAG]: '1', [CURRENCY_FOLLOWS_MARKET_FLAG]: '1' };
  for (const [label, env, reaches] of [
    ['both on', both, true],
    ['the currency rule off', { ...both, [CURRENCY_FOLLOWS_MARKET_FLAG]: undefined }, false],
    ['the storefront switch off', { ...both, [MCP_STOREFRONT_ESCALATION_FLAG]: undefined }, false],
    ['both off', { ...both, [MCP_STOREFRONT_ESCALATION_FLAG]: undefined, [CURRENCY_FOLLOWS_MARKET_FLAG]: undefined }, false],
  ]) {
    await withEnv(env, async () => {
      const executor = recordingExecutor();
      const view = mcpStorefrontCartSurface(createCommerceToolSurface(executor, { cache: false }), { log: { info() {} } });
      const out = await view.callTool('create_checkout_session', createArgs({ market: 'SG' }), SESSION).then((v) => v, (e) => e);
      if (reaches) assert.deepEqual(marketMembers(executor.seen[0].params), { market: 'SG', market_currency: 'SGD' }, label);
      else { assert.match(String(out && out.message), /unknown argument "market"/, label); assert.deepEqual(executor.seen, [], label); }
    });
  }
});

test('update takes no market on the marked door, and the UCP door never hands the executor one', async () => {
  const executor = recordingExecutor();
  const surface = createCommerceToolSurface(executor, { cache: false });
  await assert.rejects(surface.callTool('update_checkout_session', { ...createArgs({ market: 'SG' }), session_id: 'q_1' }, SESSION, ON), /unknown argument "market"/);
  await surface.callTool('update_checkout_session', { ...createArgs(), session_id: 'q_1' }, SESSION, ON);
  assert.deepEqual(executor.seen.map((s) => marketMembers(s.params)), [{}]);

  const ucpExecutor = {
    seen: [],
    async execute(op, params) {
      this.seen.push({ op, params: structuredClone(params) });
      if (op === 'get_product') return { product: { product_id: 'p_1', merchant_id: CONNECTED, title: 'Day Lotion', price: 18, currency: 'USD', purchase_route: 'internal_checkout', variants: [{ variant_id: 'v_1' }] } };
      return { session_id: 'q_kernel', status: 'ready_for_payment', currency: 'USD', totals: { total: 1800 }, line_items: [] };
    },
  };
  const ucp = ucpDialectSurface(createCommerceToolSurface(ucpExecutor, { cache: false }));
  await ucp.callTool('create_checkout', {
    meta: { 'ucp-agent': { profile: 'https://agent.example/profile' }, 'idempotency-key': 'idem-ucp-0001' },
    checkout: { line_items: [{ item: { id: 'p_1' }, quantity: 1 }], buyer: { email: 'buyer@example.test' }, context: { address_country: 'GB' } },
  }, SESSION, ON);
  const creates = ucpExecutor.seen.filter((s) => s.op === 'create_checkout_session');
  assert.equal(creates.length, 1, 'the cart reached the kernel');
  for (const c of creates) assert.deepEqual(marketMembers(c.params), {}, 'the UCP door does not carry a market to the kernel (unchanged)');
});
