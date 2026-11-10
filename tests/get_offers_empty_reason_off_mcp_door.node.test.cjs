'use strict';

// GET_OFFERS_EMPTY_REASON unset: the `/mcp` door serves the surface itself, and get_offers answers what it
// answered before the flag existed. The same recorded backend answers as the flag-on suite.

const test = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_ENV = { ...process.env };
const support = require('./_support/getOffersEmptyReasonDoor.cjs');

support.setDoorEnv();
delete process.env.GET_OFFERS_EMPTY_REASON;

const app = require('../src/server');
const { FIXTURE, answerOf, callGetOffersRaw, listTools } = support;

test.after(() => {
  require('nock').cleanAll();
  process.env = { ...ORIGINAL_ENV };
});

test('off, the door view is the surface itself (same object)', async () => {
  const { getOffersEmptyReasonSurface, GET_OFFERS_EMPTY_REASON } = await import('../mcp-server/src/getOffersEmptyReasonDoor.js');
  assert.equal(GET_OFFERS_EMPTY_REASON, false);
  const surface = { tools: [], isCommerceTool: () => true, callTool: async () => null };
  assert.equal(getOffersEmptyReasonSurface(surface), surface);
  for (const off of ['', '0', 'false', 'off', 'shadow', 'enforce']) {
    assert.equal(/^(1|true|yes|on|enabled)$/i.test(off), false, off);
  }
});

test('off, an empty answer is exactly the pre-flag answer on /mcp and on /ucp/mcp', async () => {
  const empty = { offer_count: 0, product_group_id: null, market: 'US', market_currency: 'USD', withheld_other_currency_count: 0 };
  for (const name of ['minted_flag_off_no_seed', 'unknown_signature_no_seed', 'mirror_usd_seed_sg_buyer', 'mirror_dead_page', 'minted_stale_held', 'seed_lookup_failed']) {
    const out = answerOf(await callGetOffersRaw(app, '/mcp', FIXTURE[name]));
    assert.deepEqual(out.metadata, empty, name);
    assert.deepEqual(out.signals, [], name);
    assert.equal(out.best_offer, null, name);
    const ucp = JSON.stringify((await callGetOffersRaw(app, '/ucp/mcp', FIXTURE[name])).body);
    assert.equal(/reason/.test(ucp), false, name);
  }
  const flagged = answerOf(await callGetOffersRaw(app, '/mcp', FIXTURE.minted_stale_flagged));
  assert.deepEqual(flagged.metadata, { ...empty, withheld_unverified_count: 1, reason: 'offer_needs_live_verification' });
});

test('off, the get_offers description names none of the new vocabulary', async () => {
  const tools = await listTools(app, '/mcp');
  const description = tools.find((t) => t.name === 'get_offers').description;
  for (const word of ['reason_retriable', 'no_seed_for_product', 'seed_not_in_market', 'seed_out_of_stock', 'offer_lookup_unavailable']) {
    assert.equal(description.includes(word), false, word);
  }
});

test('off the reason door, makeGetOffers and the mapper add nothing even when handed a reason', async () => {
  const { makeGetOffers, mapOffersResolveResponse } = require('../src/agentSignals/intelligenceReads');
  const { emptyReasonDoorActive } = require('../src/agentSignals/getOffersEmptyReason');
  assert.equal(emptyReasonDoorActive(), false);
  assert.deepEqual(mapOffersResolveResponse(FIXTURE.minted_stale_held, null), { offers: [], product_group_id: null });
  const res = await makeGetOffers({
    emptyReasonDoor: emptyReasonDoorActive,
    fetchOffers: async () => ({ offers: [], empty_reason: 'no_seed_for_product' }),
  })({ payload: { product_id: 'sig_x', market: 'US' } });
  assert.equal('reason' in res.metadata, false);
  assert.equal('reason_retriable' in res.metadata, false);
});
