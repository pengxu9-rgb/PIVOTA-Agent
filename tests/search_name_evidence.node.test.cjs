'use strict';

// Unit tests for src/services/searchNameEvidence.js and its three callers' contracts.
// End-to-end recall and ranking over real PostgreSQL:
//   tests/integration/search_name_evidence_admission_postgres.test.js
// Partner and self-retrieval cases with the flag on:
//   tests/acceptance/name_evidence_flag.node.test.cjs

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const test = require('node:test');

const ne = require('../src/services/searchNameEvidence');
const app = require('../src/server');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');

const { getSearchQualityContractHardConstraintResult: gate, scoreBeautyExternalSeedProduct, inferBeautyMainlineIntent,
  isBeautyProductContraindicatedForQuery } = app._debug;

const JSM = {
  product_id: 'jsm', title: 'LIP-PRESSION Metal Serum Gloss', brand: 'JUNGSAEMMOOL', product_type: 'makeup',
  category: 'makeup', category_path: ['beauty', 'makeup'], catalog_category_path: 'beauty/makeup', price: 28.8,
  currency: 'SGD', image_url: 'https://cdn.example.com/j.jpg', source: 'canonical_chain', search_recall_source: 'canonical_chain',
};

function withFlag(value, fn) {
  const prior = process.env[ne.FLAG];
  if (value == null) delete process.env[ne.FLAG]; else process.env[ne.FLAG] = value;
  try { return fn(); } finally { if (prior == null) delete process.env[ne.FLAG]; else process.env[ne.FLAG] = prior; }
}

test('the flag is off unless explicitly on', () => {
  assert.equal(ne.nameEvidenceAdmissionEnabled({}), false);
  assert.equal(ne.nameEvidenceAdmissionEnabled({ [ne.FLAG]: 'off' }), false);
  assert.equal(ne.nameEvidenceAdmissionEnabled({ [ne.FLAG]: 'shadow' }), false);
  for (const v of ['on', 'true', '1', 'ON']) assert.equal(ne.nameEvidenceAdmissionEnabled({ [ne.FLAG]: v }), true, v);
});

test('a name needs two distinctive tokens, one of them not category vocabulary on its own', () => {
  assert.deepEqual(ne.queryDistinctiveTokens('LIP-PRESSION Metal Serum Gloss'), ['lip', 'pression', 'metal', 'serum', 'gloss']);
  assert.deepEqual(ne.queryDistinctiveTokens('Metal Serum Gloss'), ['metal', 'serum', 'gloss']);
  assert.equal(ne.queryDistinctiveTokens('serum'), null, 'one token is not a name');
  assert.equal(ne.queryDistinctiveTokens('best serum for skin'), null, 'filler words carry no identity');
  assert.equal(ne.queryDistinctiveTokens('moisturizer cleanser'), null, 'all category vocabulary is a browse');
  assert.equal(ne.queryDistinctiveTokens('唇彩'), null, 'a single CJK run is one token');
});

test('brand tokens are not name evidence -- the brand is its own constraint', () => {
  const hard = { brand: { alias: 'jung saem mool', canonical: 'jung saem mool', brand: 'JUNGSAEMMOOL' } };
  assert.deepEqual(ne.queryDistinctiveTokens('jung saem mool metal gloss', hard), ['metal', 'gloss']);
  assert.equal(ne.queryDistinctiveTokens('jung saem mool metal', hard), null);
});

test('own name is title and product_type -- never description or payload', () => {
  assert.equal(ne.ownNameCarriesTokens(JSM, ['metal', 'serum', 'gloss']), true);
  assert.equal(ne.ownNameCarriesTokens(JSM, ['metal', 'serum', 'gloss', 'drop']), false, 'every token, not most');
  assert.equal(ne.ownNameCarriesTokens({ title: 'Precision Eyeliner', description: 'pairs with Metal Serum Gloss' }, ['metal', 'serum', 'gloss']), false);
  assert.equal(ne.ownNameCarriesTokens({ title: 'Glow', product_payload: { canonical_title: 'Metal Serum Gloss' } }, ['metal', 'serum', 'gloss']), false,
    'payload fields are not read: the SQL arm cannot afford them');
  assert.equal(ne.ownNameCarriesTokens({ title: 'Metal Serum', product_type: 'Gloss' }, ['metal', 'serum', 'gloss']), true, 'type counts');
  assert.equal(ne.ownNameCarriesTokens({ name: 'Metal Serum Gloss' }, ['metal', 'serum', 'gloss']), true, 'name when no title');
  assert.equal(ne.ownNameCarriesTokens({ title: 'Metallic Serums Glossy' }, ['metal', 'serum', 'gloss']), false, 'whole words only, as the SQL');
});

test('gate: flag off rejects category_mismatch; flag on waives only the category, and says so', () => {
  const q = 'Metal Serum Gloss';
  const contract = buildSearchQualityContract({ rawQuery: q, market: 'SG' });
  assert.equal(contract.hard_constraints.category_path_prefix, 'beauty/skincare/treat/', 'premise: the guess is skincare');
  const off = withFlag(null, () => gate({ ...JSM }, contract, q));
  assert.deepEqual(off.reasons, ['category_mismatch']);
  const on = withFlag('on', () => gate({ ...JSM }, contract, q));
  assert.equal(on.eligible, true);
  assert.equal(on.category_waived_by_name_evidence, true);
  // Other reasons stand: an accessory whose name carries the query is still an accessory.
  const brush = withFlag('on', () => gate({ ...JSM, product_id: 'b', title: 'Metal Serum Gloss Brush', product_type: 'Brush' }, contract, q));
  assert.equal(brush.eligible, false);
  assert.ok(brush.reasons.includes('accessory_for_product_query'), JSON.stringify(brush.reasons));
});

