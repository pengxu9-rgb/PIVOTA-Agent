'use strict';

// FIX_PLAN D-06: search served `<host-slug>:<hash>` ids under the retired `external_seed` bucket that
// get_product answers NO_MERCHANT_OFFER for (11-02 synthetic run: 6 rows, 4 hosts). Search must not serve
// them; every other id keeps serving.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.PIVOTA_API_BASE = 'http://backend.legacy-seed-ids.test';
process.env.PIVOTA_API_KEY = 'backend_test_key';
// find_products_multi is served over loopback by this gateway's own invoke route; intercept that hop too.
process.env.SELF_INVOKE_BASE = 'http://self.legacy-seed-ids.test';

const nock = require('nock');
const {
  dropUnopenableLegacySeedRows,
  isLegacySeedIdFilterEnabled,
  isLegacySeedProductId,
  isUnopenableLegacySeedRow,
} = require('../src/services/legacySeedIdServability');

// The rows the 11-02 run served (results.json, query ingredient_bare.003), as search hands them back.
const LEGACY = { id: 'daebak-co:4263b7e739ebca01', product_id: 'daebak-co:4263b7e739ebca01', merchant_id: 'external_seed', title: 'AXIS-Y Spot The Difference Blemish Treatment 15ml' };
const LEGACY_2 = { product_id: 'takashimashop-com:66563cb9c1bee069', merchant_id: 'external_seed', title: 'DECORTE mask' };
// What must keep serving.
const SIG_ROW = { id: 'sig_56000735cdebc73371ccd6c59675adf5', product_id: 'sig_56000735cdebc73371ccd6c59675adf5', merchant_id: 'merch_obs_62bf44c42a24ec23' };
const REKEYED = { product_id: 'flower-beauty:eb5ff15f3e267039', merchant_id: 'merch_obs_0e4ea7ad6e6d9e43' };
const EXT_ID = { product_id: 'ext_bf55156550aa86a7eb921ff2', merchant_id: 'external_seed' };
const EXT_COLON = { product_id: 'ext:4263b7e739ebca01', merchant_id: 'external_seed' };
const LEGACY_WITH_SIG = { ...LEGACY, pivota_signature_id: 'sig_4a5a7718f93574113807861f20099f22' };
const CONNECTED = { product_id: '9854988910809', merchant_id: 'merch_c5e24a8d3738d73b' };

test('the legacy id shape: <slug>:<16 hex>, and nothing else', () => {
  for (const id of ['daebak-co:4263b7e739ebca01', 'shopseoulia-com:3b93f5355854213d', 'merchant:0123456789abcdef']) {
    assert.equal(isLegacySeedProductId(id), true, id);
  }
  for (const id of [
    'ext:4263b7e739ebca01', // the seed-routed prefix
    'ext_bf55156550aa86a7eb921ff2',
    'sig_4263b7e739ebca01',
    'daebak-co:4263b7e739ebca0', // 15 hex
    'daebak-co:4263b7e739ebca012', // 17 hex
    'daebak-co:4263B7E739EBCA01', // the writer emits lowercase hex
    'daebak-co:4263b7e739ebca01::canonical', // a variant id, not a product id
    'daebak--co:4263b7e739ebca01',
    '-daebak:4263b7e739ebca01',
    'rejuran',
    '',
    null,
  ]) {
    assert.equal(isLegacySeedProductId(id), false, String(id));
  }
});

test('only the shared bucket + legacy id + no signature is unopenable', () => {
  assert.equal(isUnopenableLegacySeedRow(LEGACY), true);
  assert.equal(isUnopenableLegacySeedRow(LEGACY_2), true);
  assert.equal(isUnopenableLegacySeedRow({ merchantId: 'external_seed', productId: LEGACY.id }), true, 'camelCase aliases');
  assert.equal(isUnopenableLegacySeedRow(SIG_ROW), false);
  assert.equal(isUnopenableLegacySeedRow(REKEYED), false, 'a re-keyed seller keeps its row');
  assert.equal(isUnopenableLegacySeedRow(EXT_ID), false);
  assert.equal(isUnopenableLegacySeedRow(EXT_COLON), false);
  assert.equal(isUnopenableLegacySeedRow(LEGACY_WITH_SIG), false, 'a row with a signature can be opened by it');
  assert.equal(isUnopenableLegacySeedRow(CONNECTED), false);
  assert.equal(isUnopenableLegacySeedRow(null), false);
  assert.equal(isUnopenableLegacySeedRow([LEGACY]), false);
});

