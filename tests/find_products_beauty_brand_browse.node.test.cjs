const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';

const app = require('../src/server');

const {
  attachCanonicalChainRecallTelemetry,
  buildBeautyExternalSeedCategoryTerms,
  filterSearchServingEligibleProducts,
  inferBeautyMainlineIntent,
  resolveBeautyBrandBrowseQuery,
  scoreBeautyExternalSeedProduct,
} = app._debug;

function canonicalFentyProduct(id, title, overrides = {}) {
  return {
    id,
    product_id: id,
    merchant_id: 'external_seed',
    title,
    brand: 'Fenty Beauty',
    price: 29,
    currency: 'USD',
    image_url: `https://cdn.shopify.com/fenty/${id}.jpg`,
    category: 'Lipstick',
    product_type: 'Lipstick',
    category_path: ['beauty', 'makeup', 'lip', 'lipstick'],
    catalog_category_path: 'beauty/makeup/lip/lipstick',
    source: 'canonical_chain',
    search_recall_source: 'canonical_chain',
    catalog_source: 'canonical_chain',
    pivota_signature_id: `sig_${id}`,
    destination_url: `https://fentybeauty.com/products/${id}`,
    ...overrides,
  };
}

test('known beauty brand aliases use the brand_browse beauty contract', () => {
  const fenty = resolveBeautyBrandBrowseQuery('fenty');
  assert.equal(fenty.matched, true);
  assert.equal(fenty.contract, 'brand_browse');
  assert.equal(fenty.brand, 'fenty beauty');

  const fentyIntent = inferBeautyMainlineIntent('fenty');
  assert.equal(fentyIntent.beautyLike, true);
  assert.equal(fentyIntent.brandBrowse.contract, 'brand_browse');

  const zara = resolveBeautyBrandBrowseQuery('zara');
  assert.equal(zara.matched, false);
  assert.equal(inferBeautyMainlineIntent('zara').beautyLike, false);
});

test('serving eligibility rejects degraded external seed cards', () => {
  const badSeed = {
    product_id: 'sig_bad',
    merchant_id: 'external_seed',
    title: "Pro Filt'r Instant Retouch Concealer",
    brand: 'Fenty Beauty',
    source: 'external_seed',
    category: 'external',
    product_type: 'external',
    price: 0,
    destination_url: 'https://fentybeauty.com/products/stale-concealer',
  };
  const goodCanonical = canonicalFentyProduct('fenty_lip_1', 'Stunna Lip Paint');

  const gate = filterSearchServingEligibleProducts([badSeed, goodCanonical], {
    queryText: 'fenty',
    requireBeauty: true,
  });

  assert.deepEqual(gate.products.map((product) => product.product_id), ['fenty_lip_1']);
  assert.equal(gate.rejected_count, 1);
  assert.ok(gate.rejected[0].reasons.includes('missing_image'));
  assert.ok(gate.rejected[0].reasons.includes('non_positive_price'));
});

test('beauty brand browse recall expands across makeup fragrance skin and hair', () => {
  const intent = inferBeautyMainlineIntent('fenty');
  const terms = buildBeautyExternalSeedCategoryTerms(intent);

  assert.ok(terms.length > 12);
  assert.ok(terms.includes('foundation'));
  assert.ok(terms.includes('concealer'));
  assert.ok(terms.includes('lipstick'));
  assert.ok(terms.includes('fragrance'));
  assert.ok(terms.includes('hair care'));
});

test('beauty brand browse scoring prefers healthy catalog-backed rows over polluted legacy rows', () => {
  const intent = inferBeautyMainlineIntent('fenty');
  const healthy = canonicalFentyProduct('ext_fenty_good', 'Fenty Beauty Stunna Lip Paint', {
    source_product_id: 'ext_fe4c414430feae0642f78cf4',
  });
  const polluted = {
    product_id: 'sig_legacy_bad',
    source_product_id: 'fenty-beauty:legacy-concealer',
    external_product_id: 'fenty-beauty:legacy-concealer',
    merchant_id: 'external_seed',
    title: "Fenty Beauty Pro Filt'r Instant Retouch Concealer",
    brand: 'Fenty Beauty',
    source: 'external_seed',
    category: 'external',
    product_type: 'external',
    price: 0,
    destination_url: 'https://fentybeauty.com/products/stale-concealer',
  };

  const scoredHealthy = scoreBeautyExternalSeedProduct({
    product: healthy,
    queryText: 'fenty',
    intent,
    normalizedQuery: 'fenty',
    queryTokens: ['fenty'],
  });
  const scoredPolluted = scoreBeautyExternalSeedProduct({
    product: polluted,
    queryText: 'fenty',
    intent,
    normalizedQuery: 'fenty',
    queryTokens: ['fenty'],
  });

  assert.equal(scoredHealthy.relevant, true);
  assert.equal(scoredPolluted.relevant, true);
  assert.ok(scoredHealthy.score > scoredPolluted.score + 60);
});

