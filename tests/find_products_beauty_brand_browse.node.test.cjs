const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';

const app = require('../src/server');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');

const {
  attachCanonicalChainRecallTelemetry,
  buildSearchQualityTierCounts,
  buildBeautyExternalSeedCategoryTerms,
  buildCanonicalQueryTextForBeautyBrandRecall,
  canonicalizeBeautyProductTitleForDedupe,
  compactBeautyMainlineProductForResponse,
  dedupeBeautyProductsByDisplayKey,
  filterSearchServingEligibleProducts,
  getSearchQualityContractHardConstraintResult,
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

  const ordinary = resolveBeautyBrandBrowseQuery('ordinary');
  assert.equal(ordinary.matched, true);
  assert.equal(ordinary.brand, 'the ordinary');
  assert.equal(ordinary.brand_only, true);

  const ordinaryAdjectivePhrase = resolveBeautyBrandBrowseQuery('ordinary moisturizer');
  assert.equal(ordinaryAdjectivePhrase.matched, false);

  const zara = resolveBeautyBrandBrowseQuery('zara');
  assert.equal(zara.matched, false);
  assert.equal(inferBeautyMainlineIntent('zara').beautyLike, false);
});

test('brand modifier canonical recall strips only the known brand', () => {
  const ordinaryBrowse = resolveBeautyBrandBrowseQuery('the ordinary collection');
  assert.equal(ordinaryBrowse.matched, true);
  assert.equal(ordinaryBrowse.brand_only, false);

  assert.equal(
    buildCanonicalQueryTextForBeautyBrandRecall('the ordinary collection', ordinaryBrowse, ''),
    'collection',
  );
  assert.equal(
    buildCanonicalQueryTextForBeautyBrandRecall('the ordinary multi peptide collection', ordinaryBrowse, ''),
    'multi peptide collection',
  );

  const fentyBrandOnly = resolveBeautyBrandBrowseQuery('fenty');
  assert.equal(buildCanonicalQueryTextForBeautyBrandRecall('fenty', fentyBrandOnly, ''), 'fenty');
  assert.equal(
    buildCanonicalQueryTextForBeautyBrandRecall('fenty lipstick', resolveBeautyBrandBrowseQuery('fenty lipstick'), 'beauty/makeup/lip/'),
    'fenty lipstick',
  );
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

test('beauty brand browse display dedupe collapses shade variants by product line', () => {
  assert.equal(
    canonicalizeBeautyProductTitleForDedupe("We're Even Hydrating Longwear Concealer — 100C"),
    'we re even hydrating longwear concealer',
  );
  assert.equal(
    canonicalizeBeautyProductTitleForDedupe("Sun Stalk'r Instant Warmth Bronzer — Private Island"),
    'sun stalk r instant warmth bronzer',
  );
  assert.equal(
    canonicalizeBeautyProductTitleForDedupe('Bright Fix Eye Brightener — Honey Mustard'),
    'bright fix eye brightener',
  );

  const products = [
    canonicalFentyProduct('fenty_primer', 'Grip Trip Mattifying + Blurring Primer', {
      category: 'Primer',
      product_type: 'Primer',
      category_path: ['beauty', 'makeup', 'face', 'primer'],
      catalog_category_path: 'beauty/makeup/face/primer',
    }),
    canonicalFentyProduct('fenty_concealer_100c', "We're Even Hydrating Longwear Concealer — 100C", {
      category: 'Concealer',
      product_type: 'Concealer',
      category_path: ['beauty', 'makeup', 'face', 'concealer'],
      catalog_category_path: 'beauty/makeup/face/concealer',
    }),
    canonicalFentyProduct('fenty_concealer_225n', "We're Even Hydrating Longwear Concealer — 225N", {
      category: 'Concealer',
      product_type: 'Concealer',
      category_path: ['beauty', 'makeup', 'face', 'concealer'],
      catalog_category_path: 'beauty/makeup/face/concealer',
    }),
    canonicalFentyProduct('fenty_bronzer_private_island', "Sun Stalk'r Instant Warmth Bronzer — Private Island", {
      category: 'Bronzer',
      product_type: 'Bronzer',
      category_path: ['beauty', 'makeup', 'face', 'bronzer'],
      catalog_category_path: 'beauty/makeup/face/bronzer',
    }),
    canonicalFentyProduct('fenty_bronzer_mocha_mami', "Sun Stalk'r Instant Warmth Bronzer — Mocha Mami", {
      category: 'Bronzer',
      product_type: 'Bronzer',
      category_path: ['beauty', 'makeup', 'face', 'bronzer'],
      catalog_category_path: 'beauty/makeup/face/bronzer',
    }),
    canonicalFentyProduct('fenty_eye_honey', 'Bright Fix Eye Brightener — Honey Mustard', {
      category: 'Eye Brightener',
      product_type: 'Eye Brightener',
      category_path: ['beauty', 'makeup', 'eye', 'brightener'],
      catalog_category_path: 'beauty/makeup/eye/brightener',
    }),
    canonicalFentyProduct('fenty_eye_seashell', 'Bright Fix Eye Brightener — Seashell', {
      category: 'Eye Brightener',
      product_type: 'Eye Brightener',
      category_path: ['beauty', 'makeup', 'eye', 'brightener'],
      catalog_category_path: 'beauty/makeup/eye/brightener',
    }),
  ];

  assert.deepEqual(dedupeBeautyProductsByDisplayKey(products).map((product) => product.product_id), [
    'fenty_primer',
    'fenty_concealer_100c',
    'fenty_bronzer_private_island',
    'fenty_eye_honey',
  ]);
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

test('search quality contract enforces brand and strict lipstick before ranking', () => {
  const contract = buildSearchQualityContract({ rawQuery: 'fenty lipstick', market: 'US' });
  const intent = inferBeautyMainlineIntent('fenty lipstick');
  const lipOil = canonicalFentyProduct('ext_fenty_lip_oil', 'Fenty Treatz Hydrating + Strengthening Lip Oil', {
    source_product_id: 'ext_fenty_lip_oil',
    category: 'Lip Oil',
    product_type: 'Lip Oil',
    category_path: ['beauty', 'makeup', 'lip', 'lip oil'],
    catalog_category_path: 'beauty/makeup/lip/lip-oil',
  });
  const rareLipstick = canonicalFentyProduct('ext_rare_lip', 'Rare Beauty Kind Words Matte Lipstick', {
    brand: 'Rare Beauty',
    merchant_name: 'Rare Beauty',
    source_product_id: 'ext_rare_lip',
    category: 'Lipstick',
    product_type: 'Lipstick',
    category_path: ['beauty', 'makeup', 'lip', 'lipstick'],
    catalog_category_path: 'beauty/makeup/lip/lipstick',
  });

  const oilGate = getSearchQualityContractHardConstraintResult(lipOil, contract, 'fenty lipstick');
  const rareGate = getSearchQualityContractHardConstraintResult(rareLipstick, contract, 'fenty lipstick');

  assert.equal(oilGate.eligible, false);
  assert.ok(oilGate.reasons.includes('strict_lipstick_mismatch'));
  assert.equal(rareGate.eligible, false);
  assert.ok(rareGate.reasons.includes('brand_mismatch'));

  const scored = scoreBeautyExternalSeedProduct({
    product: lipOil,
    queryText: 'fenty lipstick',
    intent,
    normalizedQuery: 'fenty lipstick',
    queryTokens: ['fenty', 'lipstick'],
    searchQualityContract: contract,
  });

  assert.equal(scored.relevant, false);
  assert.ok(scored.rejection_reasons.includes('strict_lipstick_mismatch'));
});

test('beauty search rejects non-beauty merchandise despite polluted beauty category paths', () => {
  const contract = buildSearchQualityContract({ rawQuery: 'rare beauty blush', market: 'US' });
  const dogToy = canonicalFentyProduct('rare_soft_pooch', 'Soft Pooch Blush Dog Toy - Faith', {
    brand: 'Rare Beauty',
    merchant_name: 'Rare Beauty',
    source_product_id: 'ext_soft_pooch_dog_toy',
    category: 'Blush',
    product_type: 'Blush',
    category_path: ['beauty', 'makeup', 'face', 'blush'],
    catalog_category_path: 'beauty/makeup/face/blush',
    destination_url: 'https://www.rarebeauty.com/products/soft-pooch-blush-dog-toy-faith',
  });
  const healthy = canonicalFentyProduct('rare_blush_1', 'Rare Beauty Soft Pinch Liquid Blush', {
    brand: 'Rare Beauty',
    merchant_name: 'Rare Beauty',
    category: 'Blush',
    product_type: 'Blush',
    category_path: ['beauty', 'makeup', 'face', 'blush'],
    catalog_category_path: 'beauty/makeup/face/blush',
  });

  const hardGate = getSearchQualityContractHardConstraintResult(dogToy, contract, 'rare beauty blush');
  assert.equal(hardGate.eligible, false);
  assert.ok(hardGate.reasons.includes('non_beauty_merchandise'));

  const servingGate = filterSearchServingEligibleProducts([dogToy, healthy], {
    queryText: 'rare beauty blush',
    requireBeauty: true,
  });
  assert.deepEqual(servingGate.products.map((product) => product.product_id), ['rare_blush_1']);
  assert.equal(servingGate.rejected_count, 1);
  assert.ok(servingGate.rejected[0].reasons.includes('non_beauty_merchandise'));

  const counts = buildSearchQualityTierCounts([healthy, dogToy], contract, 'rare beauty blush');
  assert.equal(counts.hard_constraint_reject_count, 1);
  assert.equal(counts.serving_eligible_count, 1);
  assert.equal(counts.polluted_or_unavailable_count, 1);
});

test('exact product contracts reject same-brand category matches that miss title anchor', () => {
  const contract = buildSearchQualityContract({
    rawQuery: 'rare beauty positive light tinted moisturizer',
    market: 'US',
  });
  const tintedMoisturizer = canonicalFentyProduct(
    'rare_positive_light_tinted_moisturizer',
    'Positive Light Tinted Moisturizer Broad Spectrum SPF 20 Sunscreen',
    {
      brand: 'Rare Beauty',
      merchant_name: 'Rare Beauty',
      category: 'Sunscreen',
      product_type: 'Sunscreen',
      category_path: ['beauty', 'skincare', 'sun'],
      catalog_category_path: 'beauty/skincare/sun',
    },
  );
  const blush = canonicalFentyProduct('rare_blush_1', 'Stay Vulnerable Melting Blush', {
    brand: 'Rare Beauty',
    merchant_name: 'Rare Beauty',
    category: 'Blush',
    product_type: 'Blush',
    category_path: ['beauty', 'makeup', 'face', 'blush'],
    catalog_category_path: 'beauty/makeup/face/blush',
  });

  const moisturizerGate = getSearchQualityContractHardConstraintResult(
    tintedMoisturizer,
    contract,
    'rare beauty positive light tinted moisturizer',
  );
  const blushGate = getSearchQualityContractHardConstraintResult(
    blush,
    contract,
    'rare beauty positive light tinted moisturizer',
  );

  assert.equal(contract.query_class, 'exact_product');
  assert.equal(contract.hard_constraints.category_path_prefix, null);
  assert.equal(moisturizerGate.eligible, true);
  assert.equal(blushGate.eligible, false);
  assert.ok(blushGate.reasons.includes('exact_product_mismatch'));
});

test('search quality tier counts expose polluted candidate inventory', () => {
  const contract = buildSearchQualityContract({ rawQuery: 'rare beauty blush', market: 'US' });
  const healthy = canonicalFentyProduct('rare_blush_1', 'Rare Beauty Soft Pinch Liquid Blush', {
    brand: 'Rare Beauty',
    merchant_name: 'Rare Beauty',
    category: 'Blush',
    product_type: 'Blush',
    category_path: ['beauty', 'makeup', 'face', 'blush'],
    catalog_category_path: 'beauty/makeup/face/blush',
  });
  const polluted = {
    product_id: 'sig_bad',
    merchant_id: 'external_seed',
    title: 'Rare Beauty Shipping Protection',
    brand: 'Rare Beauty',
    source: 'external_seed',
    category: 'external',
    product_type: 'external',
    price: 0,
    transaction_ready: false,
  };

  const counts = buildSearchQualityTierCounts([healthy, polluted], contract, 'rare beauty blush');

  assert.equal(counts.input_count, 2);
  assert.equal(counts.canonical_chain_count, 1);
  assert.equal(counts.external_seed_count, 1);
  assert.equal(counts.serving_eligible_count, 1);
  assert.equal(counts.invalid_price_count, 1);
  assert.equal(counts.polluted_or_unavailable_count, 1);
});

test('beauty mainline cards receive explicit pdp_open refs', () => {
  const product = compactBeautyMainlineProductForResponse({
    id: 'sig_lip_1',
    product_id: 'sig_lip_1',
    merchant_id: 'external_seed',
    platform: 'external_seed',
    source: 'external_seed',
    source_product_id: 'ext_lip_1',
    title: 'Fenty Icon Velvet Liquid Lipstick',
    brand: 'Fenty Beauty',
    price: 29,
    image_url: 'https://cdn.shopify.com/fenty/lip.jpg',
    category: 'Lipstick',
    product_type: 'Lipstick',
    category_path: ['beauty', 'makeup', 'lip', 'lipstick'],
    catalog_category_path: 'beauty/makeup/lip/lipstick',
    destination_url: 'https://fentybeauty.com/products/lip',
  }, inferBeautyMainlineIntent('fenty lipstick'), 'fenty lipstick');

  assert.equal(product.pdp_open.path, 'internal');
  assert.equal(product.pdp_open.product_ref.merchant_id, 'external_seed');
  assert.equal(product.pdp_open.product_ref.product_id, 'ext_lip_1');
  assert.equal(product.pdp_open.product_ref.pivota_signature_id, 'sig_lip_1');
  assert.equal(product.pdp_open.subject.id, 'sig_lip_1');
  assert.equal(product.canonical_product_ref.product_id, 'ext_lip_1');
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

test('a makeup face query recalls ITS OWN form, not the skincare defaults', () => {
  // MUTANT: delete the `beauty/makeup/face/` branch, or drop any single term from it.
  //
  // The first version of this test asserted `bronzer || foundation || powder` over all three
  // queries, so it passed with `bronzer` removed entirely — review found seven mutants surviving
  // it. Each query now asserts the term IT resolves to.
  //
  // Without the branch, a bronzer query matches nothing above, is not brand-browse, and falls to
  // ['sunscreen','cleanser','moisturizer','serum']; external-seed recall then searches skincare
  // and the makeup hard constraint rejects what it finds. Measured on prod 2026-09-10 UTC
  // (gateway f19c997a057b): all six retrieval arms carried the four skincare terms,
  // `category_mismatch: 206` against `ranker_rejected: 1`.
  const SKINCARE_DEFAULTS = ['sunscreen', 'cleanser', 'moisturizer', 'serum'];

  for (const [query, expected] of [
    ['bronzer for medium skin', 'bronzer'],
    ['setting powder', 'powder'],
    ['primer', 'primer'],
    ['highlighter makeup', 'highlighter'],
  ]) {
    const terms = buildBeautyExternalSeedCategoryTerms(inferBeautyMainlineIntent(query));
    assert.deepStrictEqual(
      terms, [expected],
      `${query} should recall exactly ["${expected}"], got ${JSON.stringify(terms)}`,
    );
    assert.ok(
      !SKINCARE_DEFAULTS.some((t) => terms.includes(t)),
      `${query} fell through to the skincare defaults: ${JSON.stringify(terms)}`,
    );
  }
});

test('a specific face form spends its whole row budget on that form', () => {
  // MUTANT: push the whole face set for a specific sub-prefix.
  //
  // `perCategoryRowLimit` is ceil(perScopeRowLimit / terms.length) clamped to >= 3, so ten terms
  // cut a bronzer query to 3 rows per tool scope where the single-term lip lane gets 24. And for
  // a seed with no category PATH the fallback admits a foundation for a bronzer query, with
  // `category_order` putting foundation first — so breadth here can serve the wrong form.
  const bronzer = buildBeautyExternalSeedCategoryTerms(
    inferBeautyMainlineIntent('bronzer for medium skin'),
  );
  assert.strictEqual(bronzer.length, 1, `bronzer recalled ${JSON.stringify(bronzer)}`);
  assert.ok(!bronzer.includes('foundation'), 'a bronzer query must never recall foundation');
});

test('every face term is a real derived-category label', () => {
  // The SQL matches `derived.recall.category` by EQUALITY, and that column is written from
  // BEAUTY_CATEGORY_PATTERNS. A display word that is not a label ('setting powder', 'skin tint',
  // 'cushion', 'luminizer', 'cheek') matches nothing and only dilutes the row budget. `primer` is
  // the deliberate exception: it has no label, but emitting `foundation` instead would serve the
  // wrong product.
  const LABELS = new Set(['foundation', 'concealer', 'powder', 'highlighter', 'blush', 'bronzer']);
  const bare = buildBeautyExternalSeedCategoryTerms(
    inferBeautyMainlineIntent('foundation for oily skin'),
  );
  assert.deepStrictEqual(
    bare, ['foundation', 'concealer', 'powder', 'highlighter', 'blush', 'bronzer'],
    `the bare-face set changed: ${JSON.stringify(bare)}`,
  );
  for (const t of bare) assert.ok(LABELS.has(t), `${t} is not a derived-category label`);
});

test('a blush query gets blush, not the whole face set', () => {
  const terms = buildBeautyExternalSeedCategoryTerms(inferBeautyMainlineIntent('blush'));
  assert.deepStrictEqual(terms, ['blush'], JSON.stringify(terms));
});

test('KNOWN GAP: a family word inside a makeup query still wins over the category prefix', () => {
  // NOT a regression and NOT fixed here — recorded so it is visible rather than surprising.
  //
  // `families` are matched before the prefix fallback, so 'cream blush' matches the MOISTURIZER
  // family on the word "cream" and never reaches the makeup branch. Same shape for
  // 'powder cleanser', 'tinted moisturizer', 'bb cream'. Fixing it means changing which signal
  // wins in `inferBeautyMainlineIntent`, one layer up, with a much wider blast radius.
  //
  // Asserted as the GAP rather than as the exact output: pinning `['moisturizer']` would also
  // fail if someone merely added a word to the moisturizer family, which is a different change.
  const terms = buildBeautyExternalSeedCategoryTerms(inferBeautyMainlineIntent('cream blush'));
  assert.ok(
    !terms.includes('blush'),
    `the prefix now wins — the precedence gap is fixed, update this test: ${JSON.stringify(terms)}`,
  );
});

test('the skincare, lip and fragrance lanes are unchanged', () => {
  const acne = buildBeautyExternalSeedCategoryTerms(
    inferBeautyMainlineIntent('acne treatment for clogged pores'),
  );
  assert.deepStrictEqual(acne, ['sunscreen', 'cleanser', 'moisturizer', 'serum'], JSON.stringify(acne));
  const lip = buildBeautyExternalSeedCategoryTerms(inferBeautyMainlineIntent('red lipstick'));
  assert.ok(lip.includes('lipstick'), JSON.stringify(lip));
  const fragrance = buildBeautyExternalSeedCategoryTerms(inferBeautyMainlineIntent('eau de parfum'));
  assert.ok(fragrance.includes('fragrance'), JSON.stringify(fragrance));
});


// ---------------------------------------------------------------------------
// LIP ROUTING, VERIFIED AT THE GATE.
//
// The first version of this change was verified by comparing
// `category_path_prefix` before and after. That is the wrong layer: routing a
// query to beauty/makeup/lip/ does nothing unless the ROW also satisfies the
// hard constraint, and `beautyProductMatchesCategoryPathQuery`'s lip branch had
// the same adjacency defect the query rules did. Measured then: the reported
// product was STILL rejected, and 748 queries moved, stranding lip products whose
// rows live in other trees. These tests run rows through the real gate.
// ---------------------------------------------------------------------------

function lipRow(title, categoryPath, productType) {
  return {
    id: 'lip_probe', product_id: 'lip_probe', merchant_id: 'merch_obs_jsm',
    title, brand: 'JUNGSAEMMOOL', price: 28.8, currency: 'SGD',
    image_url: 'https://cdn.example.com/lip.jpg',
    product_type: productType || '', category: productType || '',
    ...(categoryPath ? { category_path: categoryPath.split('/'), catalog_category_path: categoryPath } : {}),
    source: 'canonical_chain', search_recall_source: 'canonical_chain',
  };
}

function gateFor(query, row) {
  const contract = buildSearchQualityContract({ rawQuery: query, market: 'SG' });
  return {
    contract,
    result: getSearchQualityContractHardConstraintResult(row, contract, query),
  };
}

test('a depth-2 makeup row satisfies a lip query by its own title', () => {
  // The reported product. Its path is beauty/makeup — an ANCESTOR of the lip
  // prefix — so the gate admits it only through `ownTypeMatches`, which calls the
  // sink's lip branch with the row's own title. Adjacency-only arms failed it.
  const { contract, result } = gateFor(
    'LIP-PRESSION Metal Serum Gloss',
    lipRow('LIP-PRESSION Metal Serum Gloss', 'beauty/makeup'),
  );
  assert.equal(contract.hard_constraints.category_path_prefix, 'beauty/makeup/lip/');
  assert.equal(result.eligible, true, JSON.stringify(result.reasons));
});

test('lip products whose rows live in OTHER trees keep serving', () => {
  // Each of these was ELIGIBLE before the lip change and must stay so: their rows
  // are not ancestors of the lip prefix, so routing the query to lip/ would reject
  // them outright. The bare-`lip` arm sits below these head nouns for this reason.
  for (const [query, title, path, type] of [
    ['PDRN Lip Serum', 'PDRN Lip Serum', 'beauty/skincare/treat/serum', 'Serum'],
    ['Lip Sleeping Mask', 'Lip Sleeping Mask', 'beauty/skincare/treat/mask', 'Mask'],
    ['sunscreen for lips', 'PLAY Lip Shield SPF 30', 'beauty/skincare/sun/sunscreen', 'Sunscreen'],
    ['eye and lip makeup remover', 'Eye & Lip Makeup Remover', 'beauty/skincare/cleanse/remover', 'Remover'],
    ['lip and cheek tint', 'Mood Glider Lip And Blush Stick', 'beauty/makeup/face/blush', 'Blush'],
  ]) {
    const { result } = gateFor(query, lipRow(title, path, type));
    assert.equal(result.eligible, true, `${query} -> ${JSON.stringify(result.reasons)}`);
  }
});

test('a bare lip query still reaches the lip tree', () => {
  for (const query of ['dry lips', 'chapped lips', 'lip conditioner', '唇膏']) {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'SG' });
    assert.equal(
      contract.hard_constraints.category_path_prefix,
      'beauty/makeup/lip/',
      `${query} -> ${contract.hard_constraints.category_path_prefix}`,
    );
  }
});

test('CONTROL: a depth-2 row that is NOT a lip product is still rejected', () => {
  // This is the control that actually reaches the sink's lip branch. The rows in the
  // test below are rejected by the ANCESTOR check before the branch runs, so they
  // cannot tell a correct branch from `return true` — a mutant doing exactly that
  // survived them. A depth-2 `beauty/makeup` row IS an ancestor, so `ownTypeMatches`
  // runs the branch on its own title, which is the property under test:
  // widening the branch must not make an eyeliner satisfy a lip query.
  for (const [title, type] of [
    ['Precision Eyeliner Pen', 'Eyeliner'],
    ['Soft Matte Foundation', 'Foundation'],
    ['Artist Cushion Blush Blur', 'Blush'],
  ]) {
    const { result } = gateFor('lip gloss', lipRow(title, 'beauty/makeup', type));
    assert.equal(result.eligible, false, `${title} must not satisfy a lip query`);
    assert.ok(result.reasons.includes('category_mismatch'), JSON.stringify(result.reasons));
  }
});

test('CONTROL: the lip prefix still rejects rows from other makeup trees', () => {
  // Without this, every test above would also pass if the lip branch returned true
  // unconditionally — which is exactly how the sink could be "fixed" wrongly.
  for (const [title, path, type] of [
    ['Precision Eyeliner Pen', 'beauty/makeup/eye/eyeliner', 'Eyeliner'],
    ['Soft Matte Foundation', 'beauty/makeup/face/foundation', 'Foundation'],
    ['Volumising Shampoo', 'beauty/haircare/shampoo', 'Shampoo'],
  ]) {
    const { result } = gateFor('lip gloss', lipRow(title, path, type));
    assert.equal(result.eligible, false, `${title} should not satisfy a lip query`);
    assert.ok(result.reasons.includes('category_mismatch'), JSON.stringify(result.reasons));
  }
});

// ---------------------------------------------------------------------------
// STANDALONE `gloss`, and what the sink may admit under a lip query.
//
// Re-review of #2214: an unguarded `gloss` arm at the TOP of the rule table
// stole every gloss that belongs to another tree, and the widened sink admitted
// tools and two-area products at depth 2. Each case below failed against that
// version.
// ---------------------------------------------------------------------------

test('a gloss that belongs to another tree is not routed to lip', () => {
  for (const [query, notPrefix] of [
    ['gloss shampoo', 'beauty/makeup/lip/'],
    ['gloss serum', 'beauty/makeup/lip/'],
    ['blush gloss', 'beauty/makeup/lip/'],
    ['hair-gloss', 'beauty/makeup/lip/'],
    ['nail-gloss', 'beauty/makeup/lip/'],
    ['eye gloss', 'beauty/makeup/lip/'],
    ['top coat gloss', 'beauty/makeup/lip/'],
    ['body gloss oil', 'beauty/makeup/lip/'],
  ]) {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'SG' });
    assert.notEqual(contract.hard_constraints?.category_path_prefix, notPrefix, query);
  }
});

test('a lip gloss whose name does not say lip still routes to lip, above serum', () => {
  // CONTROL for the test above: a guard that refused every standalone gloss passes it.
  for (const query of ['Gloss Drip', 'glosses', 'LIP-PRESSION Metal Serum Gloss']) {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'SG' });
    assert.equal(contract.hard_constraints?.category_path_prefix, 'beauty/makeup/lip/', query);
  }
  const { result } = gateFor('Gloss Drip', lipRow('Gloss Drip', 'beauty/makeup'));
  assert.equal(result.eligible, true, JSON.stringify(result.reasons));
});

