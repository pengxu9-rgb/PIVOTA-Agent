// A MARKET THE CALLER SENT ON /ucp/mcp IS READ AS A MARKET, OR REFUSED BY NAME (ucpArgumentAdapter readSentMarket).
//
// Before this, `insights.market` (get_alternatives, get_offers) that was not a string was dropped and the call was
// answered as an assumed US: a market the caller named was replaced. A string that is not a country code ('USA',
// 'en-US') was forwarded and read as no market at all downstream. Every market-bearing argument on this door now
// refuses such a value with the door's own reason for it (`ucp_market_invalid`, the one a storefront checkout
// already gives), before anything is read, and never echoes it. Absent, null and blank still name no market (the
// door assumes US and says so, decision D-10). A readable code is forwarded as before; DE and ZZ keep their own
// downstream answer.
//
// Market-bearing arguments on this door, all covered here:
//   search_catalog   catalog.context.address_country
//   get_product      catalog.context.address_country (read while UCP_GET_PRODUCT_FORWARD_MARKET is on)
//   get_alternatives insights.market
//   get_offers       insights.market
//   create_checkout  checkout.context.address_country (read only to refuse an unreadable one)
//   update_checkout  checkout.context.address_country (same)
// get_checkout, complete_checkout and get_intel take no market.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createCommerceToolSurface, ucpDialectSurface } from '../src/commerceToolSurface.js';
import { ucpToNativeToolArgs, UCP_MARKET_INVALID_REASON } from '../src/ucpArgumentAdapter.js';
import { canonicalOp } from '../../safety-kernel/src/protocol/canonicalContract.js';

const require = createRequire(import.meta.url);
const { makeGetOffers } = require('../../src/agentSignals/intelligenceReads.js');

const META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' } };
const WRITE_META = { ...META, 'idempotency-key': 'idem-ucp-market-0001' };
// A verified buyer, so the checkout tools get past the identity gate to the mapper (made-up identity).
const SESSION = {
  user_ref: 'buyer_1', acp_session_id: 'sess_ucp_market_1',
  claims: { iss: 'https://idp.test', sub: 'buyer-1', email: 'buyer@example.com', email_verified: true },
};
const FORWARD_ON = { UCP_GET_PRODUCT_FORWARD_MARKET: 'on' };

/** Run `fn` with get_product's forward dial on in process.env (the surface reads it there), then restore it. */
async function withForwardOn(fn) {
  const before = process.env.UCP_GET_PRODUCT_FORWARD_MARKET;
  process.env.UCP_GET_PRODUCT_FORWARD_MARKET = 'on';
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.UCP_GET_PRODUCT_FORWARD_MARKET;
    else process.env.UCP_GET_PRODUCT_FORWARD_MARKET = before;
  }
}

// Sent, and not readable as a market. Each one must be refused, not dropped and not forwarded.
const UNREADABLE = [123, ['US'], { code: 'US' }, true, 'USA', 'en-US', 'U S', 'U.S.',
  // Unicode lookalikes: case mapping folds them to ASCII ('uſ' -> US, 'ﬁ' -> FI, 'ıt' -> IT); never a market.
  'uſ', 'ﬁ', 'ＵＳ', 'УС', 'ıt', 'İT'];
// The same values the refusal text must never repeat.
const ECHO_PROBES = ['USA', 'en-US', 'U S', 'U.S.', '123', '"code"', 'uſ', 'ﬁ', 'ＵＳ', 'УС', 'ıt', 'İT'];

const LINE = { item: { id: 'sig_' + 'ab'.repeat(16) }, quantity: 1 };

