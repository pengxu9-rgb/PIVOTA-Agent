// UCP_GET_PRODUCT_FORWARD_MARKET (PR-5, verified-price design section 6 row 5): the UCP get_product door hands
// the buyer market a platform DECLARES in `catalog.context.address_country` to the native get_product `market`,
// the one input the live variant read needs. Off (the default), the mapper's output is exactly `{ product_id }`
// and `tools/list` is what it was. On, a market is forwarded only when one is stated: never defaulted, never
// inferred, and the other context members stay accepted-and-unread.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCommerceToolSurface,
  ucpDialectSurface,
  ucpCommerceToolDefinitions,
  ucpCommerceToolDefinitionsFor,
  commerceToolParamsKey,
} from '../src/commerceToolSurface.js';
import {
  UCP_INPUT_SCHEMAS,
  UCP_TOOL_DESCRIPTIONS,
  UCP_ACCEPTED_BUT_UNMAPPED,
  ucpToNativeToolArgs,
  ucpGetProductForwardMarketEnabled,
} from '../src/ucpArgumentAdapter.js';
import { canonicalOpForUcpTool } from '../../safety-kernel/src/protocol/canonicalContract.js';

const META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' } };
const OP = canonicalOpForUcpTool('get_product');
const ON = { UCP_GET_PRODUCT_FORWARD_MARKET: 'on' };
const OFF = {};
const map = (catalog, env) => ucpToNativeToolArgs(OP, { meta: META, catalog }, env);

function refusalOf(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected a refusal');
}

test('off: exactly { product_id }, whatever the context says', () => {
  for (const context of [undefined, { address_country: 'US' }, { address_country: 'SG', currency: 'SGD' }, { address_country: 7 }, 'x', null]) {
    const catalog = context === undefined ? { id: ' sig_1 ' } : { id: ' sig_1 ', context };
    assert.deepEqual(map(catalog, OFF), { product_id: 'sig_1' }, JSON.stringify(context));
  }
});

test('on: a declared market is forwarded, trimmed, as the platform stated it', () => {
  assert.deepEqual(map({ id: 'sig_1', context: { address_country: 'US' } }, ON), { product_id: 'sig_1', market: 'US' });
  assert.deepEqual(map({ id: 'sig_1', context: { address_country: ' sg ' } }, ON), { product_id: 'sig_1', market: 'sg' });
  // A code Pivota does not price is still the platform's statement: the reader refuses it (market_not_priced),
  // the door never swaps it for another market.
  assert.deepEqual(map({ id: 'sig_1', context: { address_country: 'ZZ' } }, ON), { product_id: 'sig_1', market: 'ZZ' });
});

test('on: no market is ever defaulted or inferred', () => {
  for (const catalog of [
    { id: 'sig_1' },
    { id: 'sig_1', context: {} },
    { id: 'sig_1', context: { address_country: '' } },
    { id: 'sig_1', context: { address_country: '   ' } },
    // currency is NOT a market (ADR-026): a USD price may only mean the crawl's vantage.
    { id: 'sig_1', context: { currency: 'USD', language: 'en', address_region: 'CA', postal_code: '94107' } },
    // a non-object context is tolerated by the permissive schema and reads as absent
    { id: 'sig_1', context: 'US' },
  ]) {
    assert.deepEqual(map(catalog, ON), { product_id: 'sig_1' }, JSON.stringify(catalog));
  }
});

test('on: a non-string address_country is refused, naming the field (as search_catalog refuses it)', () => {
  const e = refusalOf(() => map({ id: 'sig_1', context: { address_country: ['US'] } }, ON));
  assert.equal(e.code, 'UNKNOWN_PRODUCT_ID');
  assert.equal(e.detail.reason, 'ucp_country_string_required');
  assert.equal(e.detail.acp_detail.rejected_field, 'catalog.context.address_country');
  assert.match(e.detail.acp_message, /address_country/);
});

test('the flag: on/1/true/yes/enabled in any case; anything else is off', () => {
  for (const v of ['on', 'ON', '1', 'true', 'yes', 'enabled', ' on ']) assert.equal(ucpGetProductForwardMarketEnabled({ UCP_GET_PRODUCT_FORWARD_MARKET: v }), true, v);
  for (const v of ['', 'off', '0', 'false', 'no', 'shadow', 'enforce', undefined]) assert.equal(ucpGetProductForwardMarketEnabled({ UCP_GET_PRODUCT_FORWARD_MARKET: v }), false, String(v));
  assert.equal(ucpGetProductForwardMarketEnabled({}), false);
});

test('tools/list: off is the very same declarations; on changes get_product only, for every Reap dial', () => {
  const dials = [{}, { REAP_AGENTIC_LANE_ENABLED: '1' }, { REAP_AGENTIC_LANE_ENABLED: '1', REAP_AGENTIC_CART_LINK_LANE_ENABLED: '1' }];
  assert.equal(ucpCommerceToolDefinitionsFor(OFF), ucpCommerceToolDefinitions, 'off: the same object');
  for (const dial of dials) {
    const off = ucpCommerceToolDefinitionsFor(dial);
    const on = ucpCommerceToolDefinitionsFor({ ...dial, ...ON });
    assert.equal(ucpCommerceToolDefinitionsFor({ ...dial, ...ON }), on, 'memoized per dial');
    assert.equal(on.length, off.length);
    on.forEach((def, i) => {
      if (def.name !== 'get_product') return assert.equal(def, off[i], `${def.name}: untouched`);
      assert.notEqual(def, off[i]);
      assert.equal(def.annotations, off[i].annotations);
      assert.ok(def.description.startsWith(`${UCP_TOOL_DESCRIPTIONS.get_product} `));
      assert.match(def.description, /catalog\.context\.address_country/);
      assert.match(def.description, /call `get_offers`/);
      assert.equal(def.inputSchema.properties.catalog.properties.context.properties.address_country.type, 'string');
      assert.deepEqual(def.inputSchema.properties.catalog.required, ['id']);
      assert.equal(def.inputSchema.additionalProperties, false);
    });
  }
  // The flag-off schema is not mutated by building the flag-on one.
  assert.deepEqual(UCP_INPUT_SCHEMAS.get_product.properties.catalog.properties.context, {
    type: 'object', additionalProperties: true, description: 'Accepted and NOT read.',
  });
});

