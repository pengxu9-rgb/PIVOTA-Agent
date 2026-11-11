'use strict';

// AN EMPTY get_offers ANSWER SAYS WHY (GET_OFFERS_EMPTY_REASON=1, the `/mcp` door).
//
// Probe 2026-11-10: get_offers answered 200 with zero offers and no reason for products get_product had
// just priced. The backend knew why; the gateway kept only the offers.
//
// END TO END over the real door: POST /mcp tools/call get_offers -> the door's view of the surface -> the
// canonical executor -> makeGetOffers -> the wired fetchOffers -> the backend request on the wire (nock),
// answered with bodies RECORDED from the backend's own offers.resolve handler (see _support).

const test = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_ENV = { ...process.env };
const support = require('./_support/getOffersEmptyReasonDoor.cjs');

support.setDoorEnv();
process.env.GET_OFFERS_EMPTY_REASON = '1';

const app = require('../src/server');
const { EMPTY_REASONS } = require('../src/agentSignals/getOffersEmptyReason');
const { FIXTURE, answerOf, callGetOffersRaw, listTools } = support;

test.after(() => {
  require('nock').cleanAll();
  process.env = { ...ORIGINAL_ENV };
});

const clone = (v) => JSON.parse(JSON.stringify(v));
const mcp = async (body, args) => answerOf(await callGetOffersRaw(app, '/mcp', body, args));

// recorded backend answer -> the reason the partner reads, and whether to ask again
const CASES = [
  ['minted_flag_off_no_seed', 'no_seed_for_product', false],
  ['unknown_signature_no_seed', 'no_seed_for_product', false],
  ['mirror_usd_seed_sg_buyer', 'seed_not_in_market', false],
  ['mirror_dead_page', 'seed_not_servable', false],
  ['minted_stale_held', 'offer_needs_live_verification', false],
  ['seed_lookup_failed', 'offer_lookup_unavailable', true],
];

for (const [name, reason, retriable] of CASES) {
  test(`${name}: reason ${reason}, retriable ${retriable}`, async () => {
    assert.equal(FIXTURE[name].offers.length, 0, 'the recorded backend answer is an empty one');
    const out = await mcp(FIXTURE[name]);
    assert.deepEqual(out.signals, []);
    assert.equal(out.best_offer, null);
    assert.equal(out.metadata.offer_count, 0);
    assert.equal(out.metadata.reason, reason);
    assert.equal(out.metadata.reason_retriable, retriable);
  });
}

// Review P2-1. The backend matched a CONNECTED seller's own product and withheld it (reason_code NOT_SERVABLE);
// the seed lookup beside it found no row. The partner was told "no seller offer on file".
for (const name of ['connected_out_of_stock_withheld', 'connected_not_orderable_withheld']) {
  test(`${name}: a connected seller's withheld product is seed_not_servable, never no_seed_for_product`, async () => {
    const recorded = FIXTURE[name];
    assert.equal(recorded.offers.length, 0);
    assert.equal(recorded.metadata.reason_code, 'NOT_SERVABLE');
    assert.equal(recorded.mapping.candidates[0].kind, 'internal_product');
    const [seedLookup] = recorded.metadata.sources.filter((s) => s.source === 'external_product_seeds');
    assert.deepEqual([seedLookup.status, seedLookup.row_count], ['ok', 0], 'the seed lookup ran and found no row');
    const args = { product_id: recorded.input.product_id, merchant_id: recorded.metadata.merchant_scope, market: 'US' };
    const out = await mcp(recorded, args);
    assert.equal(out.metadata.offer_count, 0);
    assert.equal(out.metadata.reason, 'seed_not_servable');
    assert.equal(out.metadata.reason_retriable, false);
    // The other get_offers door answers the same backend body as it always did.
    const ucp = JSON.stringify((await callGetOffersRaw(app, '/ucp/mcp', recorded)).body);
    assert.match(ucp, /offer_count/);
    assert.equal(/seed_not_servable|reason_retriable/.test(ucp), false);
  });
}

test('a stale offer the backend returned flagged, with no live read to verify it: needs live verification, not retriable', async () => {
  assert.ok(FIXTURE.minted_stale_flagged.offers[0].requires_live_verification, 'the recorded offer is flagged');
  const out = await mcp(FIXTURE.minted_stale_flagged);
  assert.equal(out.metadata.offer_count, 0);
  assert.equal(out.metadata.withheld_unverified_count, 1);
  assert.equal(out.metadata.reason, 'offer_needs_live_verification');
  assert.equal(out.metadata.reason_retriable, false);
});

test('an answer WITH an offer carries neither field', async () => {
  const out = await mcp(FIXTURE.minted_fresh_offer);
  assert.equal(out.metadata.offer_count, 1);
  assert.ok(out.best_offer && out.signals.length === 1);
  assert.equal('reason' in out.metadata, false);
  assert.equal('reason_retriable' in out.metadata, false);
});

test('the reasons get_offers already gave keep their token and gain the retry flag', async () => {
  const gbp = { ...clone(FIXTURE.minted_fresh_offer.offers[0]), currency: 'GBP' };
  const out = await mcp({ status: 'success', offers: [gbp] });
  assert.equal(out.metadata.reason, 'no_offer_in_market_currency');
  assert.equal(out.metadata.reason_retriable, false);
  // Answered before any backend call: the same token, and the retry flag every empty answer here carries.
  const unpriced = await mcp(FIXTURE.minted_fresh_offer, { product_id: support.SIG, market: 'DE' });
  assert.equal(unpriced.metadata.reason, 'market_not_priced');
  assert.equal(unpriced.metadata.reason_retriable, false);
});