test('a lip TOOL query is not routed to the lip tree', () => {
  // lip_generic excludes brush/remover outright: no lip prefix can admit those rows.
  for (const query of ['lip brush', 'lip brushes', 'lip remover']) {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'SG' });
    assert.notEqual(contract.hard_constraints?.category_path_prefix, 'beauty/makeup/lip/', query);
  }
});

test('under a lip query, a depth-2 tool or two-area product is NOT a lip product', () => {
  for (const title of ['Lip & Eye Makeup Remover', '眼唇卸妆液', '唇刷', 'Eye and Lip Primer', 'Hair Gloss Treatment', 'Nail Gloss Top Coat']) {
    const { result } = gateFor('lip gloss', lipRow(title, 'beauty/makeup'));
    assert.equal(result.eligible, false, `${title} must not satisfy a lip query`);
  }
});

test('the widened sink arms read the row identity, not its description', () => {
  // PATHLESS on purpose: a row with a category_path is judged on title/type only by
  // the gate itself (`ownTypeMatches`), so it cannot see what the sink reads. A
  // pathless row reaches the sink with its whole text, description included.
  const row = { ...lipRow('Velvet Glow Cushion'), description: 'blend over cheeks and lips' };
  assert.equal(gateFor('lip gloss', row).result.eligible, false, 'a description mentioning lips is not lip evidence');
  // CONTROL: a row main already admitted by a compound arm is not newly rejected by the exclusions.
  const kit = lipRow('Lip Gloss Primer', 'beauty/makeup'); // `primer` is in the exclusion list
  assert.equal(gateFor('lip gloss', kit).result.eligible, true, 'origin/main compound arms run first');
});

