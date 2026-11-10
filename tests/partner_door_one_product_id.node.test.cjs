'use strict';

// PARTNER_DOOR_ONE_PRODUCT_ID: the gateway-side rules on their own (src/services/partnerDoorOneProductId.js and
// the flag-on arm of src/services/commerceKernelErrorMapping.js). The chained door test drives them through the
// real /mcp route; the resolver's SQL runs on PostgreSQL in
// tests/integration/partner_door_group_member_signature_postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const partnerDoor = require('../src/services/partnerDoorOneProductId');
const { mapUpstreamErrorToKernelCode } = require('../src/services/commerceKernelErrorMapping');
const { IDS, fixtureQuery } = require('./_support/partnerDoorFixture.cjs');

test('the flag: off by default, on for the usual spellings only', () => {
  assert.equal(partnerDoor.FLAG_NAME, 'PARTNER_DOOR_ONE_PRODUCT_ID');
  for (const value of [undefined, '', '0', 'off', 'false', 'no', 'shadow', ' ']) {
    assert.equal(partnerDoor.partnerDoorOneProductIdEnabled({ PARTNER_DOOR_ONE_PRODUCT_ID: value }), false, String(value));
  }
  for (const value of ['1', 'on', 'true', 'YES', ' enabled ']) {
    assert.equal(partnerDoor.partnerDoorOneProductIdEnabled({ PARTNER_DOOR_ONE_PRODUCT_ID: value }), true, value);
  }
});

test('the two sig_ namespaces are told apart by length alone', () => {
  assert.equal(partnerDoor.isIdentityGroupIdShape(`sig_${'a'.repeat(24)}`), true);
  assert.equal(partnerDoor.isIdentityGroupIdShape(` SIG_${'A'.repeat(24)} `), true);
  for (const id of [`sig_${'a'.repeat(32)}`, `sig_${'a'.repeat(23)}`, `sig_${'g'.repeat(24)}`, `pg_${'a'.repeat(24)}`, 'brand-x:0123456789abcdef', '', null, 7]) {
    assert.equal(partnerDoor.isIdentityGroupIdShape(id), false, String(id));
  }
  assert.equal(partnerDoor.isCatalogSignatureShape(`sig_${'a'.repeat(32)}`), true);
  assert.equal(partnerDoor.isCatalogSignatureShape(`sig_${'a'.repeat(24)}`), false);
});

test('a group id resolves to one product, or says why not', async () => {
  const resolve = (groupId, queryFn = fixtureQuery) => {
    partnerDoor.usePartnerDoorQueryForTest(queryFn);
    return partnerDoor.resolveGroupIdToProductId({ groupId }).finally(() => partnerDoor.usePartnerDoorQueryForTest(null));
  };
  assert.deepEqual(await resolve(IDS.GROUP_MINTED), { status: 'resolved', productId: IDS.SIG_MINTED });
  assert.deepEqual(await resolve(IDS.GROUP_MINTED.toUpperCase().replace('SIG_', 'sig_')), { status: 'resolved', productId: IDS.SIG_MINTED });
  assert.deepEqual(await resolve(IDS.GROUP_SEVERAL), { status: 'several', count: 2 });
  assert.deepEqual(await resolve(IDS.GROUP_NOT_LIVE), { status: 'none' });
  // Not a group id: never asked.
  assert.deepEqual(await resolve(IDS.SIG_MINTED, async () => { throw new Error('must not be asked'); }), { status: 'none' });
  // The database did not answer, or answered rows that are not signatures.
  assert.deepEqual(await resolve(IDS.GROUP_MINTED, async () => { throw new Error('down'); }), { status: 'unavailable' });
  assert.deepEqual(await resolve(IDS.GROUP_MINTED, async () => ({ rows: [{ pivota_signature_id: 'not-a-signature' }, { pivota_signature_id: null }] })), { status: 'none' });
});

test('with no database there is nothing to ask: no_database, and the seller list is unknown', async () => {
  const prior = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const neverCalled = async () => { throw new Error('must not be asked'); };
    assert.deepEqual(await partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MINTED, queryFn: neverCalled }), { status: 'no_database' });
    assert.equal(await partnerDoor.listSignatureSellerIds({ productId: IDS.SIG_MINTED, queryFn: neverCalled }), null);
  } finally {
    if (prior !== undefined) process.env.DATABASE_URL = prior;
  }
});

