'use strict';

// The post-recall gate under the lash route (SEARCH_LASH_CATEGORY_ROUTE, 2026-09-27).
// tests/integration/search_lash_category_route_postgres.test.js runs the whole route on PostgreSQL;
// these cover the two JS decisions it cannot isolate:
//   - a row WITHOUT a category path is admitted to a false-lashes browse only on a false-lash phrase:
//     the generic eye test admits any "mascara" or "lash" name, which would put a mascara here;
//   - "Brush On" is how a glue is applied, not a brush (pivota-backend #2387 fixed the same word in the
//     category classifier): "Duo Brush On Striplash Adhesive" is not an accessory, a real applicator is.

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSearchQualityContract, LASH_CATEGORY_ROUTE_FLAG } = require('../src/findProductsMulti/queryUnderstanding');
const app = require('../src/server');

const { getSearchQualityContractHardConstraintResult: gate, inferBeautyMainlineIntent, buildBeautyExternalSeedCategoryTerms,
  buildBeautyExternalSeedBrandCategoryTextTerms } = app._debug;

function withFlag(value, fn) {
  const prior = process.env[LASH_CATEGORY_ROUTE_FLAG];
  if (value == null) delete process.env[LASH_CATEGORY_ROUTE_FLAG]; else process.env[LASH_CATEGORY_ROUTE_FLAG] = value;
  try { return fn(); } finally {
    if (prior == null) delete process.env[LASH_CATEGORY_ROUTE_FLAG]; else process.env[LASH_CATEGORY_ROUTE_FLAG] = prior;
  }
}

const QUERY = 'lash glue';
const contract = withFlag('on', () => buildSearchQualityContract({ rawQuery: QUERY, market: 'US' }));
const row = (title, extra = {}) => ({ product_id: title, title, brand: 'Brand', product_type: 'makeup', price: 9, currency: 'USD',
  image_url: 'https://cdn.example/x.jpg', source: 'canonical_chain', search_recall_source: 'canonical_chain', ...extra });
const onLeaf = { category_path: ['beauty', 'makeup', 'eye', 'false-lashes'], catalog_category_path: 'beauty/makeup/eye/false-lashes' };
const check = (product) => withFlag('on', () => gate(product, contract, QUERY));

test('premise: the lash query is a false-lashes category browse', () => {
  assert.equal(contract.query_class, 'category_browse');
  assert.equal(contract.hard_constraints.category_path_prefix, 'beauty/makeup/eye/false-lashes/');
});

test('a path-less row is admitted on a false-lash phrase', () => {
  for (const title of ['Kiss Strip Lash Adhesive - Clear', 'Faux Mink Lashes 5 Pairs', 'Falscara Wisps', '假睫毛 10对']) {
    const r = check(row(title));
    assert.equal(r.eligible, true, `${title}: ${JSON.stringify(r.reasons)}`);
  }
});

test('a path-less mascara or brow row is NOT admitted, though the generic eye test would admit it', () => {
  for (const title of ['Volumizing Lash Mascara', 'Lash Lift Mascara', 'Brow Gel Clear', 'Waterproof Eyeliner',
    'False Lash Effect Mascara']) {
    const r = check(row(title));
    assert.equal(r.eligible, false, title);
    assert.ok(r.reasons.includes('category_mismatch'), `${title}: ${JSON.stringify(r.reasons)}`);
  }
});

test('"Brush On" is not a brush: a brush-on lash glue on the leaf is eligible', () => {
  for (const title of ['Duo Brush On Striplash Adhesive', 'Ardell LashGrip Brush-On Strip Lash Adhesive Dark']) {
    const r = check(row(title, onLeaf));
    assert.equal(r.eligible, true, `${title}: ${JSON.stringify(r.reasons)}`);
  }
});

test('a real lash tool is still an accessory for a product query', () => {
  for (const title of ['Kiss Falscara Eyelash Applicator', 'Lash Brush Spoolie', 'False Lash Applicator Tool']) {
    const r = check(row(title, onLeaf));
    assert.ok(r.reasons.includes('accessory_for_product_query'), `${title}: ${JSON.stringify(r.reasons)}`);
  }
});

test('external-seed recall asks for lash terms under the lash prefix, not the generic eye terms', () => {
  const terms = withFlag('on', () => buildBeautyExternalSeedCategoryTerms(inferBeautyMainlineIntent(QUERY)));
  assert.ok(terms.includes('false lashes'), JSON.stringify(terms));
  assert.ok(terms.includes('lash glue'), JSON.stringify(terms));
  assert.equal(terms.includes('mascara'), false, JSON.stringify(terms));
});

test('a brand + lash query ("Ardell lash glue") recalls seeds by lash terms, not mascara/eyeshadow', () => {
  const query = 'ardell lash glue';
  const terms = withFlag('on', () => buildBeautyExternalSeedBrandCategoryTextTerms(query, inferBeautyMainlineIntent(query)));
  assert.ok(terms.includes('false lashes'), JSON.stringify(terms));
  assert.equal(terms.includes('mascara'), false, JSON.stringify(terms));
});