test('the seed lane recalls lip forms beyond lipstick, and a lipstick query stays lipstick', () => {
  const terms = (q) => buildBeautyExternalSeedCategoryTerms(inferBeautyMainlineIntent(q));
  assert.deepStrictEqual(terms('red lipstick'), ['lipstick']);
  assert.deepStrictEqual(terms('Gloss Drip'), ['lip gloss', 'lipgloss', 'gloss']);
  assert.deepStrictEqual(terms('lip plumper'), ['lip plumper', 'plumper']);
  for (const q of ['dry lips', 'chapstick']) {
    const t = terms(q);
    assert.ok(t.includes('lip balm') && t.includes('lip gloss'), `${q} -> ${JSON.stringify(t)}`);
  }
});

// ---------------------------------------------------------------------------
// Second re-review of #2214. Each case below was wrong at 38923a61e.
// ---------------------------------------------------------------------------

test('under a lip query, a NON-LIP gloss row stays rejected, as on origin/main', () => {
  // The sink's bare `gloss` arm had only a hair/nail lookbehind; nails live under
  // beauty/makeup/, so a depth-2 top coat is a realistic row.
  for (const [title, path, type] of [
    ['High Gloss Top Coat', 'beauty/makeup', 'Nail Polish'],
    ['Gel Gloss Top Coat', 'beauty/makeup', ''],
    ['Gloss Hair Serum', 'beauty/makeup', ''],
    ['Gloss Finish Setting Spray', 'beauty/makeup', ''],
    ['Shine Gloss Spray', '', 'Hair Styling'],
    ['Volumising Shampoo', 'beauty/makeup', 'Gloss Shampoo'],
  ]) {
    const { result } = gateFor('lip gloss', lipRow(title, path, type));
    assert.equal(result.eligible, false, `${title} / ${type} must not satisfy a lip query`);
  }
  // CONTROL: the guard is not applied to a lip token -- the reported product names a serum.
  assert.equal(gateFor('lip gloss', lipRow('LIP-PRESSION Metal Serum Gloss', 'beauty/makeup')).result.eligible, true);
});