test('on: of the context leaves, exactly address_country reaches the native args; the declared unread set is unchanged', () => {
  const body = {
    meta: META,
    catalog: {
      id: 'SENTINEL_ID',
      context: { address_country: 'SENTINEL_CC', address_region: 'SENTINEL_RG', postal_code: 'SENTINEL_PC', language: 'SENTINEL_LG', currency: 'SENTINEL_CU', intent: 'SENTINEL_IN' },
      selected: [{ id: 'SENTINEL_SE' }], preferences: [{ x: 'SENTINEL_PR' }], signals: { s: 'SENTINEL_SI' }, filters: { f: 'SENTINEL_FI' },
    },
  };
  const surviving = (env) => {
    const mapped = JSON.stringify(ucpToNativeToolArgs(OP, body, env));
    return [...mapped.matchAll(/SENTINEL_[A-Z]{2}/g)].map((m) => m[0]).sort();
  };
  assert.deepEqual(surviving(OFF), ['SENTINEL_ID']);
  assert.deepEqual(surviving(ON), ['SENTINEL_CC', 'SENTINEL_ID']);
  // `catalog.context.*` stays declared accepted-but-unmapped: every OTHER context member is still not read.
  assert.ok(UCP_ACCEPTED_BUT_UNMAPPED.get_product.includes('catalog.context.*'));
});

test('through the UCP dialect surface: the executor sees market only when the flag is on and a market is stated', async () => {
  const seen = [];
  const executor = {
    async execute(op, params) {
      seen.push({ op, params });
      return { product: { product_id: params.payload.product.product_id, title: 'P', price: 12.5, currency: 'USD', variants: [{ variant_id: 'v_1' }] } };
    },
  };
  const surface = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
  const prior = process.env.UCP_GET_PRODUCT_FORWARD_MARKET;
  try {
    delete process.env.UCP_GET_PRODUCT_FORWARD_MARKET;
    await surface.callTool('get_product', { meta: META, catalog: { id: 'sig_1', context: { address_country: 'US' } } }, {});
    process.env.UCP_GET_PRODUCT_FORWARD_MARKET = 'on';
    await surface.callTool('get_product', { meta: META, catalog: { id: 'sig_1', context: { address_country: 'US' } } }, {});
    await surface.callTool('get_product', { meta: META, catalog: { id: 'sig_1' } }, {});
    const gp = surface.tools.find((t) => t.name === 'get_product');
    assert.match(gp.description, /address_country/, 'tools/list follows the flag per call');
  } finally {
    if (prior === undefined) delete process.env.UCP_GET_PRODUCT_FORWARD_MARKET;
    else process.env.UCP_GET_PRODUCT_FORWARD_MARKET = prior;
  }
  assert.deepEqual(seen.map((c) => c.op), ['get_product', 'get_product', 'get_product']);
  assert.deepEqual(seen.map((c) => c.params.payload), [
    { product: { product_id: 'sig_1' } },
    { product: { product_id: 'sig_1' }, market: 'US' },
    { product: { product_id: 'sig_1' } },
  ]);
  for (const c of seen) assert.equal(c.params.live_read, true, 'the agent\'s own get_product opts into the live read');
  assert.doesNotMatch(surface.tools.find((t) => t.name === 'get_product').description, /address_country/, 'off again');
});

test('the read-cache key follows the forwarded market (two markets never share an entry)', () => {
  const prior = process.env.UCP_GET_PRODUCT_FORWARD_MARKET;
  try {
    delete process.env.UCP_GET_PRODUCT_FORWARD_MARKET;
    const offUs = commerceToolParamsKey('get_product', { meta: META, catalog: { id: 'sig_1', context: { address_country: 'US' } } }, { dialect: 'ucp' });
    const offSg = commerceToolParamsKey('get_product', { meta: META, catalog: { id: 'sig_1', context: { address_country: 'SG' } } }, { dialect: 'ucp' });
    assert.equal(offUs, offSg, 'off: the context is not read, so it is not keyed');
    process.env.UCP_GET_PRODUCT_FORWARD_MARKET = 'on';
    const onUs = commerceToolParamsKey('get_product', { meta: META, catalog: { id: 'sig_1', context: { address_country: 'US' } } }, { dialect: 'ucp' });
    const onSg = commerceToolParamsKey('get_product', { meta: META, catalog: { id: 'sig_1', context: { address_country: 'SG' } } }, { dialect: 'ucp' });
    const onNone = commerceToolParamsKey('get_product', { meta: META, catalog: { id: 'sig_1' } }, { dialect: 'ucp' });
    assert.notEqual(onUs, onSg);
    assert.equal(onNone, offUs);
  } finally {
    if (prior === undefined) delete process.env.UCP_GET_PRODUCT_FORWARD_MARKET;
    else process.env.UCP_GET_PRODUCT_FORWARD_MARKET = prior;
  }
});
