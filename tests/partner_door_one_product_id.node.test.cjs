'use strict';

// PARTNER_DOOR_ONE_PRODUCT_ID: the gateway-side rules on their own (src/services/partnerDoorOneProductId.js).
// The chained door test drives them through the real /mcp route; the group lookup and the statements run on
// PostgreSQL in tests/integration/partner_door_group_member_signature_postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const partnerDoor = require('../src/services/partnerDoorOneProductId');
const { IDS, GROUP_PRODUCT, fixtureQuery, groupLookup } = require('./_support/partnerDoorFixture.cjs');

const withStandIns = async (fn, { query = fixtureQuery, lookup = groupLookup } = {}) => {
  partnerDoor.usePartnerDoorQueryForTest(query);
  partnerDoor.usePartnerDoorGroupLookupForTest(lookup);
  try {
    return await fn();
  } finally {
    partnerDoor.usePartnerDoorQueryForTest(null);
    partnerDoor.usePartnerDoorGroupLookupForTest(null);
  }
};

test('the flag: off by default, on for the usual spellings only', () => {
  assert.equal(partnerDoor.FLAG_NAME, 'PARTNER_DOOR_ONE_PRODUCT_ID');
  for (const value of [undefined, '', '0', 'off', 'false', 'no', 'shadow', ' ']) {
    assert.equal(partnerDoor.partnerDoorOneProductIdEnabled({ PARTNER_DOOR_ONE_PRODUCT_ID: value }), false, String(value));
  }
  for (const value of ['1', 'on', 'true', 'YES', ' enabled ']) {
    assert.equal(partnerDoor.partnerDoorOneProductIdEnabled({ PARTNER_DOOR_ONE_PRODUCT_ID: value }), true, value);
  }
});

test('THE FLAG ACTS ON /mcp ONLY: the gateway reaches this module through the /mcp adapter\'s surface and nowhere else', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  // One wiring line, at the /mcp adapter. The UCP door projects the bare surface; the public door builds its own.
  assert.equal((server.match(/partnerDoorSurface\(/g) || []).length, 1);
  // It wraps the door's other view (GET_OFFERS_EMPTY_REASON, the surface itself while that flag is off), so its
  // get_offers calls go through that view and a reason already on an empty answer is kept.
  // (Innermost is the door's storefront-cart view, which touches the checkout tools only and is the surface's own
  // answer while AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED is off.)
  assert.match(server, /return createRemoteMcpAdapter\(partnerDoorSurface\(getOffersEmptyReasonSurface\(mcpStorefrontCartSurface\(surface\)\), \{ log: logger \}\), \{\s+serverInfo: \{ name: 'pivota-commerce-mcp'/);
  assert.equal((server.match(/mcpStorefrontCartSurface\(/g) || []).length, 1);
  assert.equal((server.match(/getOffersEmptyReasonSurface\(/g) || []).length, 1);
  assert.match(server, /const surface = ucpDialectSurface\(await getCommerceToolSurface\(\)\);/);
  // The kernel hop, the executor wiring and the error mapping do not know the flag.
  assert.equal(server.includes("services/partnerDoorOneProductId'"), false);
  assert.equal(server.includes('partnerDoorOneProductIdEnabled'), false);
  for (const file of ['src/services/commerceKernelErrorMapping.js', 'safety-kernel/src/protocol/canonicalExecutor.js', 'mcp-server/src/publicReadToolSurface.js', 'mcp-server/src/ucpResponseShaper.js']) {
    assert.equal(fs.readFileSync(path.join(__dirname, '..', file), 'utf8').includes('PARTNER_DOOR'), false, file);
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

test('a group id resolves to the member the group lookup elects; one product listed by two sellers is not refused', async () => {
  await withStandIns(async () => {
    for (const [groupId, signature] of Object.entries(GROUP_PRODUCT)) {
      assert.deepEqual(await partnerDoor.resolveGroupIdToProductId({ groupId }), signature ? { status: 'resolved', productId: signature } : { status: 'none' }, groupId);
    }
    assert.deepEqual(await partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_SHARED }), { status: 'resolved', productId: IDS.SIG_SHARED_BRAND });
    assert.deepEqual(await partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MINTED.replace('sig_', 'SIG_') }), { status: 'resolved', productId: IDS.SIG_MINTED });
  });
});

test('the refs are tried in the lookup\'s order: canonical member, commerce member, then the rest, each once', () => {
  const a = { merchant_id: 'm_a', product_id: 'p_a' };
  const b = { merchant_id: 'm_b', product_id: 'p_b' };
  const c = { merchant_id: 'm_c', product_id: 'p_c', pivota_signature_id: `SIG_${'A'.repeat(32)}` };
  assert.deepEqual(partnerDoor.orderedGroupRefs({ canonical_product_ref: b, selected_commerce_ref: a, group_members: [a, c, b, { merchant_id: 'm_d' }, null] }), [
    { ...b, pivota_signature_id: '' }, { ...a, pivota_signature_id: '' }, { ...c, pivota_signature_id: `sig_${'a'.repeat(32)}` },
  ]);
  assert.deepEqual(partnerDoor.orderedGroupRefs(null), []);
  assert.deepEqual(partnerDoor.orderedGroupRefs({ group_members: 'x' }), []);
});

test('a lookup whose canonical member already names its signature needs no statement', async () => {
  const signature = `sig_${'7'.repeat(32)}`;
  const answer = await withStandIns(() => partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MINTED }), {
    query: async () => { throw new Error('must not be asked'); },
    lookup: async () => ({ canonical_product_ref: { merchant_id: 'm', product_id: 'p', pivota_signature_id: signature }, group_members: [] }),
  });
  assert.deepEqual(answer, { status: 'resolved', productId: signature });
});

test('the group lookup is handed the id and a statement runner; what it cannot answer is told apart', async () => {
  const seen = [];
  await withStandIns(() => partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MINTED }), {
    lookup: async (args) => { seen.push(args); return groupLookup(args); },
  });
  assert.equal(seen[0].productGroupId, IDS.GROUP_MINTED);
  assert.equal(typeof seen[0].queryFn, 'function');
  // Not a group id: nothing is asked.
  const never = async () => { throw new Error('must not be asked'); };
  assert.deepEqual(await withStandIns(() => partnerDoor.resolveGroupIdToProductId({ groupId: IDS.SIG_MINTED }), { query: never, lookup: never }), { status: 'none' });
  // The lookup threw, or the statement after it did: unavailable.
  assert.deepEqual(await withStandIns(() => partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MINTED }), { lookup: async () => { throw new Error('down'); } }), { status: 'unavailable' });
  assert.deepEqual(await withStandIns(() => partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MINTED }), { query: async () => { throw new Error('down'); } }), { status: 'unavailable' });
  // The lookup SWALLOWED a failed statement and answered "no group": still unavailable, never "none".
  const swallowing = async ({ queryFn }) => { try { await queryFn('select 1', []); } catch (_) { /* swallowed */ } return null; };
  assert.deepEqual(await withStandIns(() => partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MINTED }), { query: async () => { throw new Error('down'); }, lookup: swallowing }), { status: 'unavailable' });
  assert.deepEqual(await withStandIns(() => partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MINTED }), { query: async () => ({ rows: [] }), lookup: swallowing }), { status: 'none' });
  // A row that is not a signature resolves nothing.
  assert.deepEqual(await withStandIns(() => partnerDoor.resolveGroupIdToProductId({ groupId: IDS.GROUP_MINTED }), { query: async () => ({ rows: [{ pivota_signature_id: 'not-a-signature' }] }) }), { status: 'none' });
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