test('a product_type alone is lip evidence at depth 2', () => {
  const { result } = gateFor('lip gloss', lipRow('Bare Glow', 'beauty/makeup', 'Gloss'));
  assert.equal(result.eligible, true, JSON.stringify(result.reasons));
});

test('a chapstick row at depth 2 satisfies a chapstick query', () => {
  const { contract, result } = gateFor('chapstick', lipRow('Classic Chapstick', 'beauty/makeup'));
  assert.equal(contract.hard_constraints.category_path_prefix, 'beauty/makeup/lip/');
  assert.equal(result.eligible, true, JSON.stringify(result.reasons));
});

test('a CJK lip query admits its own depth-2 CJK rows, and still refuses CJK tools', () => {
  // Same shape as the reported bug: `唇` routed the query to lip, and the sink then
  // rejected the row, because bare 唇 was not a sink arm.
  for (const [query, title] of [['唇泥', '唇泥'], ['唇膏', '唇蜜']]) {
    const { result } = gateFor(query, lipRow(title, 'beauty/makeup'));
    assert.equal(result.eligible, true, `${query} -> ${title}: ${JSON.stringify(result.reasons)}`);
  }
  // Now load-bearing: without the exclusion, bare 唇 admits these.
  for (const title of ['唇刷', '眼唇卸妆液']) {
    assert.equal(gateFor('唇膏', lipRow(title, 'beauty/makeup')).result.eligible, false, title);
  }
});