test('the sellers of a signature: a list, or null when it could not be asked', async () => {
  partnerDoor.usePartnerDoorQueryForTest(fixtureQuery);
  try {
    assert.deepEqual(await partnerDoor.listSignatureSellerIds({ productId: IDS.SIG_CONNECTED }), [IDS.SELLER_CONNECTED]);
    assert.deepEqual(await partnerDoor.listSignatureSellerIds({ productId: IDS.SIG_NOT_SERVABLE }), []);
    assert.equal(await partnerDoor.listSignatureSellerIds({ productId: 'no-such-product' }), null);
    partnerDoor.usePartnerDoorQueryForTest(async () => { throw new Error('down'); });
    assert.equal(await partnerDoor.listSignatureSellerIds({ productId: IDS.SIG_CONNECTED }), null);
  } finally {
    partnerDoor.usePartnerDoorQueryForTest(null);
  }
});

test('a group id that does not resolve: refused by name, or retriable when the lookup itself failed', () => {
  assert.deepEqual(partnerDoor.groupIdFailure({ status: 'several', count: 2 }, 'get_product_detail'),
    ['PRODUCT_GROUP_ID_NOT_PRODUCT_ID', { reason: 'group_has_several_products', operation: 'get_product_detail' }]);
  assert.deepEqual(partnerDoor.groupIdFailure({ status: 'none' }, 'get_offers'),
    ['PRODUCT_GROUP_ID_NOT_PRODUCT_ID', { reason: 'group_has_no_servable_product', operation: 'get_offers' }]);
  // No database in this process: terminal, never "try again shortly".
  assert.deepEqual(partnerDoor.groupIdFailure({ status: 'no_database' }, 'get_product_detail'),
    ['PRODUCT_GROUP_ID_NOT_PRODUCT_ID', { reason: 'group_id_not_resolvable', operation: 'get_product_detail' }]);
  assert.deepEqual(partnerDoor.groupIdFailure({ status: 'unavailable' }, 'get_product_detail'),
    ['MERCHANT_UNAVAILABLE', { reason: 'group_id_lookup_unavailable', operation: 'get_product_detail' }]);
});

test('the seller check accepts the product\'s own seller and the shared seed seller name for seed supply', () => {
  const ok = partnerDoor.sellerMatchesProduct;
  assert.equal(ok('merch_obs_brandx', 'merch_obs_brandx'), true);
  assert.equal(ok('external_seed', 'merch_obs_brandx'), true);
  assert.equal(ok('external_seed', 'external_seed'), true);
  assert.equal(ok('', 'merch_obs_brandx'), true);
  assert.equal(ok('merch_obs_brandx', ''), true, 'a product that names no seller cannot be checked');
  assert.equal(ok('merch_obs_brandy', 'merch_obs_brandx'), false);
  assert.equal(ok('external_seed', 'merch_shop_a'), false);
  assert.equal(ok('merch_shop_a', 'merch_obs_brandx'), false);
  assert.equal(ok('merch_obs_brandx', 'external_seed'), false);
});

// The mapping. `partnerDoorRead` is only ever passed while the flag is on.
const map = (upstreamCode, status, partnerDoorRead, operation = 'get_product_detail') =>
  mapUpstreamErrorToKernelCode({ operation, upstreamCode, status, ...(partnerDoorRead ? { partnerDoorRead } : {}) });
const PDP_RESOLVED = { lane: 'pdp_v2', statedNotFound: false, resolved: true };
const PDP_UNRESOLVED = { lane: 'pdp_v2', statedNotFound: false, resolved: false };
const BACKEND = { lane: 'backend', statedNotFound: false, resolved: false };

test('without partnerDoorRead the mapping is what it was', () => {
  assert.equal(map('PRODUCT_NOT_SERVABLE', 404), 'NO_MERCHANT_OFFER');
  assert.equal(map('PRODUCT_NOT_FOUND', 404), 'NO_MERCHANT_OFFER');
  assert.equal(map(null, 404), 'NO_MERCHANT_OFFER');
  assert.equal(map('MISSING_MERCHANT_CONTEXT', 400), 'UNKNOWN_PRODUCT_ID');
  assert.equal(map(null, 503), 'MERCHANT_UNAVAILABLE');
});

test('flag on: a product the detail lane resolved and withheld is PRODUCT_NOT_SERVABLE', () => {
  assert.equal(map('PRODUCT_NOT_SERVABLE', 404, PDP_RESOLVED), 'PRODUCT_NOT_SERVABLE');
  assert.equal(map('PRODUCT_NOT_FOUND', 404, PDP_RESOLVED), 'PRODUCT_NOT_SERVABLE');
  assert.equal(map(null, 404, PDP_RESOLVED), 'PRODUCT_NOT_SERVABLE');
});