test('every statement the door sends is bounded: 1.5 s by default, configurable within 50 ms..10 s', () => {
  assert.equal(partnerDoor.DEFAULT_LOOKUP_BUDGET_MS, 1500);
  assert.equal(partnerDoor.lookupBudgetMs({}), 1500);
  assert.equal(partnerDoor.lookupBudgetMs({ PARTNER_DOOR_LOOKUP_BUDGET_MS: '400' }), 400);
  for (const value of ['0', '49', '10001', '-5', 'fast', '']) assert.equal(partnerDoor.lookupBudgetMs({ PARTNER_DOOR_LOOKUP_BUDGET_MS: value }), 1500, value);
  // The default runner is the pool's budgeted query, with that budget.
  const db = require('../src/db');
  const original = db.queryWithBudget;
  const priorUrl = process.env.DATABASE_URL;
  const calls = [];
  db.queryWithBudget = async (sql, params, options) => { calls.push({ sql, params, options }); return { rows: [{ merchant_id: 'merch_shop_a' }] }; };
  process.env.DATABASE_URL = 'postgres://partner-door.test/none';
  return partnerDoor.listSignatureSellerIds({ productId: IDS.SIG_CONNECTED }).then((sellers) => {
    assert.deepEqual(sellers, ['merch_shop_a']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options, { timeoutMs: 1500 });
    assert.deepEqual(calls[0].params, [IDS.SIG_CONNECTED]);
  }).finally(() => {
    db.queryWithBudget = original;
    if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
  });
});

test('the sellers of a signature: a list, or null when it could not be asked', async () => {
  await withStandIns(async () => {
    assert.deepEqual(await partnerDoor.listSignatureSellerIds({ productId: IDS.SIG_CONNECTED }), [IDS.SELLER_CONNECTED]);
    assert.deepEqual(await partnerDoor.listSignatureSellerIds({ productId: IDS.SIG_NOT_SERVABLE }), []);
    assert.equal(await partnerDoor.listSignatureSellerIds({ productId: 'no-such-product' }), null);
  });
  assert.equal(await withStandIns(() => partnerDoor.listSignatureSellerIds({ productId: IDS.SIG_CONNECTED }), { query: async () => { throw new Error('down'); } }), null);
});