test('non-beauty gloss senses and CJK lip tools are not routed to lip', () => {
  for (const query of ['gloss paint', 'high gloss paint', 'semi-gloss', 'gloss varnish', 'gloss finish',
    'gloss photo paper', 'gel gloss', 'gloss spray', 'cheek gloss', '唇刷', '眼唇']) {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'SG' });
    assert.notEqual(contract.hard_constraints?.category_path_prefix, 'beauty/makeup/lip/', query);
  }
  // CONTROL
  assert.equal(buildSearchQualityContract({ rawQuery: 'lip and cheek gloss', market: 'SG' })
    .hard_constraints?.category_path_prefix, 'beauty/makeup/lip/');
});

test('the high-precedence lip arms outrank the skincare rules they sit above', () => {
  // `lip plumper` and 唇釉 live in the TOP rule; `lip_generic` at the bottom would lose
  // these to the treatment / sunscreen rules.
  for (const query of ['Lip Plump - Refresh AHA BHA Vitamin C Lip Plumper', '唇釉 防晒', '唇泥']) {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'SG' });
    assert.equal(contract.hard_constraints?.category_path_prefix, 'beauty/makeup/lip/', query);
  }
});

test('the brand-category text terms for a lipstick query are unchanged from origin/main', () => {
  // explicitBeautyLipFormTerms has TWO callers. Pinning lipstick inside it narrowed this
  // one from four terms to one; the pin now lives in the category-terms caller only.
  const { buildBeautyExternalSeedBrandCategoryTextTerms } = app._debug;
  for (const query of ['dior rouge', 'fenty lipstick', 'liquid lip']) {
    assert.deepStrictEqual(
      buildBeautyExternalSeedBrandCategoryTextTerms(query, inferBeautyMainlineIntent(query)),
      ['lipstick', 'lip color', 'liquid lip', 'rouge'],
      query,
    );
  }
  assert.deepStrictEqual(
    buildBeautyExternalSeedCategoryTerms(inferBeautyMainlineIntent('lip color')), ['lipstick'],
    'lip color is claimed by the lipstick rule, so it seeds lipstick only',
  );
});

