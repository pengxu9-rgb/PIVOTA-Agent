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

test('visible alternatives omit zero similarity when no ranking evidence exists', () => {
  const row = __internal.normalizeRecoAlternativeVisibleAuthorityContract({
    kind: 'similar',
    candidate_origin: 'pool',
    grounding_status: 'catalog_verified',
    similarity_score: 0,
    product: {
      product_id: 'ext_unknown_score_spf',
      merchant_id: 'external_seed',
      brand: 'Haruharu Wonder',
      name: 'Moisture Airyfit Daily Sunscreen SPF50+ PA++++',
      category: 'Sunscreen',
    },
  });

  assert.equal(Object.prototype.hasOwnProperty.call(row, 'similarity_score'), false);
});

test('final visible alternatives replace category-only tradeoff with shopper tradeoff copy', () => {
  const row = __internal.applyFinalRecoAlternativeVisibleShopperCopy({
    kind: 'similar',
    candidate_origin: 'pool',
    grounding_status: 'catalog_verified',
    similarity_score: 0,
    product: {
      product_id: 'ext_airyfit',
      merchant_id: 'external_seed',
      brand: 'Haruharu Wonder',
      name: 'Moisture Airyfit Daily Sunscreen SPF50+ PA++++',
      category: 'Sunscreen',
    },
    brand: 'Haruharu Wonder',
    name: 'Moisture Airyfit Daily Sunscreen SPF50+ PA++++',
    reasons: [
      'The source page lists a 4.9 star average across 385 buyer reviews.',
    ],
    tradeoffs: ['Category: Sunscreen'],
  });

  assert.equal(row.tradeoff_notes.includes('Category: Sunscreen'), false);
  assert.match(row.tradeoff_notes[0], /serum-like|fresh|thinner sunscreen/i);
  assert.match(row.why_this_one, /serum-like|fresh|thinner sunscreen/i);
});

test('alternative duplicate merge preserves mapper similarity field for ranking parity', () => {
  const merged = __internal.mergeRecoAlternativeDuplicateRows(
    {
      kind: 'similar',
      candidate_origin: 'pool',
      grounding_status: 'catalog_verified',
      similarity: 82,
      product: {
        product_id: 'ext_airyfit',
        merchant_id: 'external_seed',
        brand: 'Haruharu Wonder',
        name: 'Moisture Airyfit Daily Sunscreen SPF50+ PA++++',
      },
      reasons: ['Grounded same-role alternative.'],
    },
    {
      kind: 'similar',
      candidate_origin: 'pool',
      grounding_status: 'catalog_verified',
      similarity_score: 0,
      product: {
        product_id: 'ext_airyfit',
        merchant_id: 'external_seed',
        brand: 'Haruharu Wonder',
        name: 'Moisture Airyfit Daily Sunscreen SPF50+ PA++++',
      },
      reasons: ['Catalog hydration row.'],
    },
  );

  assert.equal(merged.similarity_score, 82);
});

test('mixed ranking score consumes mapper similarity field, not only similarity_score', () => {
  const score = __internal.getRecoAlternativeMixedRankingScore({
    kind: 'similar',
    candidate_origin: 'pool',
    grounding_status: 'catalog_verified',
    similarity: 82,
    product: {
      product_id: 'ext_airyfit',
      merchant_id: 'external_seed',
      brand: 'Haruharu Wonder',
      name: 'Moisture Airyfit Daily Sunscreen SPF50+ PA++++',
    },
  });

  assert.ok(score > 0.8);
});

test('selector alternatives treat zero similarity as missing and assign order-based score', () => {
  const rows = __internal.mapSelectorCandidatesToAlternatives([
    {
      product_id: 'ext_daily_soothing',
      merchant_id: 'external_seed',
      brand: 'Haruharu Wonder',
      name: 'Daily Soothing Sun Shield SPF50+ PA++++',
      category: 'Sunscreen',
      similarity_score: 0,
      signals: ['Leans more matte and less slippery under makeup.'],
    },
  ], { maxTotal: 3, lang: 'EN' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].similarity, 82);
});