test('a group id that does not resolve: refused by name, or retriable only when the lookup itself failed', () => {
  assert.deepEqual(partnerDoor.groupIdFailure({ status: 'none' }, 'get_offers'),
    ['PRODUCT_GROUP_ID_NOT_PRODUCT_ID', { reason: 'group_has_no_servable_product', operation: 'get_offers' }]);
  assert.deepEqual(partnerDoor.groupIdFailure({ status: 'no_database' }, 'get_product'),
    ['PRODUCT_GROUP_ID_NOT_PRODUCT_ID', { reason: 'group_id_not_resolvable', operation: 'get_product' }]);
  assert.deepEqual(partnerDoor.groupIdFailure({ status: 'unavailable' }, 'get_product'),
    ['MERCHANT_UNAVAILABLE', { reason: 'group_id_lookup_unavailable', operation: 'get_product' }]);
});

test('the seller a product IS: its own merchant_id, never a seller it merely lists', () => {
  assert.deepEqual([...partnerDoor.sellersNamedByProduct({
    merchant_id: ' m_own ', canonical_product_ref: { merchant_id: 'm_canonical' }, product_ref: { merchant_id: 'm_ref' },
    selected_commerce_ref: { merchant_id: 'm_commerce' }, group_members: [{ merchant_id: 'm_member' }], members: [{ merchant_id: 'm_member2' }],
    other_seller_listings: [{ merchant_id: 'm_other' }], offers: [{ merchant_id: 'm_offer' }], variants: [{ merchant_id: 'm_variant' }],
  })], ['m_own']);
  assert.deepEqual([...partnerDoor.sellersNamedByProduct({ group_members: [{ merchant_id: 'm_member' }] })], []);
  assert.deepEqual([...partnerDoor.sellersNamedByProduct(null)], []);
});

test('the seller check: any seller the product is known under; the seed seller names stand for each other both ways', () => {
  const ok = partnerDoor.sellerAmong;
  assert.equal(ok('merch_obs_brandx', ['merch_obs_brandx']), true);
  assert.equal(ok(' merch_obs_brandx ', ['merch_obs_brandx']), true);
  assert.equal(ok('merch_shop_a', ['merch_obs_brandx', 'merch_shop_a']), true, 'one of the signature\'s row sellers');
  // Seed supply, both directions.
  assert.equal(ok('external_seed', ['merch_obs_brandx']), true);
  assert.equal(ok('merch_obs_brandx', ['external_seed']), true);
  assert.equal(ok('external_seed', ['external_seed']), true);
  // Nothing to compare.
  assert.equal(ok('', ['merch_obs_brandx']), true);
  assert.equal(ok('merch_obs_brandx', []), true, 'a product that names no seller cannot be checked');
  assert.equal(ok('merch_obs_brandx', null), true);
  // A seller that belongs to neither.
  assert.equal(ok('merch_obs_brandy', ['merch_obs_brandx']), false, 'one observed seller is not another');
  assert.equal(ok('external_seed', ['merch_shop_a']), false, 'the seed seller name is not a connected merchant');
  assert.equal(ok('merch_shop_a', ['external_seed']), false);
  assert.equal(ok('merch_shop_a', ['merch_obs_brandx']), false);
  assert.equal(ok('merch_shop_b', ['merch_shop_a']), false);
  // Against a product: its own seller, not a sibling it lists.
  assert.equal(partnerDoor.sellerMatchesProduct('merch_obs_brandw', { merchant_id: 'merch_obs_brandw', group_members: [{ merchant_id: 'merch_shop_a' }] }), true);
  assert.equal(partnerDoor.sellerMatchesProduct('merch_shop_a', { merchant_id: 'merch_obs_brandw', group_members: [{ merchant_id: 'merch_shop_a' }] }), false);
  assert.equal(partnerDoor.sellerMatchesProduct('merch_obs_brandt', { merchant_id: 'merch_obs_brandw', other_seller_listings: [{ merchant_id: 'merch_obs_brandt' }] }), false);
});

// The kernel's refusal, as throwCommerceKernelUpstreamError throws it.
const kernelRefusal = (upstreamDetail, over = {}) => ({
  code: 'NO_MERCHANT_OFFER',
  detail: { operation: 'get_product_detail', upstream_status: 404, upstream_code: null, upstream_detail: upstreamDetail, ...over },
});
const RESOLVED = { canonicalization_applied: true, resolution_source: 'catalog_products_signature_exact' };
const SIG = IDS.SIG_NOT_SERVABLE;