test('gate: a row the category already admits is untouched and not marked waived', () => {
  const q = 'Metal Serum Gloss';
  const contract = buildSearchQualityContract({ rawQuery: q, market: 'SG' });
  const inBucket = { ...JSM, product_id: 's', title: 'Metal Serum Gloss', category_path: ['beauty', 'skincare', 'treat', 'serum'],
    catalog_category_path: 'beauty/skincare/treat/serum', product_type: 'Serum' };
  const r = withFlag('on', () => gate(inBucket, contract, q));
  assert.equal(r.eligible, true);
  assert.equal(r.category_waived_by_name_evidence, undefined);
});

test('ranker: flag on, the name-evidence row is relevant and outranks a bare category match', () => {
  const q = 'Metal Serum Gloss';
  const contract = buildSearchQualityContract({ rawQuery: q, market: 'SG' });
  const intent = inferBeautyMainlineIntent(q);
  const args = (product) => ({ product, queryText: q, intent, normalizedQuery: q.toLowerCase(), queryTokens: q.toLowerCase().split(' '), searchQualityContract: contract });
  const serum = { ...JSM, product_id: 'h', title: 'Hydrating Serum', brand: 'Other', product_type: 'Serum',
    category_path: ['beauty', 'skincare', 'treat', 'serum'], catalog_category_path: 'beauty/skincare/treat/serum' };
  const off = withFlag(null, () => scoreBeautyExternalSeedProduct(args({ ...JSM })));
  assert.equal(off.relevant, false);
  const [jsm, other] = withFlag('on', () => [scoreBeautyExternalSeedProduct(args({ ...JSM })), scoreBeautyExternalSeedProduct(args(serum))]);
  assert.equal(jsm.relevant, true, JSON.stringify({ ...jsm, product: undefined }));
  assert.equal(other.relevant, true);
  assert.ok(jsm.score > other.score, `${jsm.score} > ${other.score}`);
});

test('ranker: the category and family guesses do not reject a name-evidence row', () => {
  // Rows from the 600-row production fixture that the flag newly admits at the gate. Each
  // is rejected by the ranker's category (families empty) or family (families guessed)
  // check unless the name-evidence exemption applies.
  const h = require('./acceptance/search_acceptance_harness.cjs');
  const rows = h.loadRows();
  for (const [q, id] of [['lip gloss', 'acceptance_jsm_lip_pression_metal_serum_gloss'], ['eye cream', 'sig_cefc294f354ec732ea4c8c5e76335392'],
    ['lip serum', 'acceptance_jsm_lip_pression_metal_serum_gloss']]) {
    const product = rows.find((r) => r.product_id === id);
    const contract = buildSearchQualityContract({ rawQuery: q, market: 'SG' });
    const intent = inferBeautyMainlineIntent(q);
    const r = withFlag('on', () => scoreBeautyExternalSeedProduct({ product, queryText: q, intent, normalizedQuery: q, queryTokens: q.split(' '), searchQualityContract: contract }));
    assert.equal(r.relevant, true, `${q} -> ${product.title}: ${r.score}`);
  }
});

test('ranker: the FAMILY guess does not reject a name-evidence row either', () => {
  // Measured over every tracked query and every fixture row's own title: this is the one
  // production row the family exemption decides. A sun mist the catalog files under
  // toner; searched by its exact title, the query's guessed family (sunscreen) does not
  // match the row's family, and only the exemption keeps it.
  const h = require('./acceptance/search_acceptance_harness.cjs');
  const rows = h.loadRows();
  const id = 'sig_f15d35090db822cba12e633b1eca7933';
  const row = rows.find((r) => r.product_id === id);
  const served = withFlag('on', () => h.evaluateQuery(row.title, 'SG', rows).eligible.map((r) => r.product_id));
  assert.ok(served.includes(id), `${row.title} should be served for its own title`);
});

test('ranker: name evidence skips SURFACE rules but never SAFETY rules', () => {
  // `brightening` builds no safety intent, so ONLY the retinoid-for-brightening rule can
  // catch this row: the check below cannot be satisfied by a different safety branch.
  const brightening = 'Retinol Night Serum brightening';
  assert.deepEqual(inferBeautyMainlineIntent(brightening).safety, [], 'premise');
  assert.equal(isBeautyProductContraindicatedForQuery({ title: 'Retinol Night Serum', product_type: 'Serum', description: 'retinol 0.3%' },
    brightening, inferBeautyMainlineIntent(brightening), { admittedByNameEvidence: true }), true);
  const q = 'Retinol Night Serum pregnancy safe';
  const retinol = { title: 'Retinol Night Serum', product_type: 'Serum', description: 'retinol 0.3%' };
  const intent = inferBeautyMainlineIntent(q);
  assert.equal(isBeautyProductContraindicatedForQuery(retinol, q, intent, { admittedByNameEvidence: true }), true,
    'a retinoid for a pregnancy query stays contraindicated whatever the name says');
  const lip = { title: 'LIP-PRESSION Metal Serum Gloss', product_type: 'makeup' };
  const q2 = 'Metal Serum Gloss';
  const intent2 = inferBeautyMainlineIntent(q2);
  assert.equal(isBeautyProductContraindicatedForQuery(lip, q2, intent2), true, 'premise: the lip-care surface rule fires');
  assert.equal(isBeautyProductContraindicatedForQuery(lip, q2, intent2, { admittedByNameEvidence: true }), false);
});