test('dropUnopenableLegacySeedRows removes the cohort and keeps order and the rest of the body', () => {
  const body = { status: 'success', total: 7, products: [SIG_ROW, LEGACY, REKEYED, EXT_ID, LEGACY_2, LEGACY_WITH_SIG, CONNECTED] };
  const { body: out, droppedCount, droppedIds } = dropUnopenableLegacySeedRows(body, {});
  assert.equal(droppedCount, 2);
  assert.deepEqual(droppedIds, [LEGACY.product_id, LEGACY_2.product_id]);
  assert.deepEqual(out.products, [SIG_ROW, REKEYED, EXT_ID, LEGACY_WITH_SIG, CONNECTED]);
  assert.equal(out.status, 'success');
  assert.equal(body.products.length, 7, 'the input body is not mutated');
});

test('nothing to drop, no products array, or the switch off: the same object comes back', () => {
  const clean = { products: [SIG_ROW, EXT_ID] };
  assert.equal(dropUnopenableLegacySeedRows(clean, {}).body, clean);
  const noProducts = { status: 'success' };
  assert.equal(dropUnopenableLegacySeedRows(noProducts, {}).body, noProducts);
  assert.equal(dropUnopenableLegacySeedRows(null, {}).body, null);
  const dirty = { products: [LEGACY] };
  for (const off of ['0', 'false', 'off', 'no', 'FALSE']) {
    const r = dropUnopenableLegacySeedRows(dirty, { SEARCH_DROP_LEGACY_SEED_IDS: off });
    assert.equal(r.body, dirty, off);
    assert.equal(r.droppedCount, 0, off);
  }
  assert.equal(isLegacySeedIdFilterEnabled({}), true, 'default ON');
  assert.equal(isLegacySeedIdFilterEnabled({ SEARCH_DROP_LEGACY_SEED_IDS: 'true' }), true);
});

// Through the real kernel call the commerce search_catalog makes (canonicalExecutor -> read -> this).
const app = require('../src/server');

async function kernel(op, payload, replyBody) {
  nock.cleanAll();
  nock(process.env.PIVOTA_API_BASE).post('/agent/shop/v1/invoke').reply(200, replyBody);
  nock(process.env.SELF_INVOKE_BASE).post('/agent/shop/v1/invoke').reply(200, replyBody);
  try {
    return await app._debug.INVOKE_AUTH_CONTEXT.run({}, () => app._debug.invokeCommerceKernelRawUpstream(op, payload));
  } finally {
    nock.cleanAll();
  }
}

test.after(() => nock.cleanAll());

test('commerce search (find_products_multi) never serves the legacy rows', async () => {
  const out = await kernel(
    'find_products_multi',
    { search: { query: 'hyaluronic acid' } },
    { status: 'success', products: [SIG_ROW, LEGACY, EXT_ID, LEGACY_2] },
  );
  assert.deepEqual(out.products.map((p) => p.product_id), [SIG_ROW.product_id, EXT_ID.product_id]);
});

test('merchant-scoped search (find_products) drops them too; the ok/data envelope is unwrapped first', async () => {
  const out = await kernel(
    'find_products',
    { search: { query: 'x', merchant_id: 'external_seed' } },
    { ok: true, data: { products: [LEGACY, EXT_ID] } },
  );
  assert.deepEqual(out.products.map((p) => p.product_id), [EXT_ID.product_id]);
});

test('a non-search op is untouched, even with a legacy-shaped row in its body', async () => {
  const body = { status: 'success', products: [LEGACY], offers: [] };
  const out = await kernel('offers.resolve', { product: { product_id: LEGACY.product_id, merchant_id: 'external_seed' } }, body);
  assert.deepEqual(out.products, [LEGACY]);
});
