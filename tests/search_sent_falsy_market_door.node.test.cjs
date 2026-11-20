'use strict';

// A SEARCH MARKET THAT WAS SENT IS NEVER READ AS SILENCE. Before, `false`, `0` and `[]` were read as "no market" by the
// serving rule, which is answered for a US buyer: a US/USD page, unlabelled. They are not "no market" (only absent,
// null or blank are), so the /mcp door refuses them by name (search_catalog's schema says string) and the invoke search door answers them as it
// answers a market it has no currency for: nothing served (serving_currency_guard.serving_currency null). /ucp/mcp
// refuses a non-string country by name (ucp_country_string_required). Absent stays a US answer.
// Nock and the loopback harness only (tests/_support/priceLogDoors.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { createPriceLogDoors, AGENT_META, OVERLAID_ELSEWHERE_QUERY, rpc } = require('./_support/priceLogDoors.cjs');

const doors = createPriceLogDoors({ port: 3996 });
test.before(() => doors.start(test.mock.timers));
test.after(() => doors.stop(test.mock.timers));

// The invoke search door with a backend page of one USD product (the harness's upstream-proxy lane).
const invokeSearch = (market) => () => supertest(doors.app).post('/agent/shop/v1/invoke').send({
  operation: 'find_products_multi',
  payload: { search: { query: OVERLAID_ELSEWHERE_QUERY, ...(market === undefined ? {} : { market }) } },
});
const ucpSearch = (context) => () => supertest(doors.app).post('/ucp/mcp')
  .send(rpc('search_catalog', { meta: AGENT_META, catalog: { query: 'tint', ...(context ? { context } : {}) } }));

test('invoke search: market false, 0 or [] serves nothing, as an unpriced market does; never the US/USD page', async () => {
  const control = JSON.parse((await doors.send(invokeSearch('US'), { flag: false })).text);
  assert.deepEqual(control.products.map((p) => p.currency), ['USD'], 'control: US serves the USD product');
  const unpriced = JSON.parse((await doors.send(invokeSearch('ZZ'), { flag: false })).text);
  for (const market of [false, 0, []]) {
    const body = JSON.parse((await doors.send(invokeSearch(market), { flag: false })).text);
    const label = JSON.stringify(market);
    assert.deepEqual(body.products, [], `${label}: nothing served`);
    assert.equal(body.metadata.serving_currency_guard.serving_currency, null, label);
    assert.deepEqual(body.metadata.serving_currency_guard, unpriced.metadata.serving_currency_guard, `${label}: the unpriced answer`);
    assert.equal('market_assumed' in body, false, label);
  }
  const absent = JSON.parse((await doors.send(invokeSearch(undefined), { flag: false })).text);
  assert.deepEqual(absent.products.map((p) => p.currency), ['USD'], 'absent: unchanged');
});

test('/mcp search_catalog refuses a sent non-string market by name before any read; absent is assumed US and labelled', async () => {
  const { createCommerceToolSurface } = await import('../mcp-server/src/commerceToolSurface.js');
  const seen = [];
  const surface = createCommerceToolSurface({
    async execute(op, params) { seen.push(params); return { status: 'success', products: [] }; },
  }, { cache: false });
  for (const market of [false, 0, [], {}, true]) {
    const label = JSON.stringify(market);
    await assert.rejects(surface.callTool('search_catalog', { query: 'serum', market }, {}), (e) => {
      assert.equal(e.code, 'INVALID_ARGUMENTS', label);
      // Exactly the fixed text: the sent value is never repeated back.
      assert.equal(e.message, "search_catalog: `market` must be the buyer's country as an ISO 3166-1 alpha-2 code (for example US).", label);
      return true;
    });
  }
  assert.deepEqual(seen, [], 'nothing is read for a refused market');
  for (const market of ['US', 'SG', 'GB']) {
    const out = await surface.callTool('search_catalog', { query: 'serum', market }, {});
    assert.equal(seen.at(-1).payload.search.market, market);
    assert.equal('market_assumed' in out, false, market);
  }
  for (const market of [undefined, null, '', '  ']) {
    const out = await surface.callTool('search_catalog', { query: 'serum', ...(market === undefined ? {} : { market }) }, {});
    assert.equal(seen.at(-1).payload.search.market, 'US', JSON.stringify(market));
    assert.equal(out.market_assumed.code, 'US', JSON.stringify(market));
  }
});

test('/mcp search_catalog at the door: a sent non-string market is an error naming market, never a page', async () => {
  for (const market of [false, 0, [], {}, true]) {
    const answer = await doors.send(() => supertest(doors.app).post('/mcp')
      .send(rpc('search_catalog', { query: 'tint', market })), { flag: false });
    const parsed = JSON.parse(answer.text);
    const text = JSON.stringify(parsed);
    assert.match(text, /INVALID_ARGUMENTS/, JSON.stringify(market));
    assert.match(text, /ISO 3166-1 alpha-2/, JSON.stringify(market));
    assert.doesNotMatch(text, /"products"/, JSON.stringify(market));
    assert.doesNotMatch(text, /\[object Object\]|"market":\s*(false|true|0|\[\]|\{\})/, `${JSON.stringify(market)}: never echoed`);
  }
});

test('/ucp/mcp search_catalog: a non-string address_country (false, 0, []) is refused by name', async () => {
  for (const country of [false, 0, []]) {
    const answer = await doors.send(ucpSearch({ address_country: country }), { flag: false });
    const result = JSON.parse(answer.text).result || {};
    assert.equal(result.isError, true, JSON.stringify(country));
    assert.match(JSON.stringify(result), /ucp_country_string_required/, JSON.stringify(country));
  }
});