test('flag on: an id nothing resolved, on either lane, is UNKNOWN_PRODUCT_ID', () => {
  assert.equal(map('PRODUCT_NOT_SERVABLE', 404, PDP_UNRESOLVED), 'UNKNOWN_PRODUCT_ID');
  assert.equal(map('PRODUCT_NOT_FOUND', 404, PDP_UNRESOLVED), 'UNKNOWN_PRODUCT_ID');
  assert.equal(map('MISSING_MERCHANT_CONTEXT', 400, PDP_UNRESOLVED), 'UNKNOWN_PRODUCT_ID');
  assert.equal(map('PRODUCT_NOT_FOUND', 404, BACKEND), 'UNKNOWN_PRODUCT_ID');
  assert.equal(map(null, 404, BACKEND), 'UNKNOWN_PRODUCT_ID');
  assert.equal(map(null, 422, { ...BACKEND, statedNotFound: true }), 'UNKNOWN_PRODUCT_ID');
});

test('flag on: nothing on the single-product read maps to NO_MERCHANT_OFFER, and transient stays retriable', () => {
  for (const read of [PDP_RESOLVED, PDP_UNRESOLVED, BACKEND]) {
    for (const [code, status] of [['PRODUCT_NOT_SERVABLE', 404], ['PRODUCT_NOT_FOUND', 404], [null, 404], ['PRODUCT_NOT_FOUND', 200]]) {
      assert.notEqual(map(code, status, read), 'NO_MERCHANT_OFFER', `${read.lane} ${code} ${status}`);
    }
    for (const [code, status] of [[null, 503], [null, 500], [null, 429], [null, 400], ['TEMPORARY_UNAVAILABLE', 503], [null, null]]) {
      assert.equal(map(code, status, read), 'MERCHANT_UNAVAILABLE', `${read.lane} ${code} ${status}`);
    }
  }
});

test('flag on: every other operation, the money ops included, maps exactly as before', () => {
  const ops = ['find_products', 'find_products_multi', 'offers.resolve', 'preview_quote', 'create_order', 'submit_payment', 'create_payment_link', 'request_after_sales'];
  const signals = [['PRODUCT_NOT_SERVABLE', 404], ['PRODUCT_NOT_FOUND', 404], [null, 404], ['QUOTE_EXPIRED', 409], ['PRICE_CHANGED', 409], ['OUT_OF_STOCK', 409], [null, 503], ['MISSING_MERCHANT_CONTEXT', 400]];
  for (const op of ops) {
    for (const [code, status] of signals) {
      for (const read of [PDP_RESOLVED, BACKEND]) {
        assert.equal(map(code, status, read, op), map(code, status, null, op), `${op} ${code} ${status}`);
      }
    }
  }
  // And the quote codes on the single-product read too.
  for (const [code, expected] of [['QUOTE_EXPIRED', 'QUOTE_EXPIRED'], ['QUOTE_MISMATCH', 'PRICE_CHANGED'], ['OUT_OF_STOCK', 'OUT_OF_STOCK']]) {
    assert.equal(map(code, 404, PDP_RESOLVED), expected);
  }
});

test('what a failed read says: the lane, whether the id resolved, and the gate\'s reason', () => {
  const describe = partnerDoor.describePartnerDoorReadFailure;
  const withheld = { error: 'PRODUCT_NOT_SERVABLE', details: { reason: 'not_serving_eligible' }, metadata: { identity_resolution: { canonicalization_applied: true, resolution_source: 'catalog_products_signature_exact' } } };
  assert.deepEqual(describe({ extracted: { data: withheld }, pdpV2Detail: true }), {
    partnerDoorRead: { lane: 'pdp_v2', statedNotFound: false, resolved: true }, reason: 'not_serving_eligible',
  });
  const unresolved = { error: 'PRODUCT_NOT_FOUND', details: null, metadata: { identity_resolution: { canonicalization_applied: false, resolution_source: 'requested_route' } } };
  assert.deepEqual(describe({ extracted: { data: unresolved }, pdpV2Detail: true }), {
    partnerDoorRead: { lane: 'pdp_v2', statedNotFound: false, resolved: false }, reason: null,
  });
  assert.deepEqual(describe({ extracted: { data: { detail: 'PRODUCT_NOT_FOUND' } }, pdpV2Detail: false }), {
    partnerDoorRead: { lane: 'backend', statedNotFound: true, resolved: false }, reason: null,
  });
  // A reason that is not our vocabulary is never carried; a body that is not an object says nothing.
  assert.equal(describe({ extracted: { data: { details: { reason: 'Seller A refused <b>' } } }, pdpV2Detail: true }).reason, null);
  assert.deepEqual(describe({ extracted: { data: 'gateway timeout' }, pdpV2Detail: false }), {
    partnerDoorRead: { lane: 'backend', statedNotFound: false, resolved: false }, reason: null,
  });
  assert.deepEqual(describe({}).partnerDoorRead, { lane: 'backend', statedNotFound: false, resolved: false });
  assert.equal(partnerDoor.partnerDoorReadFailureReason('PRODUCT_NOT_SERVABLE', null), 'product_detail_not_found');
  assert.equal(partnerDoor.partnerDoorReadFailureReason('PRODUCT_NOT_SERVABLE', 'not_serving_eligible'), 'not_serving_eligible');
  assert.equal(partnerDoor.partnerDoorReadFailureReason('UNKNOWN_PRODUCT_ID', null), 'product_id_not_found');
  assert.equal(partnerDoor.partnerDoorReadFailureReason('MERCHANT_UNAVAILABLE', 'not_serving_eligible'), null);
});