/** Each tool, the UCP body carrying `market` in its market-bearing argument (or no market for `undefined`). */
const TOOLS = {
  search_catalog: (market) => ({ meta: META, catalog: { query: 'lip balm', ...(market === undefined ? {} : { context: { address_country: market } }) } }),
  get_product: (market) => ({ meta: META, catalog: { id: 'sig_' + 'cd'.repeat(16), ...(market === undefined ? {} : { context: { address_country: market } }) } }),
  get_alternatives: (market) => ({ meta: META, insights: { id: 'sig_' + 'ef'.repeat(16), ...(market === undefined ? {} : { market }) } }),
  get_offers: (market) => ({ meta: META, insights: { id: 'sig_' + '12'.repeat(16), ...(market === undefined ? {} : { market }) } }),
  create_checkout: (market) => ({ meta: WRITE_META, checkout: { line_items: [LINE], ...(market === undefined ? {} : { context: { address_country: market } }) } }),
  update_checkout: (market) => ({ meta: WRITE_META, id: 'chk_placeholder_1', checkout: { line_items: [LINE], ...(market === undefined ? {} : { context: { address_country: market } }) } }),
};
const OPS = {
  search_catalog: 'search_catalog', get_product: 'get_product', get_alternatives: 'get_alternatives', get_offers: 'get_offers',
  create_checkout: 'create_checkout_session', update_checkout: 'update_checkout_session',
};
const FIELD = {
  search_catalog: 'catalog.context.address_country', get_product: 'catalog.context.address_country',
  get_alternatives: 'insights.market', get_offers: 'insights.market',
  create_checkout: 'checkout.context.address_country', update_checkout: 'checkout.context.address_country',
};
// The tools whose market reaches the native args (checkout's context is forwarded into nothing).
const FORWARDS_MARKET = ['search_catalog', 'get_product', 'get_alternatives', 'get_offers'];

function recordingSurfaces(answer = () => ({ subject: { kind: 'product', id: 'x' }, best_offer: null, signals: [], metadata: {} })) {
  const seen = [];
  const executor = {
    async execute(op, params, ctx) {
      seen.push({ op, params, ctx });
      return answer(op, params, ctx);
    },
  };
  const mcp = createCommerceToolSurface(executor, { cache: false });
  return { seen, ucp: ucpDialectSurface(mcp) };
}

describe('a sent market that is not readable is refused by name, on every market-bearing tool', () => {
  for (const tool of Object.keys(TOOLS)) {
    test(`${tool}: refused before any read, never echoed`, async () => {
      for (const market of UNREADABLE) {
        const label = `${tool} ${JSON.stringify(market)}`;
        // The mapper refuses it (with the forward dial on, so get_product reads its market at all).
        let err = null;
        try { ucpToNativeToolArgs(canonicalOp(OPS[tool]), TOOLS[tool](market), FORWARD_ON); } catch (e) { err = e; }
        assert.ok(err, `${label}: must be refused`);
        // search and get_product keep their own, older reason for a non-string address_country.
        const expected = FIELD[tool] === 'catalog.context.address_country' && typeof market !== 'string'
          ? 'ucp_country_string_required' : UCP_MARKET_INVALID_REASON;
        assert.equal(err.detail?.reason, expected, label);
        assert.equal(err.detail?.acp_detail?.rejected_field, FIELD[tool], label);
        const text = JSON.stringify({ message: err.message, detail: err.detail });
        for (const probe of ECHO_PROBES) {
          if (JSON.stringify(market).includes(probe)) assert.equal(text.includes(probe), false, `${label}: not echoed`);
        }
      }
    });

    test(`${tool}: through the UCP dialect surface the executor is never reached`, async () => {
      const { seen, ucp } = recordingSurfaces();
      await withForwardOn(async () => {
        for (const market of UNREADABLE) {
          const err = await ucp.callTool(tool, TOOLS[tool](market), SESSION).then(() => null, (e) => e);
          assert.ok(err, `${tool} ${JSON.stringify(market)}: refused`);
          assert.ok(['ucp_market_invalid', 'ucp_country_string_required'].includes(err.detail?.reason),
            `${tool} ${JSON.stringify(market)}: ${err.code} ${err.detail?.reason}`);
        }
      });
      assert.equal(seen.length, 0, `${tool}: nothing was read for an unreadable market`);
    });
  }
});

