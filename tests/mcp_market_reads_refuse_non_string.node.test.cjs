'use strict';

// EVERY /mcp MARKET READ REFUSES A SENT NON-STRING MARKET BY NAME, BEFORE ANY READ. Their schemas declare `market` a
// string. Before, search_catalog answered `false`/`0`/`[]` with an empty page, get_product dropped the value and
// get_alternatives read it as its default: an unlabelled US/USD answer to a market the buyer never named. The tools
// (commerceToolSurface NON_STRING_MARKET_REFUSED_OPS): search_catalog, get_product, get_alternatives. get_offers keeps
// its own `market_invalid`. The refusal is the door's fixed checkout text: the value is never repeated.
// Absent, null and blank still mean an assumed, labelled US. Nock and the loopback harness only.

// get_product declares `market` only while the live product read is on (any mode but off).
process.env.UCP_LIVE_PRODUCT_READ = 'shadow';

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { createPriceLogDoors, rpc } = require('./_support/priceLogDoors.cjs');

const doors = createPriceLogDoors({ port: 3992, env: { UCP_LIVE_PRODUCT_READ: 'shadow' } });
test.before(() => doors.start(test.mock.timers));
test.after(() => doors.stop(test.mock.timers));

const TOOLS = {
  search_catalog: { query: 'serum' },
  get_product: { merchant_id: 'm_any', product_id: 'p_any' },
  get_alternatives: { merchant_id: 'm_any', product_id: 'p_any' },
};
const SENT_NON_STRINGS = [false, 0, [], {}, true];
const refusalText = (tool) => `${tool}: \`market\` must be the buyer's country as an ISO 3166-1 alpha-2 code (for example US).`;

async function recordingSurface() {
  const { createCommerceToolSurface } = await import('../mcp-server/src/commerceToolSurface.js');
  const seen = [];
  const surface = createCommerceToolSurface({
    async execute(op, params) { seen.push({ op: op && (op.id || op), params }); return { status: 'success', products: [], product: { product_id: 'p_any' }, alternatives: [] }; },
  }, { cache: false });
  return { surface, seen };
}

const marketSent = (tool, params) => (tool === 'search_catalog' ? params.payload.search.market : params.payload.market);

test('the refused set is every market read but get_offers', async () => {
  const { NON_STRING_MARKET_REFUSED_OPS } = await import('../mcp-server/src/commerceToolSurface.js');
  assert.deepEqual([...NON_STRING_MARKET_REFUSED_OPS].sort(), Object.keys(TOOLS).sort());
});

for (const [tool, args] of Object.entries(TOOLS)) {
  test(`/mcp ${tool}: a sent non-string market is refused with the fixed text, before any read`, async () => {
    const { surface, seen } = await recordingSurface();
    for (const market of SENT_NON_STRINGS) {
      const label = `${tool} ${JSON.stringify(market)}`;
      await assert.rejects(surface.callTool(tool, { ...args, market }, {}), (e) => {
        assert.equal(e.code, 'INVALID_ARGUMENTS', label);
        assert.equal(e.message, refusalText(tool), `${label}: exactly the fixed text, no echo`);
        return true;
      });
    }
    assert.deepEqual(seen, [], `${tool}: nothing is read for a refused market`);
  });

  test(`/mcp ${tool}: a named market is passed on; absent, null or blank is an assumed, labelled US`, async () => {
    const { surface, seen } = await recordingSurface();
    for (const market of ['US', 'SG', 'GB']) {
      const out = await surface.callTool(tool, { ...args, market }, {});
      assert.equal(marketSent(tool, seen.at(-1).params), market, `${tool} ${market}`);
      assert.equal('market_assumed' in out, false, `${tool} ${market}`);
    }
    for (const market of [undefined, null, '', '  ']) {
      const out = await surface.callTool(tool, { ...args, ...(market === undefined ? {} : { market }) }, {});
      assert.equal(marketSent(tool, seen.at(-1).params), 'US', `${tool} ${JSON.stringify(market)}`);
      assert.equal(out.market_assumed.code, 'US', `${tool} ${JSON.stringify(market)}`);
    }
  });

  test(`/mcp ${tool} at the door: the answer is that error, naming market and not the value`, async () => {
    for (const market of SENT_NON_STRINGS) {
      const answer = await doors.send(() => supertest(doors.app).post('/mcp').send(rpc(tool, { ...args, market })), { flag: false });
      const text = answer.text;
      const label = `${tool} ${JSON.stringify(market)}`;
      assert.match(text, /INVALID_ARGUMENTS/, label);
      assert.ok(text.includes(JSON.stringify(refusalText(tool)).slice(1, -1)), `${label}: the fixed text`);
      assert.doesNotMatch(text, /\[object Object\]|"market":\s*(false|true|0|\[\]|\{\})/, `${label}: never echoed`);
      assert.doesNotMatch(text, /"products"|"alternatives"/, label);
    }
  });
}

test('/mcp get_offers keeps its own answer for a non-string market: not this refusal', async () => {
  const { surface, seen } = await recordingSurface();
  for (const market of SENT_NON_STRINGS) {
    await surface.callTool('get_offers', { merchant_id: 'm_any', product_id: 'p_any', market }, {});
    assert.deepEqual(seen.at(-1).params.payload.market, market, JSON.stringify(market));
  }
});
