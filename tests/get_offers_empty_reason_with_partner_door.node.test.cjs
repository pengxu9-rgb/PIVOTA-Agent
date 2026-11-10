'use strict';

// GET_OFFERS_EMPTY_REASON beside PARTNER_DOOR_ONE_PRODUCT_ID: the `/mcp` door serves the partner-door view
// OVER the empty-reason view, and each works with the other on or off.
//
// Both can name an empty get_offers answer in `metadata.reason`. The rule: a reason already on the answer is
// never overwritten, so the specific reason (this flag, from the backend) stands and the partner-door view's
// generic `no_offer_for_product` is only what an answer gets when nothing more specific is known.
//
// Part 1 is the real door, one child process per flag combination (both flags are read once at load).
// Part 2 composes the two real views over a real makeGetOffers, for the partner-door view's retry under the
// signature, which needs a group lookup the door test has no database for.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHILD = path.join(__dirname, '_support', 'getOffersEmptyReasonComboChild.cjs');
const FIXTURE = require('./fixtures/offers_resolve_empty_answers.json');

function runCombo({ emptyReason, partnerDoor }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, COMBO_EMPTY_REASON: emptyReason ? '1' : '', COMBO_PARTNER_DOOR: partnerDoor ? '1' : '' };
    const child = spawn(process.execPath, [CHILD], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('COMBO_RESULT '));
      if (code !== 0 || !line) return reject(new Error(`combo child exited ${code}: ${err.slice(-1500)}`));
      return resolve(JSON.parse(line.slice('COMBO_RESULT '.length)));
    });
  });
}

const combos = {};
test.before(async () => {
  const [off, mine, theirs, both] = await Promise.all([
    runCombo({ emptyReason: false, partnerDoor: false }),
    runCombo({ emptyReason: true, partnerDoor: false }),
    runCombo({ emptyReason: false, partnerDoor: true }),
    runCombo({ emptyReason: true, partnerDoor: true }),
  ]);
  Object.assign(combos, { off, mine, theirs, both });
});

const reasonOf = (combo, name) => combo.answers[name].metadata.reason;
const retriableOf = (combo, name) => combo.answers[name].metadata.reason_retriable;

test('both off: an empty answer has no reason, and the one reason get_offers always gave is unchanged', () => {
  const c = combos.off;
  for (const name of ['unknown_signature_no_seed', 'mirror_dead_page', 'seed_lookup_failed']) {
    assert.equal('reason' in c.answers[name].metadata, false, name);
    assert.equal('reason_retriable' in c.answers[name].metadata, false, name);
  }
  assert.equal(reasonOf(c, 'minted_stale_flagged'), 'offer_needs_live_verification');
  assert.equal(reasonOf(c, 'gbp_only'), 'no_offer_in_market_currency');
  assert.equal(c.description.includes('reason_retriable'), false);
  assert.equal(c.declares_group_id, true);
});

test('only the partner door: its generic reason on an unnamed empty answer, no retry flag, existing reasons kept', () => {
  const c = combos.theirs;
  for (const name of ['unknown_signature_no_seed', 'mirror_dead_page', 'seed_lookup_failed']) {
    assert.equal(reasonOf(c, name), 'no_offer_for_product', name);
    assert.equal('reason_retriable' in c.answers[name].metadata, false, name);
  }
  assert.equal(reasonOf(c, 'minted_stale_flagged'), 'offer_needs_live_verification');
  assert.equal(reasonOf(c, 'gbp_only'), 'no_offer_in_market_currency');
  assert.equal(c.description.includes('reason_retriable'), false);
  assert.equal(c.declares_group_id, false);
});

test('only the empty reason: the specific reason and the retry flag', () => {
  const c = combos.mine;
  assert.equal(reasonOf(c, 'unknown_signature_no_seed'), 'no_seed_for_product');
  assert.equal(reasonOf(c, 'mirror_dead_page'), 'seed_not_servable');
  assert.equal(reasonOf(c, 'seed_lookup_failed'), 'offer_lookup_unavailable');
  assert.equal(retriableOf(c, 'seed_lookup_failed'), true);
  assert.equal(retriableOf(c, 'unknown_signature_no_seed'), false);
  assert.equal(c.description.includes('reason_retriable'), true);
  assert.equal(c.declares_group_id, true);
});

test('both on: the specific reason wins over the generic one, on the real door', () => {
  const c = combos.both;
  assert.equal(reasonOf(c, 'unknown_signature_no_seed'), 'no_seed_for_product');
  assert.equal(reasonOf(c, 'mirror_dead_page'), 'seed_not_servable');
  assert.equal(reasonOf(c, 'seed_lookup_failed'), 'offer_lookup_unavailable');
  assert.equal(retriableOf(c, 'seed_lookup_failed'), true);
  assert.equal(reasonOf(c, 'minted_stale_flagged'), 'offer_needs_live_verification');
  assert.equal(reasonOf(c, 'gbp_only'), 'no_offer_in_market_currency');
  // Both views' declarations apply: this flag's sentences, and the partner door's schema.
  assert.equal(c.description.includes('reason_retriable'), true);
  assert.equal(c.declares_group_id, false);
  // The answers are the empty-reason-only answers, but for what the partner door itself rewrites.
  for (const name of Object.keys(c.answers)) {
    assert.deepEqual(c.answers[name].metadata, combos.mine.answers[name].metadata, name);
  }
});