describe('unchanged: a readable market, an unpriced code, and no market', () => {
  test('a readable code is forwarded exactly as sent (trimmed); DE and ZZ are forwarded for their own downstream answer', () => {
    for (const tool of FORWARDS_MARKET) {
      for (const [sent, forwarded] of [['US', 'US'], ['SG', 'SG'], ['GB', 'GB'], ['us ', 'us'], [' sg', 'sg'], ['DE', 'DE'], ['ZZ', 'ZZ']]) {
        const native = ucpToNativeToolArgs(canonicalOp(OPS[tool]), TOOLS[tool](sent), FORWARD_ON);
        assert.equal(native.market, forwarded, `${tool} ${JSON.stringify(sent)}`);
      }
    }
    for (const tool of ['create_checkout', 'update_checkout']) {
      for (const sent of ['US', 'SG', 'GB', 'us ', 'DE', 'ZZ']) {
        assert.doesNotThrow(() => ucpToNativeToolArgs(canonicalOp(OPS[tool]), TOOLS[tool](sent), FORWARD_ON), `${tool} ${sent}`);
      }
    }
  });

  test('absent, null and blank name no market: nothing is forwarded and nothing is refused', () => {
    // search_catalog refused a null address_country before this change (a non-string, ucp_country_string_required),
    // and still does: that is today's answer, kept.
    const searchNull = (() => { try { ucpToNativeToolArgs(canonicalOp('search_catalog'), TOOLS.search_catalog(null), FORWARD_ON); } catch (e) { return e; } return null; })();
    assert.equal(searchNull?.detail?.reason, 'ucp_country_string_required');
    for (const tool of Object.keys(TOOLS)) {
      for (const sent of [undefined, null, '', '   ']) {
        if (tool === 'search_catalog' && sent === null) continue;
        const native = ucpToNativeToolArgs(canonicalOp(OPS[tool]), TOOLS[tool](sent), FORWARD_ON);
        assert.equal(JSON.stringify(native).includes('"market"'), false, `${tool} ${JSON.stringify(sent)}`);
      }
    }
  });

  test('through the surface: a read that names no market is answered as US and labelled (D-10), as before', async () => {
    for (const tool of ['search_catalog', 'get_alternatives', 'get_offers']) {
      for (const sent of [undefined, null, '']) {
        if (tool === 'search_catalog' && sent === null) continue; // refused before and after (see above)
        const { seen, ucp } = recordingSurfaces();
        const out = await ucp.callTool(tool, TOOLS[tool](sent), SESSION);
        assert.equal(seen.length, 1, `${tool} ${JSON.stringify(sent)}: read once`);
        const payload = seen[0].params?.payload || {};
        const market = payload.market ?? payload.search?.market;
        assert.equal(market, 'US', `${tool} ${JSON.stringify(sent)}: assumed US`);
        assert.equal(out.market_assumed?.code, 'US', `${tool} ${JSON.stringify(sent)}: and labelled`);
      }
    }
  });

  test('get_offers through the surface: US, SG and GB are each served in their own currency only; DE and ZZ are not priced', async () => {
    const offers = [
      { merchant_id: 'm_us', merchant_name: 'us', price: 12, currency: 'USD', availability: 'in_stock' },
      { merchant_id: 'm_sg', merchant_name: 'sg', price: 16, currency: 'SGD', availability: 'in_stock' },
      { merchant_id: 'm_gb', merchant_name: 'gb', price: 9, currency: 'GBP', availability: 'in_stock' },
    ];
    const fetched = [];
    const getOffers = makeGetOffers({ fetchOffers: async (args) => { fetched.push(args); return { offers: offers.map((o) => ({ ...o })) }; } });
    const { ucp } = recordingSurfaces((op, params) => (op === 'get_offers' ? getOffers(params) : {}));
    for (const [market, currency] of [['US', 'USD'], ['us ', 'USD'], ['SG', 'SGD'], ['GB', 'GBP']]) {
      const out = await ucp.callTool('get_offers', TOOLS.get_offers(market), SESSION);
      assert.deepEqual(out.signals.map((s) => s.value.currency), [currency], JSON.stringify(market));
      assert.equal(out.metadata.market_currency, currency);
    }
    for (const market of ['DE', 'ZZ']) {
      const before = fetched.length;
      const out = await ucp.callTool('get_offers', TOOLS.get_offers(market), SESSION);
      assert.equal(out.metadata.reason, 'market_not_priced', market);
      assert.equal(fetched.length, before, `${market}: no fetch`);
    }
    // And an unreadable one never reaches the fetch.
    const before = fetched.length;
    for (const market of UNREADABLE) {
      await ucp.callTool('get_offers', TOOLS.get_offers(market), SESSION).then(() => assert.fail(JSON.stringify(market)), () => {});
    }
    assert.equal(fetched.length, before);
  });
});