test('nothing the backend wrote is forwarded: free text in every field it could ride in is never served', async () => {
  const MARK = 'FREE-TEXT-9f3a';
  const hostile = clone(FIXTURE.minted_stale_held);
  hostile.metadata.reason = `${MARK} reason`;
  hostile.metadata.reason_code = `${MARK}_CODE`;
  hostile.metadata.empty_reason = `${MARK} empty_reason`;
  hostile.empty_reason = `${MARK} top`;
  hostile.metadata.failure_breakdown = { [`${MARK}_k`]: `${MARK} v` };
  hostile.metadata.sources = hostile.metadata.sources.map((s) => ({ ...s, reason: `${MARK} src`, reason_code: `${MARK}_src`, error: `${MARK} err`, query: `${MARK} q` }));
  hostile.mapping.candidates = [
    { kind: 'external_seed', confidence: 0, reason: `${MARK} cand`, seed_id: `${MARK}_seed`, blockers: [`${MARK} blocker`] },
    { kind: `${MARK}_kind`, reason: 'external_seed_requires_live_verification', blockers: ['stale_snapshot'] },
  ];
  const res = await callGetOffersRaw(app, '/mcp', hostile);
  assert.equal(JSON.stringify(res.body).includes(MARK), false, 'no backend string reaches the answer');
  const out = answerOf(res);
  // An unknown candidate reason and unknown blockers classify nothing: the seed row count is all that is read.
  assert.equal(out.metadata.reason, 'seed_not_servable');
  assert.ok(Object.values(EMPTY_REASONS).includes(out.metadata.reason));

  // The mapped token itself cannot be planted either: a backend `empty_reason` is never read.
  const planted = clone(FIXTURE.unknown_signature_no_seed);
  planted.empty_reason = 'offer_lookup_unavailable';
  planted.metadata.empty_reason = 'offer_lookup_unavailable';
  assert.equal((await mcp(planted)).metadata.reason, 'no_seed_for_product');

  // A body that says nothing classifiable: the generic token.
  const bare = await callGetOffersRaw(app, '/mcp', { status: 'success', offers: [], metadata: { reason: `${MARK} bare` } });
  assert.equal(JSON.stringify(bare.body).includes(MARK), false);
  assert.equal(answerOf(bare).metadata.reason, 'no_offer_for_product');
  assert.equal(answerOf(bare).metadata.reason_retriable, false);
});

test('every reason the door can give is explained in the get_offers description, with the retry rule', async () => {
  const tools = await listTools(app, '/mcp');
  const description = tools.find((t) => t.name === 'get_offers').description;
  for (const reason of Object.values(EMPTY_REASONS)) assert.ok(description.includes(`\`${reason}\``), reason);
  assert.match(description, /`offer_needs_live_verification`: we hold an offer .* Retry only when `reason_retriable` is true/);
  assert.match(description, /metadata\.reason_retriable/);
  // The reasons get_offers gave before this flag are listed too: every token the door can answer with.
  const { GET_OFFERS_REASON_TOKENS } = await import('../mcp-server/src/getOffersEmptyReasonDoor.js');
  for (const older of ['variant_not_offered', 'no_offer_in_market_currency', 'market_not_priced', 'offers_source_unavailable']) {
    assert.ok(GET_OFFERS_REASON_TOKENS.includes(older), older);
  }
  for (const reason of GET_OFFERS_REASON_TOKENS) assert.ok(description.includes(`\`${reason}\``), reason);
  // The wording claims no more than was established (review P2-2, P3-2, P3-3).
  assert.match(description, /retriable` is true \(the store timed out or answered badly, or our own check failed\); when it is false, asking again within minutes will not change this/);
  assert.match(description, /`no_seed_for_product`: we found no servable seller offer on file for this product in this market\./);
  assert.match(description, /could not be confirmed with the store\./);
  for (const overclaim of ['cannot be asked', 'could not confirm them just now', 'is on file for this product id']) {
    assert.equal(description.includes(overclaim), false, overclaim);
  }
  // No other tool's declaration moves.
  const { getOffersEmptyReasonSurface } = await import('../mcp-server/src/getOffersEmptyReasonDoor.js');
  const base = { tools: [{ name: 'get_product', description: 'd' }, { name: 'get_offers', description: 'o' }], isCommerceTool: () => true, callTool: async () => null };
  const view = getOffersEmptyReasonSurface(base, { enabled: true });
  assert.deepEqual(view.tools[0], base.tools[0]);
  assert.equal(view.tools[1].description.startsWith('o '), true);
});

test('only /mcp changes: the UCP door answers the same call with no reason and its own description', async () => {
  for (const [name] of CASES) {
    const res = await callGetOffersRaw(app, '/ucp/mcp', FIXTURE[name]);
    const text = JSON.stringify(res.body);
    assert.equal(res.body.result.isError === true, false, `${name}: the UCP door answered the call`);
    assert.match(text, /offer_count/, `${name}: with a get_offers answer`);
    assert.equal(text.includes('reason_retriable'), false, name);
    for (const reason of ['no_seed_for_product', 'seed_not_in_market', 'seed_not_servable', 'offer_lookup_unavailable', 'no_offer_for_product']) {
      assert.equal(text.includes(reason), false, `${name}: ${reason}`);
    }
  }
  const ucpTools = await listTools(app, '/ucp/mcp');
  assert.equal(JSON.stringify(ucpTools).includes('reason_retriable'), false);
});