test('an answer with an offer is the same in all four, and the UCP door never carries a reason', () => {
  for (const [label, c] of Object.entries(combos)) {
    assert.equal(c.answers.minted_fresh_offer.offer_count, 1, label);
    assert.equal('reason' in c.answers.minted_fresh_offer.metadata, false, label);
    assert.equal('reason_retriable' in c.answers.minted_fresh_offer.metadata, false, label);
    assert.match(c.ucp, /offer_count/, label);
    assert.equal(/reason/.test(c.ucp), false, label);
    assert.equal(c.ucp, combos.off.ucp, label);
  }
});

// ---- Part 2: the two real views over a real makeGetOffers --------------------------------------------------

const GROUP = `sig_${'a1'.repeat(12)}`; // a group-shaped id (24 hex)
const SIGNATURE = `sig_${'b2'.repeat(16)}`; // the product signature it resolves to

async function composed({ emptyReason, partnerDoor, backendFor, lookups }) {
  const { makeGetOffers, mapOffersResolveResponse } = require('../src/agentSignals/intelligenceReads');
  const { emptyReasonDoorActive } = require('../src/agentSignals/getOffersEmptyReason');
  const { getOffersEmptyReasonSurface } = await import('../mcp-server/src/getOffersEmptyReasonDoor.js');
  const { partnerDoorSurface } = await import('../mcp-server/src/partnerDoorOneProductId.js');
  const calls = [];
  const getOffers = makeGetOffers({
    emptyReasonDoor: emptyReasonDoorActive,
    fetchOffers: async ({ product_id: productId }) =>
      mapOffersResolveResponse(backendFor(productId), null, ...(emptyReasonDoorActive() ? [{ emptyReason: true }] : [])),
  });
  const surface = {
    tools: [],
    isCommerceTool: () => true,
    async callTool(name, args) {
      calls.push([name, args.product_id]);
      return getOffers({ payload: { ...args, market: 'US' } });
    },
  };
  // The composition src/server.js builds for the `/mcp` adapter.
  const view = partnerDoorSurface(getOffersEmptyReasonSurface(surface, { enabled: emptyReason }), { enabled: partnerDoor, lookups });
  return { view, calls };
}

const resolves = { resolveGroupIdToProductId: async () => ({ status: 'resolved', productId: SIGNATURE }) };

test('both on: an empty answer WITH a reason is still empty to the retry under the signature, which then serves the offer', async () => {
  const { view, calls } = await composed({
    emptyReason: true,
    partnerDoor: true,
    lookups: resolves,
    backendFor: (id) => (id === SIGNATURE ? FIXTURE.minted_fresh_offer : FIXTURE.unknown_signature_no_seed),
  });
  const answer = await view.callTool('get_offers', { product_id: GROUP });
  assert.deepEqual(calls, [['get_offers', GROUP], ['get_offers', SIGNATURE]]);
  assert.equal(answer.metadata.offer_count, 1);
  assert.equal('reason' in answer.metadata, false);
});

test('both on: when the retry is empty too, the first answer stands with its specific reason', async () => {
  const { view, calls } = await composed({
    emptyReason: true,
    partnerDoor: true,
    lookups: resolves,
    backendFor: (id) => (id === SIGNATURE ? FIXTURE.unknown_signature_no_seed : FIXTURE.mirror_dead_page),
  });
  const answer = await view.callTool('get_offers', { product_id: GROUP });
  assert.equal(calls.length, 2);
  assert.equal(answer.metadata.reason, 'seed_not_servable');
  assert.equal(answer.metadata.reason_retriable, false);
});

test('the four combinations of the composed views, on one backend answer', async () => {
  const expected = [
    [false, false, undefined, undefined],
    [false, true, 'no_offer_for_product', undefined],
    [true, false, 'seed_not_servable', false],
    [true, true, 'seed_not_servable', false],
  ];
  for (const [emptyReason, partnerDoor, reason, retriable] of expected) {
    const { view } = await composed({ emptyReason, partnerDoor, lookups: resolves, backendFor: () => FIXTURE.mirror_dead_page });
    const answer = await view.callTool('get_offers', { product_id: SIGNATURE });
    assert.equal(answer.metadata.reason, reason, `${emptyReason}/${partnerDoor}`);
    assert.equal(answer.metadata.reason_retriable, retriable, `${emptyReason}/${partnerDoor}`);
  }
});
