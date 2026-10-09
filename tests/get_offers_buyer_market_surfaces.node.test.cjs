'use strict';

// THE TWO DOORS THAT REACH get_offers CARRY A STATED BUYER MARKET (Peng 2026-10-09): the native MCP
// tool's `market` argument and the UCP cc.pivota.insights `insights.market` leaf. Each is read into
// the executor's params ONLY when stated; the params are byte-identical otherwise. Normalisation
// (ISO-2, priceable) happens once, in makeGetOffers.getOffersBuyerMarket, not at the doors.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function surfaceWithRecorder() {
  const { createCommerceToolSurface } = await import(pathToFileURL(path.join(__dirname, '..', 'mcp-server', 'src', 'commerceToolSurface.js')).href);
  const calls = [];
  const executor = {
    async execute(op, params, ctx) {
      calls.push({ op, params });
      return { subject: { kind: 'product', id: 'p1' }, best_offer: null, signals: [], metadata: { offer_count: 0 } };
    },
  };
  return { surface: createCommerceToolSurface(executor, { cache: false }), calls };
}

test('native MCP get_offers: `market` is declared, picked into the payload when stated, absent otherwise', async () => {
  const { surface, calls } = await surfaceWithRecorder();
  await surface.callTool('get_offers', { product_id: 'p1', merchant_id: 'm1', market: 'sg', limit: 3 }, { agent_id: 'agent_a' });
  assert.equal(calls[0].op, 'get_offers');
  assert.deepEqual(calls[0].params, { payload: { product_id: 'p1', merchant_id: 'm1', market: 'sg', limit: 3 } });
  await surface.callTool('get_offers', { product_id: 'p1', merchant_id: 'm1', limit: 3 }, { agent_id: 'agent_a' });
  assert.deepEqual(calls[1].params, { payload: { product_id: 'p1', merchant_id: 'm1', limit: 3 } });
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1].params.payload, 'market'), false);
});

test('native MCP get_offers: the published schema declares `market` as a string, and an undeclared argument is still refused', async () => {
  const { surface } = await surfaceWithRecorder();
  const getOffers = surface.tools.find((t) => t.name === 'get_offers');
  assert.ok(getOffers, 'get_offers is listed');
  assert.equal(getOffers.inputSchema.properties.market.type, 'string');
  assert.equal(getOffers.inputSchema.additionalProperties, false);
  await assert.rejects(
    () => surface.callTool('get_offers', { product_id: 'p1', buyer_region: 'SG' }, { agent_id: 'agent_a' }),
    (err) => /buyer_region|unknown|undeclared|not declared/i.test(String(err && (err.message || err.code || err))),
  );
});

test('UCP cc.pivota.insights get_offers: `insights.market` maps to the native `market`, only when stated; unknown leaves are still refused', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'mcp-server', 'src', 'ucpArgumentAdapter.js')).href);
  const op = { id: 'get_offers', ucpTool: 'get_offers' };
  const schema = mod.ucpInputSchemasFor({}).get_offers;
  assert.equal(schema.properties.insights.properties.market.type, 'string');
  assert.equal(schema.properties.insights.additionalProperties, false);
  const meta = { version: '2026-04-08' };
  assert.deepEqual(mod.ucpToNativeToolArgs(op, { meta, insights: { id: 'p1', market: 'SG', limit: 3 } }, {}), { product_id: 'p1', market: 'SG', limit: 3 });
  assert.deepEqual(mod.ucpToNativeToolArgs(op, { meta, insights: { id: 'p1' } }, {}), { product_id: 'p1' });
  assert.throws(() => mod.ucpToNativeToolArgs(op, { meta, insights: { id: 'p1', buyer_region: 'SG' } }, {}));
  assert.match(mod.ucpToolDescriptionsFor({}).get_offers, /insights\.market/);
});