test('beauty brand browse scoring prioritizes core makeup over promo sets and off-core hair rows', () => {
  const intent = inferBeautyMainlineIntent('fenty');
  const lipstick = canonicalFentyProduct('ext_fenty_lip', 'Fenty Icon Velvet Liquid Lipstick — The MVP', {
    source_product_id: 'ext_fenty_lip',
    category: 'Lipstick',
    product_type: 'Lipstick',
    category_path: ['beauty', 'makeup', 'lip', 'lipstick'],
    catalog_category_path: 'beauty/makeup/lip/lipstick',
  });
  const mysterySet = canonicalFentyProduct(
    'ext_fenty_set',
    "Arcane Hydra Vizor Mystery Box Moisturizer Sunscreen + Collector's Case",
    {
      source_product_id: 'ext_fenty_set',
      category: 'Skincare Set',
      product_type: 'Set',
      category_path: ['beauty', 'skincare', 'sunscreen'],
      catalog_category_path: 'beauty/skincare/sunscreen',
    },
  );
  const hair = canonicalFentyProduct('ext_fenty_hair', 'The Homecurl Curl-Defining Cream', {
    source_product_id: 'ext_fenty_hair',
    category: 'Hair Care',
    product_type: 'Hair Care',
    category_path: ['beauty', 'hair', 'styling'],
    catalog_category_path: 'beauty/hair/styling',
  });

  const score = (product) =>
    scoreBeautyExternalSeedProduct({
      product,
      queryText: 'fenty',
      intent,
      normalizedQuery: 'fenty',
      queryTokens: ['fenty'],
    }).score;

  assert.ok(score(lipstick) > score(mysterySet) + 40);
  assert.ok(score(lipstick) > score(hair) + 30);
});

test('beauty brand plus category scoring rejects non-brand category matches', () => {
  const intent = inferBeautyMainlineIntent('fenty lipstick');
  const tomFordLipstick = canonicalFentyProduct('ext_tom_ford_lip', 'Fucking Fabulous Lip Color', {
    brand: 'Tom Ford',
    merchant_name: 'Tom Ford Beauty',
    source_product_id: 'ext_tom_ford_lip',
    image_url: 'https://cdn.example.com/tom-ford-lip.jpg',
    destination_url: 'https://tomfordbeauty.com/products/fucking-fabulous-lip-color',
    canonical_url: 'https://agent.pivota.cc/products/sig_ext_tom_ford_lip',
    pivota_canonical_url: 'https://agent.pivota.cc/products/sig_ext_tom_ford_lip',
    category: 'Lipstick',
    product_type: 'Lipstick',
    category_path: ['beauty', 'makeup', 'lip', 'lipstick'],
    catalog_category_path: 'beauty/makeup/lip/lipstick',
  });

  const scored = scoreBeautyExternalSeedProduct({
    product: tomFordLipstick,
    queryText: 'fenty lipstick',
    intent,
    normalizedQuery: 'fenty lipstick',
    queryTokens: ['fenty', 'lipstick'],
  });

  assert.equal(scored.relevant, false);
});

test('canonical chain replaces degraded products for beauty brand browse', () => {
  const degradedProducts = [
    {
      product_id: 'sig_bad_1',
      merchant_id: 'external_seed',
      title: "Pro Filt'r Instant Retouch Concealer",
      brand: 'Fenty Beauty',
      source: 'external_seed',
      category: 'external',
      product_type: 'external',
      price: 0,
      destination_url: 'https://fentybeauty.com/products/stale-concealer',
    },
  ];
  const canonicalProducts = [
    canonicalFentyProduct('fenty_lip_1', 'Stunna Lip Paint'),
    canonicalFentyProduct('fenty_lip_2', 'Gloss Bomb Universal Lip Luminizer'),
    canonicalFentyProduct('fenty_face_1', "Pro Filt'r Soft Matte Foundation", {
      category: 'Foundation',
      product_type: 'Foundation',
      category_path: ['beauty', 'makeup', 'face', 'foundation'],
      catalog_category_path: 'beauty/makeup/face/foundation',
    }),
  ];

  const out = attachCanonicalChainRecallTelemetry(
    {
      status: 'success',
      success: true,
      products: degradedProducts,
      total: 1,
      page_size: 1,
      reply: 'clarify',
      metadata: {
        search_trace: { raw_query: 'fenty' },
        route_health: {},
        source_breakdown: { external_seed_count: 1 },
      },
    },
    {
      products: canonicalProducts,
      telemetry: {
        canonical_path_executed: true,
        canonical_raw_count: 3,
        canonical_product_count: 3,
        canonical_category_path_prefix: null,
        canonical_duration_ms: 5,
        query_text: 'fenty',
        requested_limit: 3,
      },
    },
  );

  assert.equal(out.reply, null);
  assert.deepEqual(out.products.map((product) => product.product_id), [
    'fenty_lip_1',
    'fenty_lip_2',
    'fenty_face_1',
  ]);
  assert.equal(out.metadata.canonical_returned_count, 3);
  assert.equal(out.metadata.search_card_quality_gate.applied, true);
  assert.equal(out.metadata.source_breakdown.canonical_chain_count, 3);
});
