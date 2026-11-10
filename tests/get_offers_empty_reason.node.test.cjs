'use strict';

// GET_OFFERS_EMPTY_REASON below the door: the classifier (pure), and the two reasons that need the STORE's
// live answer, which makeGetOffers reaches through the real live reader (services/ucpLiveOfferRead) over a
// fake store client answering in the store's own shape.

const test = require('node:test');
const assert = require('node:assert/strict');

// The live reader's budget timers are unref'd; keep the loop alive for the file (see ucp_live_offer_read).
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
test.after(() => clearInterval(keepAlive));

const { createUcpLiveOfferReader } = require('../src/services/ucpLiveOfferRead');
const { makeGetOffers, mapOffersResolveResponse } = require('../src/agentSignals/intelligenceReads');
const {
  EMPTY_REASONS, runOnEmptyReasonDoor, emptyReasonDoorActive, emptyReasonFromOffersResolve, decideEmptyReason,
} = require('../src/agentSignals/getOffersEmptyReason');
const FIXTURE = require('./fixtures/offers_resolve_empty_answers.json');

const HOST = 'brand-x.example';
const VID = '44000000000001';

function toolResult(payload) {
  return { ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}

/** A store's UCP endpoint: `variants` it has for the asked ids; `hang` never answers. */
function storeClient({ variants = [], hang = false } = {}) {
  return {
    async discoverEndpoint(base) {
      return { mcpEndpoint: `${base}/api/ucp/mcp` };
    },
    async lookupCatalog(_endpoint, { ids }) {
      if (hang) return new Promise(() => {});
      const have = variants.filter((v) => ids.includes(v.id));
      return toolResult({
        ucp: { version: '2026-08-25' },
        products: have.length ? [{ id: 'gid://shopify/Product/1', handle: 'calm-barrier-cream', variants: have }] : [],
        messages: ids.filter((id) => !have.some((v) => v.id === id)).map((id) => ({ type: 'info', code: 'not_found', content: id })),
      });
    },
  };
}

// The recorded flagged offer (a stale minted seed, backend opted in), given the one thing a live read needs
// and a synthetic seed lacks: the store's own numeric variant id.
function flaggedOffer() {
  const offer = JSON.parse(JSON.stringify(FIXTURE.minted_stale_flagged.offers[0]));
  offer.requires_live_verification = { ...offer.requires_live_verification, lookup_variant_id: VID };
  return offer;
}

function getOffersOnDoor(store, { budgetMs } = {}) {
  const reader = createUcpLiveOfferReader({ ucpClient: store, mode: 'enforce', ...(budgetMs ? { budgetMs } : {}) });
  const getOffers = makeGetOffers({
    emptyReasonDoor: emptyReasonDoorActive,
    liveVerificationOptIn: () => true,
    readOffersLive: (offers, ctx) => reader.readOffers(offers, ctx),
    fetchOffers: async () => mapOffersResolveResponse({ ...FIXTURE.minted_stale_flagged, offers: [flaggedOffer()] }, null, { emptyReason: emptyReasonDoorActive() }),
  });
  return (payload) => runOnEmptyReasonDoor(() => getOffers({ payload }));
}

test('the store no longer lists the item: seed_out_of_stock, not retriable', async () => {
  const res = await getOffersOnDoor(storeClient({ variants: [] }))({ product_id: 'sig_x', market: 'US' });
  assert.equal(res.metadata.offer_count, 0);
  assert.deepEqual(res.metadata.live_read.by_status, { variant_gone: 1 });
  assert.equal(res.metadata.reason, 'seed_out_of_stock');
  assert.equal(res.metadata.reason_retriable, false);
});

test('the store did not answer in time: offer_needs_live_verification, retriable', async () => {
  const res = await getOffersOnDoor(storeClient({ hang: true }), { budgetMs: 30 })({ product_id: 'sig_x', market: 'US' });
  assert.equal(res.metadata.offer_count, 0);
  assert.equal(res.metadata.reason, 'offer_needs_live_verification');
  assert.equal(res.metadata.reason_retriable, true);
});

test('the store just confirmed the offer: it is served, and no reason is given', async () => {
  const live = { id: `gid://shopify/ProductVariant/${VID}`, title: 'Default', sku: 'S1', price: { amount: 2100, currency: 'USD' }, availability: { available: true } };
  const res = await getOffersOnDoor(storeClient({ variants: [live] }))({ product_id: 'sig_x', market: 'US' });
  assert.equal(res.metadata.offer_count, 1);
  assert.equal('reason' in res.metadata, false);
  assert.equal('reason_retriable' in res.metadata, false);
});

test('the same call OFF the door keeps the reason it always had and gains nothing', async () => {
  const reader = createUcpLiveOfferReader({ ucpClient: storeClient({ variants: [] }), mode: 'enforce' });
  const res = await makeGetOffers({
    emptyReasonDoor: emptyReasonDoorActive,
    liveVerificationOptIn: () => true,
    readOffersLive: (offers, ctx) => reader.readOffers(offers, ctx),
    fetchOffers: async () => ({ offers: [flaggedOffer()] }),
  })({ payload: { product_id: 'sig_x', market: 'US' } });
  assert.equal(res.metadata.reason, 'offer_needs_live_verification');
  assert.equal('reason_retriable' in res.metadata, false);
});

test('the classifier, on the recorded backend answers', () => {
  const expected = {
    minted_flag_off_no_seed: 'no_seed_for_product',
    unknown_signature_no_seed: 'no_seed_for_product',
    mirror_usd_seed_sg_buyer: 'seed_not_in_market',
    mirror_dead_page: 'seed_not_servable',
    minted_stale_held: 'offer_needs_live_verification',
    seed_lookup_failed: 'offer_lookup_unavailable',
  };
  for (const [name, reason] of Object.entries(expected)) assert.equal(emptyReasonFromOffersResolve(FIXTURE[name]), reason, name);
});

test('the classifier, on shapes the backend can also send', () => {
  const held = (blockers) => ({ metadata: { sources: [{ source: 'external_product_seeds', status: 'ok', row_count: 1 }] },
    mapping: { candidates: [{ kind: 'external_seed', reason: 'external_seed_requires_live_verification', blockers }] } });
  assert.equal(emptyReasonFromOffersResolve(held(['stale_snapshot'])), 'offer_needs_live_verification');
  assert.equal(emptyReasonFromOffersResolve(held(['destination_stale', 'destination_never_verified'])), 'offer_needs_live_verification');
  // A market or currency blocker is not a freshness question, alone or beside one.
  assert.equal(emptyReasonFromOffersResolve(held(['locale_market_mismatch'])), 'seed_not_in_market');
  assert.equal(emptyReasonFromOffersResolve(held(['price_currency_mismatch', 'stale_snapshot'])), 'seed_not_in_market');
  assert.equal(emptyReasonFromOffersResolve(held(['zero_variants'])), 'seed_not_servable');
  assert.equal(emptyReasonFromOffersResolve(held([])), 'seed_not_servable');
  // The group lane's source counts as a seed lookup; nothing at all is the generic token.
  assert.equal(emptyReasonFromOffersResolve({ metadata: { sources: [{ source: 'external_product_seeds_group_siblings', status: 'ok', row_count: 0 }] } }), 'no_seed_for_product');
  const said = { reason: 'free text', reason_code: 'FREE_TEXT', empty_reason: 'free text', error: 'free text' };
  for (const junk of [null, undefined, 'x', 7, [], {}, { metadata: 'x', mapping: [] }, { metadata: { sources: 'x' }, mapping: { candidates: 'y' } },
    { ...said, metadata: { ...said }, mapping: { candidates: [{ kind: 'external_seed', reason: 'free text', blockers: ['free text'] }] } }]) {
    assert.equal(emptyReasonFromOffersResolve(junk), 'no_offer_for_product');
    assert.equal(mapOffersResolveResponse(junk, null, { emptyReason: true }).empty_reason, 'no_offer_for_product');
  }
  // A token the backend sends as its own `empty_reason` is not read either.
  assert.equal(mapOffersResolveResponse({ offers: [], empty_reason: 'offer_lookup_unavailable', metadata: { empty_reason: 'seed_not_in_market' } }, null, { emptyReason: true }).empty_reason, 'no_offer_for_product');
});

test('decideEmptyReason only ever returns a token from the vocabulary or the reason it was handed', () => {
  const vocabulary = new Set(Object.values(EMPTY_REASONS));
  for (const backend of ['<script>', 'NO_CANDIDATES', 'no candidates', '', null, 42, {}, 'offer_needs_live_verification ']) {
    assert.deepEqual(decideEmptyReason({ backend }), { reason: 'no_offer_for_product', retriable: false });
  }
  for (const backend of vocabulary) {
    assert.deepEqual(decideEmptyReason({ backend }), { reason: backend, retriable: backend === 'offer_lookup_unavailable' });
  }
  // makeGetOffers' own reason wins over the backend's.
  assert.deepEqual(decideEmptyReason({ current: 'variant_not_offered', backend: 'no_seed_for_product' }), { reason: 'variant_not_offered', retriable: false });
  const o = (status) => ({ live_read: status ? { status } : undefined });
  const live = (...statuses) => decideEmptyReason({ current: 'offer_needs_live_verification', unverified: statuses.map(o) });
  assert.deepEqual(live('variant_gone', 'variant_gone'), { reason: 'seed_out_of_stock', retriable: false });
  assert.deepEqual(live('variant_gone', 'not_ucp'), { reason: 'offer_needs_live_verification', retriable: false });
  assert.deepEqual(live('variant_gone', 'timeout'), { reason: 'offer_needs_live_verification', retriable: true });
  assert.deepEqual(live('error'), { reason: 'offer_needs_live_verification', retriable: true });
  assert.deepEqual(live('skipped'), { reason: 'offer_needs_live_verification', retriable: false });
  assert.deepEqual(live(null), { reason: 'offer_needs_live_verification', retriable: false });
  assert.deepEqual(live(), { reason: 'offer_needs_live_verification', retriable: false });
});

test('the mapper adds empty_reason only when asked and only to an empty answer', () => {
  assert.equal('empty_reason' in mapOffersResolveResponse(FIXTURE.minted_stale_held, null), false);
  assert.equal('empty_reason' in mapOffersResolveResponse(FIXTURE.minted_stale_held, null, {}), false);
  assert.equal('empty_reason' in mapOffersResolveResponse(FIXTURE.minted_stale_held, null, { emptyReason: 'yes' }), false);
  assert.equal(mapOffersResolveResponse(FIXTURE.minted_stale_held, null, { emptyReason: true }).empty_reason, 'offer_needs_live_verification');
  assert.equal('empty_reason' in mapOffersResolveResponse(FIXTURE.minted_fresh_offer, null, { emptyReason: true }), false);
});

test('the door is open only inside its own call', async () => {
  assert.equal(emptyReasonDoorActive(), false);
  const inside = await runOnEmptyReasonDoor(async () => {
    await new Promise((r) => setImmediate(r));
    return emptyReasonDoorActive();
  });
  assert.equal(inside, true);
  assert.equal(emptyReasonDoorActive(), false);
});

test('on the door, a fetch result naming a reason outside the vocabulary is never served', async () => {
  for (const planted of ['free text from somewhere', 'NO_CANDIDATES', '<b>x</b>', 42, { a: 1 }]) {
    const res = await runOnEmptyReasonDoor(() => makeGetOffers({
      emptyReasonDoor: emptyReasonDoorActive,
      fetchOffers: async () => ({ offers: [], empty_reason: planted }),
    })({ payload: { product_id: 'sig_x', market: 'US' } }));
    assert.equal(res.metadata.reason, 'no_offer_for_product');
    assert.equal(res.metadata.reason_retriable, false);
  }
});