test('a single-area lip tool or primer is rejected by the SINK, not only by the accessory gate', () => {
  // `Lip & Eye …` rows are also caught by the two-area arm, and a brush by
  // accessory_for_product_query, so neither can observe the brush/remover/primer
  // exclusion on its own. These titles carry a bare `lip` and nothing else.
  for (const title of ['Lip Makeup Remover', 'Smoothing Lip Primer', 'Lip Brush']) {
    const { result } = gateFor('lip gloss', lipRow(title, 'beauty/makeup'));
    assert.ok(result.reasons.includes('category_mismatch'), `${title}: ${JSON.stringify(result.reasons)}`);
  }
});

// ---------------------------------------------------------------------------
// ONE CASE PER GUARD TOKEN. Third re-review of #2214: 23 of 29 single-token
// deletions left every test green, because the rows and queries each test used
// were caught by some OTHER token. Each entry below is caught by exactly one.
// ---------------------------------------------------------------------------

test('sink: every token of the bare-gloss guard is load-bearing', () => {
  for (const title of ['Top Coat Gloss', 'Gloss Polish', 'Nail Gloss', 'Hair Gloss', 'Gloss Shampoo',
    'Gloss Conditioner', 'Gloss Spray', 'Setting Gloss', 'Gloss Serum', 'Gloss Essence', 'Gloss Ampoule',
    'Gloss Treatment', 'Gloss Highlighter', 'Blush Gloss', 'Eye Gloss', 'Brow Gloss', 'Lash Gloss',
    'Body Gloss', 'Face Gloss', 'Skin Gloss', 'Gloss Paint', 'Gloss Varnish', 'Cheek Gloss']) {
    const { result } = gateFor('lip gloss', lipRow(title, 'beauty/makeup'));
    assert.ok(result.reasons.includes('category_mismatch'), `${title}: ${JSON.stringify(result.reasons)}`);
  }
});

