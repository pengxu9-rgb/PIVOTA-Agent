const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/routes');

test('visible alternatives expose authoritative identity and PDP fields at row and product levels', () => {
  const row = __internal.normalizeRecoAlternativeVisibleAuthorityContract({
    kind: 'similar',
    candidate_origin: 'pool',
    grounding_status: 'catalog_verified',
    similarity: 72,
    product: {
      product_id: 'ext_daily_soothing',
      merchant_id: 'external_seed',
      brand: 'Haruharu Wonder',
      name: 'Daily Soothing Sun Shield SPF50+ PA++++',
      category: 'Sunscreen',
      pdp_url: 'https://example.com/daily-soothing-spf',
    },
    reasons: ['Same sunscreen step.'],
  });

  assert.equal(row.brand, 'Haruharu Wonder');
  assert.equal(row.name, 'Daily Soothing Sun Shield SPF50+ PA++++');
  assert.equal(row.product_id, 'ext_daily_soothing');
  assert.equal(row.merchant_id, 'external_seed');
  assert.equal(row.similarity_score, 72);
  assert.deepEqual(row.canonical_product_ref, {
    product_id: 'ext_daily_soothing',
    merchant_id: 'external_seed',
  });
  assert.equal(row.pdp_open.path, 'ref');
  assert.deepEqual(row.pdp_open.product_ref, {
    product_id: 'ext_daily_soothing',
    merchant_id: 'external_seed',
  });
  assert.equal(row.product.brand, row.brand);
  assert.equal(row.product.name, row.name);
  assert.equal(row.product.merchant_id, row.merchant_id);
  assert.equal(row.product.pdp_open.path, 'ref');
});

test('visible alternatives recover score from ranking metadata when normalized score is zeroed', () => {
  const row = __internal.normalizeRecoAlternativeVisibleAuthorityContract({
    kind: 'similar',
    candidate_origin: 'pool',
    grounding_status: 'catalog_verified',
    similarity_score: 0,
    product: {
      product_id: 'ext_mineral_spf',
      merchant_id: 'external_seed',
      brand: 'Haruharu Wonder',
      name: 'Moisture Pure Mineral Relief Sunscreen SPF50+ PA++++',
      category: 'Sunscreen',
    },
    metadata: {
      raw_similarity_score: 0.71,
    },
  });

  assert.equal(row.similarity_score, 71);
});