// get_offers behind the door.
const failWith = async (code, detail) => { throw Object.assign(new Error(code), { code, detail }); };

test('get_offers, flag off: the inner read is called with exactly what it was given', async () => {
  const seen = [];
  const answer = { subject: { id: 'x' }, best_offer: null, signals: [], metadata: { product_group_id: `sig_${'1'.repeat(24)}` } };
  const getOffers = partnerDoor.makePartnerDoorGetOffers({
    getOffers: async (...args) => { seen.push(args); return answer; }, fail: failWith, enabled: () => false,
  });
  const params = { payload: { product_group_id: IDS.GROUP_MINTED } };
  const ctx = { user_ref: 'u' };
  assert.equal(await getOffers(params, ctx), answer);
  assert.equal(seen[0][0], params);
  assert.equal(seen[0][1], ctx);
});

test('get_offers, flag on: a group id is resolved, an empty answer says why, no sig_ group id is echoed', async () => {
  partnerDoor.usePartnerDoorQueryForTest(fixtureQuery);
  try {
    const seen = [];
    const inner = (answer) => async (params) => { seen.push(params); return answer; };
    const on = (answer) => partnerDoor.makePartnerDoorGetOffers({ getOffers: inner(answer), fail: failWith, enabled: () => true });
    const offer = { signal_type: 'offer' };
    const served = await on({ subject: {}, best_offer: offer, signals: [offer], metadata: { offer_count: 1, product_group_id: IDS.GROUP_MINTED } })(
      { payload: { product_id: IDS.GROUP_MINTED, market: 'US' }, live_read: true });
    assert.deepEqual(seen.pop(), { payload: { product_id: IDS.SIG_MINTED, market: 'US' }, live_read: true });
    assert.deepEqual(served.metadata, { offer_count: 1, product_group_id: null });
    assert.equal(served.best_offer, offer);
    // Unwrapped params (the shape a direct caller uses).
    await on({ best_offer: offer, signals: [offer], metadata: {} })({ product_id: IDS.GROUP_MINTED });
    assert.deepEqual(seen.pop(), { product_id: IDS.SIG_MINTED });
    // A signature passes through as given.
    const params = { payload: { product_id: IDS.SIG_MINTED } };
    await on({ best_offer: offer, signals: [offer], metadata: { product_group_id: 'pg_1' } })(params);
    assert.equal(seen.pop(), params);
    // Empty: a reason, unless the read already gave one.
    assert.equal((await on({ best_offer: null, signals: [], metadata: { offer_count: 0 } })(params)).metadata.reason, 'no_offer_for_product');
    assert.equal((await on({ best_offer: null, signals: [], metadata: { reason: 'market_not_priced' } })(params)).metadata.reason, 'market_not_priced');
    assert.equal((await on({ best_offer: offer, signals: [offer], metadata: {} })(params)).metadata.reason, undefined);
    assert.equal((await on({ best_offer: offer, signals: [offer], metadata: { product_group_id: 'pg_1' } })(params)).metadata.product_group_id, 'pg_1');
    // Refusals: nothing is read.
    seen.length = 0;
    await assert.rejects(on({})({ payload: { product_id: IDS.GROUP_SEVERAL } }), (e) => e.code === 'PRODUCT_GROUP_ID_NOT_PRODUCT_ID' && e.detail.reason === 'group_has_several_products');
    await assert.rejects(on({})({ payload: { product_group_id: IDS.GROUP_MINTED } }), (e) => e.code === 'PRODUCT_GROUP_ID_NOT_PRODUCT_ID' && e.detail.reason === 'product_group_id_argument');
    partnerDoor.usePartnerDoorQueryForTest(async () => { throw new Error('down'); });
    await assert.rejects(on({})({ payload: { product_id: IDS.GROUP_MINTED } }), (e) => e.code === 'MERCHANT_UNAVAILABLE' && e.detail.reason === 'group_id_lookup_unavailable');
    assert.deepEqual(seen, []);
  } finally {
    partnerDoor.usePartnerDoorQueryForTest(null);
  }
});