test('sink: every token of the tool / two-area exclusion is load-bearing', () => {
  for (const title of ['Lip Brush', 'Lip Remover', 'Lip Primer', 'Eye and Lip Palette', 'Lip and Eye Palette',
    '唇部卸妆膏', '唇部卸妝膏', '唇刷', '眼唇霜']) {
    const { result } = gateFor('lip gloss', lipRow(title, 'beauty/makeup'));
    assert.ok(result.reasons.includes('category_mismatch'), `${title}: ${JSON.stringify(result.reasons)}`);
  }
});

test('sink: the joined lip forms admit their no-space spellings', () => {
  for (const title of ['Lipplumper Max', 'Lipoil Cherry']) {
    const { result } = gateFor('lip gloss', lipRow(title, 'beauty/makeup'));
    assert.equal(result.eligible, true, `${title}: ${JSON.stringify(result.reasons)}`);
  }
});

test('query: every token of the standalone-gloss guard is load-bearing', () => {
  for (const word of ['serum', 'essence', 'ampoule', 'treatment', 'hair', 'nail', 'eye', 'brow', 'lash', 'body',
    'face', 'skin', 'polish', 'top coat', 'paint', 'varnish', 'lacquer', 'paper', 'spray', 'gel', 'finish',
    'floor', 'wall', 'wood', 'semi', 'cheek', 'brush', 'remover', 'keychain']) {
    const query = `gloss ${word}`;
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'SG' });
    assert.notEqual(contract.hard_constraints?.category_path_prefix, 'beauty/makeup/lip/', query);
  }
});