describe('one envelope for an unreadable checkout market, word for word', () => {
  test('the /ucp/mcp checkout refusal deep-equals the storefront checkout escalation refusal, for every unreadable value', async () => {
    const { checkoutMarketInvalidRefusal } = await import('../src/ucpCheckoutEscalation.js');
    const expected = checkoutMarketInvalidRefusal();
    const shape = (e) => ({ name: e.name, code: e.code, message: e.message, detail: e.detail, retriable: e.retriable });
    for (const tool of ['create_checkout', 'update_checkout']) {
      for (const market of UNREADABLE) {
        let err = null;
        try { ucpToNativeToolArgs(canonicalOp(OPS[tool]), TOOLS[tool](market), FORWARD_ON); } catch (e) { err = e; }
        assert.ok(err, `${tool} ${JSON.stringify(market)}`);
        assert.deepEqual(shape(err), shape(expected), `${tool} ${JSON.stringify(market)}`);
        assert.equal(Object.getPrototypeOf(err), Object.getPrototypeOf(expected));
      }
    }
  });
});

test('the error taxonomy documents exactly the market reasons the doors emit, and where they appear', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const root = path.join(here, '..', '..');
  const doc = fs.readFileSync(path.join(root, 'docs', 'agent-checkout', 'safety-kernel-contract.md'), 'utf8');
  const section = doc.slice(doc.indexOf('### The buyer market'), doc.indexOf('**Hard rule:**'));
  const rows = Object.fromEntries(section.split('\n').filter((l) => /^\| `[a-z_]+` \|/.test(l)).map((l) => [l.match(/^\| `([a-z_]+)`/)[1], l]));
  const EXPECTED = ['buyer_market_has_no_pricing_currency', 'market_invalid', 'market_not_priced', 'ucp_country_string_required', 'ucp_market_invalid'];
  assert.deepEqual(Object.keys(rows).sort(), EXPECTED);
  // Every documented token is one the code emits (a literal in the door or kernel sources).
  const sources = [
    'mcp-server/src/ucpArgumentAdapter.js', 'mcp-server/src/ucpCheckoutEscalation.js', 'mcp-server/src/getOffersEmptyReasonDoor.js',
    'safety-kernel/src/protocol/canonicalExecutor.js', 'safety-kernel/src/protocol/acpRestAdapter.js', 'src/server.js',
    'src/agentSignals/intelligenceReads.js',
  ].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  for (const token of EXPECTED) assert.match(sources, new RegExp(`['"]${token}['"]`), `${token} is emitted`);
  // The cells that say where each appears.
  assert.match(rows.market_invalid, /`detail\.rejected_field: "market"`/);
  assert.match(sources, /'market_invalid',[\s\S]{0,400}rejected_field: 'market'/, 'the kernel quote refusal names `market`');
  assert.match(rows.market_invalid, /fulfillment_address\.country/);
  assert.match(rows.ucp_country_string_required, /catalog\.context\.address_country/);
  assert.match(sources, /"ucp_country_string_required",[\s\S]{0,200}rejected_field: "catalog\.context\.address_country"/);
  assert.match(rows.ucp_market_invalid, /a string that is not two letters/);
  assert.match(rows.market_not_priced, /`error\.code: MARKET_NOT_PRICED`/);
  assert.match(rows.buyer_market_has_no_pricing_currency, /decision_lock_reason/);
  // The opening: no-market calls are not labelled everywhere yet, and only absent, null or blank is "no market".
  assert.match(section, /The `offers\.resolve` operation does not label it yet/);
  assert.match(section, /not named only when it is absent, `null` or blank/);
  // The UCP refusal token in the docs is the adapter's own constant.
  assert.equal(UCP_MARKET_INVALID_REASON, 'ucp_market_invalid');
});
