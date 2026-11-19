'use strict';

// A SEARCH MARKET THAT WAS SENT IS NEVER READ AS SILENCE. Before, `false`, `0` and `[]` were read as "no market" by the
// serving rule, which is answered for a US buyer: a US/USD page, unlabelled. They are not "no market" (only absent,
// null or blank are), so the /mcp door forwards them unlabelled and the invoke search door now answers them as it
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

test('/mcp search_catalog forwards a sent false, 0 or [] as the market, unlabelled; absent is assumed US and labelled', async () => {
  const { createCommerceToolSurface } = await import('../mcp-server/src/commerceToolSurface.js');
  const seen = [];
  const surface = createCommerceToolSurface({
    async execute(op, params) { seen.push(params); return { status: 'success', products: [] }; },
  }, { cache: false });
  for (const market of [false, 0, []]) {
    const out = await surface.callTool('search_catalog', { query: 'serum', market }, {});
    assert.deepEqual(seen.at(-1).payload.search.market, market, JSON.stringify(market));
    assert.equal('market_assumed' in out, false, JSON.stringify(market));
  }
  const out = await surface.callTool('search_catalog', { query: 'serum' }, {});
  assert.equal(seen.at(-1).payload.search.market, 'US');
  assert.equal(out.market_assumed.code, 'US');
});

test('/ucp/mcp search_catalog: a non-string address_country (false, 0, []) is refused by name', async () => {
  for (const country of [false, 0, []]) {
    const answer = await doors.send(ucpSearch({ address_country: country }), { flag: false });
    const result = JSON.parse(answer.text).result || {};
    assert.equal(result.isError, true, JSON.stringify(country));
    assert.match(JSON.stringify(result), /ucp_country_string_required/, JSON.stringify(country));
  }
});