test('a high-shine gloss product name still routes to lip', () => {
  // CONTROL for the guard above: `high` was briefly a guard word and removed 18 real Fenty
  // lip titles from the lip tree.
  for (const query of ['Gloss Bomb Stix High-Shine Gloss Stick — RiRi', 'Mini High Gloss Duo']) {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'SG' });
    assert.equal(contract.hard_constraints?.category_path_prefix, 'beauty/makeup/lip/', query);
  }
});

test('query: every token of the lip_generic exclusion is load-bearing', () => {
  for (const query of ['lip brush', 'lip remover', 'lip and cheek stain', 'lip sync', 'lip filler',
    'lip injections', 'cleft lip', 'lip-shaped bag', 'read my lips', 'lip bundle', 'lip combo',
    '唇刷', '眼唇', '兔唇']) {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'SG' });
    assert.notEqual(contract.hard_constraints?.category_path_prefix, 'beauty/makeup/lip/', query);
  }
});

test('seed lane: every lipstick-rule spelling keeps lipstick only, in both callers', () => {
  const { buildBeautyExternalSeedBrandCategoryTextTerms } = app._debug;
  // `lip\s*sticks?` covers `lipstick` too; `lip stick` pins the spaced spelling.
  for (const query of ['red lipstick', 'red lip stick', 'lip color', 'liquid lip', 'rouge', '口红', '口紅']) {
    assert.deepStrictEqual(buildBeautyExternalSeedCategoryTerms(inferBeautyMainlineIntent(query)), ['lipstick'], query);
    assert.deepStrictEqual(
      buildBeautyExternalSeedBrandCategoryTextTerms(query, inferBeautyMainlineIntent(query)),
      ['lipstick', 'lip color', 'liquid lip', 'rouge'], query,
    );
  }
  assert.deepStrictEqual(buildBeautyExternalSeedCategoryTerms(inferBeautyMainlineIntent('dry lips')),
    ['lipstick', 'lip balm', 'lip gloss', 'lip tint', 'lip']);
  // A newly lip-routed NON-lipstick brand query must not REQUIRE lipstick words.
  assert.deepStrictEqual(
    buildBeautyExternalSeedBrandCategoryTextTerms('dior lip glow', inferBeautyMainlineIntent('dior lip glow')),
    ['lipstick', 'lip color', 'liquid lip', 'rouge', 'lip balm', 'lip gloss', 'lip tint', 'lip'],
  );
});