test('one fact per code: a product the detail lane resolved and withheld is PRODUCT_NOT_SERVABLE, with the gate\'s reason', () => {
  const withheld = { error: 'PRODUCT_NOT_SERVABLE', details: { reason: 'not_serving_eligible' }, metadata: { identity_resolution: RESOLVED } };
  for (const merchantId of [undefined, '', 'external_seed', 'merch_obs_brandx']) {
    assert.deepEqual(partnerDoor.remapReadFailure({ ...kernelRefusal(withheld), merchantId, productId: SIG }), { code: 'PRODUCT_NOT_SERVABLE', reason: 'not_serving_eligible' }, String(merchantId));
  }
  // No reason, or one that is not our vocabulary: the fixed reason.
  for (const details of [null, {}, { reason: 'Seller A refused <b>' }, { reason: 'x'.repeat(65) }]) {
    assert.deepEqual(partnerDoor.remapReadFailure({ ...kernelRefusal({ ...withheld, details }), productId: SIG }), { code: 'PRODUCT_NOT_SERVABLE', reason: 'product_detail_not_found' });
  }
  // Resolved by either signal.
  assert.equal(partnerDoor.remapReadFailure({ ...kernelRefusal({ metadata: { identity_resolution: { canonicalization_applied: false, resolution_source: 'identity_graph_product_group_alias' } } }), productId: SIG }).code, 'PRODUCT_NOT_SERVABLE');
  assert.equal(partnerDoor.remapReadFailure({ ...kernelRefusal({ metadata: { identity_resolution: { canonicalization_applied: true, resolution_source: 'requested_route' } } }), productId: SIG }).code, 'PRODUCT_NOT_SERVABLE');
});

test('one fact per code: an id nothing resolved, on either lane, is UNKNOWN_PRODUCT_ID', () => {
  const unknown = { code: 'UNKNOWN_PRODUCT_ID', reason: 'product_id_not_found' };
  for (const body of [
    { error: 'PRODUCT_NOT_FOUND', metadata: { identity_resolution: { canonicalization_applied: false, resolution_source: 'requested_route' } } },
    { error: 'PRODUCT_NOT_SERVABLE', details: { reason: 'serving_eligibility_missing' }, metadata: { identity_resolution: { canonicalization_applied: false, resolution_source: null } } },
    { error: 'PRODUCT_NOT_FOUND' },
    'PRODUCT_NOT_FOUND',
    undefined,
  ]) {
    assert.deepEqual(partnerDoor.remapReadFailure({ ...kernelRefusal(body), productId: SIG }), unknown, JSON.stringify(body));
  }
  // The per-merchant backend's not-found, whatever body it carries: that merchant has no such product.
  const resolvedBody = { error: 'PRODUCT_NOT_SERVABLE', details: { reason: 'not_serving_eligible' }, metadata: { identity_resolution: RESOLVED } };
  assert.deepEqual(partnerDoor.remapReadFailure({ ...kernelRefusal(resolvedBody), merchantId: 'merch_shop_a', productId: SIG }), unknown);
  assert.deepEqual(partnerDoor.remapReadFailure({ ...kernelRefusal('PRODUCT_NOT_FOUND'), merchantId: 'merch_shop_a', productId: '9001' }), unknown);
  // The shared seed seller with an id that is not a signature goes to the backend too.
  assert.deepEqual(partnerDoor.remapReadFailure({ ...kernelRefusal(resolvedBody), merchantId: 'external_seed', productId: 'ext_1' }), unknown);
});

test('every other error is left alone: only the kernel\'s NO_MERCHANT_OFFER for the single-product read is re-read', () => {
  const body = { error: 'PRODUCT_NOT_SERVABLE', details: { reason: 'not_serving_eligible' }, metadata: { identity_resolution: RESOLVED } };
  for (const code of ['MERCHANT_UNAVAILABLE', 'UNKNOWN_PRODUCT_ID', 'QUOTE_EXPIRED', 'PRICE_CHANGED', 'OUT_OF_STOCK', 'USER_AUTH_REQUIRED', 'INVALID_ARGUMENTS', undefined]) {
    assert.equal(partnerDoor.remapReadFailure({ ...kernelRefusal(body), code, productId: SIG }), null, String(code));
  }
  // NO_MERCHANT_OFFER from anywhere else (another operation, a refusal with its own reason, no detail at all).
  for (const detail of [{ operation: 'find_products_multi', upstream_detail: body }, { operation: 'offers.resolve' }, { reason: 'merchant_not_purchasable' }, { reason: 'ucp_product_unpriced', dialect: 'ucp' }, null, undefined, 'x']) {
    assert.equal(partnerDoor.remapReadFailure({ code: 'NO_MERCHANT_OFFER', detail, productId: SIG }), null, JSON.stringify(detail));
  }
  assert.equal(partnerDoor.remapReadFailure(), null);
});
