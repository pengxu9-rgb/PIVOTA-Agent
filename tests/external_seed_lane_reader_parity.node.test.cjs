'use strict';

// ADR-009 phase 0a — reader migration parity.
//
// The legacy synthetic merchant `external_seed` is being retired: catalog_products
// rows written by the external-seed writer are re-keyed onto per-domain observed
// sellers (`merch_obs_…`). 1,365 rows are ALREADY re-keyed in prod; ~8,974 are not.
// The re-key touches merchant_id ONLY — product_key, signatures, platform and
// source_system are all frozen (ADR-009 D4.2).
//
// So every reader that discriminates on the merchant_id LITERAL is already
// treating two halves of one corpus differently. This suite is the dress
// rehearsal the design doc asks for (§5 Phase 0): for each migrated site, assert
// that
//
//   (a) a SENTINEL-shaped row and a merch_obs_-shaped row carrying the SAME
//       platform / source_system get the SAME treatment;
//   (b) a genuinely unrelated merchant row keeps its OLD treatment — the
//       migration must not over-broaden;
//   (c) the pre-existing non-seed legs at each site are untouched.
//
// Every (a) assertion below is designed to FAIL against origin/main.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { seedRoutedLaneSql, isSeedRoutedLane } = require('../src/services/pdpRenderability');
const { isExternalSeedLaneProduct } = require('../src/services/externalSeedLane');
const { notTestMerchantSql, getTestMerchantIds } = require('../src/services/testMerchantPolicy');

// ---------------------------------------------------------------------------
// Row fixtures. Each PAIR differs ONLY in merchant_id — exactly what phase 3
// changes and nothing else.
// ---------------------------------------------------------------------------

const OBSERVED_SELLER_ID = 'merch_obs_7f3a2b1c9d4e5f60';

// Path B — external_product_seeds_mirror_v1. This is the writer whose 1,365
// rows are already re-keyed in prod.
//
// source_product_id is deliberately NOT `ext_`/`ext:` prefixed: the shared
// predicate has an id-prefix leg, and if the fixture tripped it the test would
// pass on origin/main for the wrong reason and prove nothing.
const MIRROR_SENTINEL = Object.freeze({
  merchant_id: 'external_seed',
  platform: 'external_seed',
  source_system: 'external_product_seeds_mirror_v1',
  source_product_id: 'skinfix-barrier-lipid-repair-balm',
  title: 'Barrier+ Lipid-Peptide Cream',
});
const MIRROR_REKEYED = Object.freeze({ ...MIRROR_SENTINEL, merchant_id: OBSERVED_SELLER_ID });

// Path C — catalog_enrichment_agent_v1 ("minted canonical"). Per
// pdpRenderability's header these rows carry a canonical NAME SLUG as
// source_product_id, so again no id-prefix rescue. platform is left blank here
// on purpose so this pair exercises the source_system leg on its own.
const MINTED_SENTINEL = Object.freeze({
  merchant_id: 'external_seed',
  platform: '',
  source_system: 'catalog_enrichment_agent_v1',
  source_product_id: 'fenty-beauty-eaze-drop-blur-stick',
  title: 'Eaze Drop Blur Stick',
});
const MINTED_REKEYED = Object.freeze({ ...MINTED_SENTINEL, merchant_id: 'merch_obs_c0ffee1234567890' });

// The over-broadening control: a real connected Shopify seller. Nothing about
// this row may change.
const SHOPIFY_ROW = Object.freeze({
  merchant_id: 'merch_shopify_9a8b7c6d5e4f3021',
  platform: 'shopify',
  source_system: 'shopify_catalog_sync_v1',
  source_product_id: '8123456789012',
  title: 'Snowboard',
});

const SEED_PAIRS = [
  ['mirror lane (external_product_seeds_mirror_v1)', MIRROR_SENTINEL, MIRROR_REKEYED],
  ['minted lane (catalog_enrichment_agent_v1)', MINTED_SENTINEL, MINTED_REKEYED],
];

// ---------------------------------------------------------------------------
// 0. The shared predicate itself.
// ---------------------------------------------------------------------------

test('externalSeedLane: sentinel and re-keyed rows are the same lane; shopify is not', () => {
  for (const [label, sentinel, rekeyed] of SEED_PAIRS) {
    assert.equal(isExternalSeedLaneProduct(sentinel), true, `${label}: sentinel must be seed lane`);
    assert.equal(
      isExternalSeedLaneProduct(rekeyed),
      true,
      `${label}: re-keyed merch_obs_ row must be seed lane (this is the assertion that fails on main)`,
    );
  }
  assert.equal(isExternalSeedLaneProduct(SHOPIFY_ROW), false, 'shopify row must NOT be seed lane');
  assert.equal(isExternalSeedLaneProduct(null), false);
  assert.equal(isExternalSeedLaneProduct('external_seed'), false, 'a bare string is not a row');
  assert.equal(isExternalSeedLaneProduct([]), false);
});

test('externalSeedLane: camelCase and payload-nested aliases resolve to the same answer', () => {
  assert.equal(
    isExternalSeedLaneProduct({ merchantId: OBSERVED_SELLER_ID, platform: 'external_seed' }),
    true,
  );
  assert.equal(
    isExternalSeedLaneProduct({
      merchant_id: OBSERVED_SELLER_ID,
      product_data: { platform: 'external_seed' },
    }),
    true,
  );
  // The id-prefix leg reads the runtime candidate shapes too, and now covers
  // `ext:` as well as `ext_` — matching the canonical predicate.
  assert.equal(isExternalSeedLaneProduct({ merchant_id: OBSERVED_SELLER_ID, id: 'ext:9f21' }), true);
  assert.equal(isExternalSeedLaneProduct({ merchant_id: OBSERVED_SELLER_ID, product_id: 'ext_9f21' }), true);
});

test('externalSeedLane delegates to pdpRenderability — one definition, not a copy', () => {
  for (const row of [MIRROR_SENTINEL, MIRROR_REKEYED, MINTED_SENTINEL, MINTED_REKEYED, SHOPIFY_ROW]) {
    assert.equal(
      isExternalSeedLaneProduct(row),
      isSeedRoutedLane({
        merchantId: row.merchant_id,
        platform: row.platform,
        sourceSystem: row.source_system,
        sourceProductId: row.source_product_id,
      }),
      `adapter and canonical predicate disagree for ${row.merchant_id}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 1. productGroundingResolver.isExternalProduct — "the one file that genuinely
//    breaks". A false answer here lets a seed product through
//    allow_external_seed=false.
// ---------------------------------------------------------------------------

test('productGroundingResolver.isExternalProduct: sentinel/re-keyed parity', () => {
  const { isExternalProduct } = require('../src/services/productGroundingResolver')._internals;
  for (const [label, sentinel, rekeyed] of SEED_PAIRS) {
    assert.equal(isExternalProduct(sentinel), true, `${label}: sentinel`);
    assert.equal(isExternalProduct(rekeyed), true, `${label}: re-keyed (fails on main)`);
  }
  assert.equal(isExternalProduct(SHOPIFY_ROW), false, 'shopify row must stay internal');
});

test('productGroundingResolver.isExternalProduct: legacy non-seed legs unchanged', () => {
  const { isExternalProduct } = require('../src/services/productGroundingResolver')._internals;
  assert.equal(isExternalProduct({ merchant_id: 'merch_x', platform: 'external' }), true);
  assert.equal(isExternalProduct({ merchant_id: 'merch_x', source: 'external' }), true);
  assert.equal(isExternalProduct({ merchant_id: 'merch_x', source_type: 'external_seed' }), true);
  assert.equal(isExternalProduct({ merchant_id: 'merch_x', product_id: 'ext_abc' }), true);
  assert.equal(isExternalProduct({ merchant_id: 'merch_x', platform: 'shopify' }), false);
  assert.equal(isExternalProduct({}), false);
});

test('productGroundingResolver still STAMPS the sentinel on synthesized seed products', async () => {
  // Deliberate: a seed row with no catalog_products row has NO seller of record.
  // ADR-009 D2 forbids inventing one, and ensure_observed_seller cannot mint
  // here anyway (it keys on (normalized_brand, etld1) and raises on an empty
  // brand). So this write keeps the sentinel while the READS above move off it.
  //
  // Exercised for real rather than asserted against source text, so the whole
  // synthesized shape — product_id included — is covered.
  const dbPath = require.resolve('../src/db/index.js');
  const modPath = require.resolve('../src/services/productGroundingResolver.js');
  const seedRow = {
    id: '90d1f2a3-0000-4000-8000-000000000001',
    external_product_id: 'skinfix-barrier-lipid-repair-balm',
    title: 'Barrier+ Lipid-Peptide Cream',
    canonical_url: 'https://www.skinfixinc.com/products/barrier-cream',
    destination_url: 'https://www.skinfixinc.com/products/barrier-cream',
    domain: 'skinfixinc.com',
    seed_data: { brand: 'Skinfix', title: 'Barrier+ Lipid-Peptide Cream', category: 'moisturizer' },
  };
  const priorDb = require.cache[dbPath];
  const priorMod = require.cache[modPath];
  const priorDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://stub/stub';
  delete require.cache[modPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      query: async () => ({ rows: [] }),
      withClient: async (fn) =>
        fn({
          query: async (sql) =>
            String(sql).trim().startsWith('SET') ? { rows: [] } : { rows: [seedRow] },
        }),
    },
  };
  let result;
  let isExternalProduct;
  try {
    const mod = require('../src/services/productGroundingResolver');
    isExternalProduct = mod._internals.isExternalProduct;
    result = await mod._internals.fetchCandidatesViaExternalSeedRecall({
      query: 'skinfix barrier cream',
      hintBrand: 'Skinfix',
      limit: 5,
      timeoutMs: 500,
    });
  } finally {
    if (priorDb) require.cache[dbPath] = priorDb;
    else delete require.cache[dbPath];
    delete require.cache[modPath];
    if (priorMod) require.cache[modPath] = priorMod;
    if (priorDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDbUrl;
  }

  assert.equal(result.ok, true, result.reason || 'recall should succeed');
  assert.equal(result.products.length, 1);
  const synthesized = result.products[0];
  assert.equal(synthesized.product_id, seedRow.external_product_id, 'product_id must survive');
  assert.equal(synthesized.merchant_id, 'external_seed', 'sentinel stamp is intentional here');
  assert.equal(synthesized.title, seedRow.title);
  // And the stamp is a provenance LABEL, not a routing key: the migrated reader
  // classifies this object via its source/source_type legs regardless.
  assert.equal(isExternalProduct(synthesized), true);
  assert.equal(isExternalProduct({ ...synthesized, merchant_id: 'merch_obs_deadbeef00000000' }), true);
});

// ---------------------------------------------------------------------------
// 2. RecommendationEngine.isExternalProduct — drives internal/external candidate
//    splitting, brand-authority filtering and the retrieval_mix counters.
// ---------------------------------------------------------------------------

test('RecommendationEngine.isExternalProduct: sentinel/re-keyed parity', () => {
  const { isExternalProduct } = require('../src/services/RecommendationEngine')._internals;
  for (const [label, sentinel, rekeyed] of SEED_PAIRS) {
    assert.equal(isExternalProduct(sentinel), true, `${label}: sentinel`);
    assert.equal(isExternalProduct(rekeyed), true, `${label}: re-keyed (fails on main)`);
  }
  assert.equal(isExternalProduct(SHOPIFY_ROW), false, 'shopify row must stay internal');
  // Legacy legs preserved.
  assert.equal(isExternalProduct({ merchant_id: 'merch_x', platform: 'external' }), true);
  assert.equal(isExternalProduct({ merchant_id: 'merch_x', source: 'external_seed' }), true);
});

// ---------------------------------------------------------------------------
// 3. RecommendationEngine SQL sites.
//
// The generated SQL is captured for real by stubbing the db module before the
// engine is required, so these assert on what actually reaches Postgres rather
// than on source text.
// ---------------------------------------------------------------------------

function loadEngineWithCapturedSql(resultRows = []) {
  const dbPath = require.resolve('../src/db/index.js');
  const enginePath = require.resolve('../src/services/RecommendationEngine.js');
  const captured = [];
  const record = async (sql, params) => {
    captured.push({ sql: String(sql), params });
    return { rows: resultRows };
  };
  const priorDb = require.cache[dbPath];
  const priorEngine = require.cache[enginePath];
  delete require.cache[enginePath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      query: record,
      queryWithStatementTimeout: record,
      withClient: async (fn) => fn({ query: record }),
    },
  };
  let engine;
  try {
    engine = require('../src/services/RecommendationEngine');
  } finally {
    if (priorDb) require.cache[dbPath] = priorDb;
    else delete require.cache[dbPath];
    delete require.cache[enginePath];
    if (priorEngine) require.cache[enginePath] = priorEngine;
  }
  return { engine, captured };
}

test('fetchCatalogCandidates seed-lane-only mode: lane predicate + testMerchantPolicy restored', async () => {
  const priorDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://stub/stub';
  try {
    const { engine, captured } = loadEngineWithCapturedSql();
    await engine._internals.fetchCatalogCandidates({
      brandHint: 'fenty beauty',
      categoryHint: 'moisturizer',
      categoryPathHint: 'beauty/skincare/moisturizer',
      sourceMerchantHint: 'external_seed', // the lane selector the PDP recs caller passes
      limit: 20,
    });
    assert.ok(captured.length > 0, 'expected a captured catalog query');
    const sql = captured[captured.length - 1].sql;

    // (a) The lane gate is the SHARED predicate, verbatim — so its JS twin,
    //     parity-tested above, is provably the same rule.
    assert.ok(
      sql.includes(seedRoutedLaneSql('cp')),
      'seed-lane-only WHERE must use the shared seedRoutedLaneSql predicate (fails on main)',
    );
    // Which means a merch_obs_ row is admitted by platform / source_system.
    assert.ok(sql.includes("lower(trim(coalesce(cp.platform, ''))) = 'external_seed'"));
    assert.ok(sql.includes("lower(trim(coalesce(cp.source_system, '')))"));
    // …and un-re-keyed rows still match on merchant_id.
    assert.ok(sql.includes("cp.merchant_id = 'external_seed'"));

    // (b) THE TEST-MERCHANT BYPASS. This branch used to REPLACE
    //     activeCatalogProductSourceWhere outright, and that helper is the only
    //     carrier of the rig exclusion — so this lane had no testMerchantPolicy
    //     gate at all.
    assert.ok(
      sql.includes(notTestMerchantSql('cp', { hasSourceDomain: true })),
      'seed-lane-only WHERE must compose the shared test-merchant exclusion (fails on main)',
    );
    for (const rigId of getTestMerchantIds()) {
      assert.ok(sql.includes(`'${rigId}'`), `rig ${rigId} must be excluded from the seed-lane query`);
    }

    // (c) The single-round-trip optimisation this branch exists for is intact:
    //     no catalog_merchants join.
    assert.ok(!sql.includes('LEFT JOIN catalog_merchants'), 'seed-lane-only mode must stay join-free');

    // (d) The seed price/availability join is lane-keyed too, so re-keyed rows
    //     keep their price and availability.
    const joinBlock = sql.slice(sql.indexOf('LEFT JOIN external_product_seeds'), sql.indexOf('INNER JOIN index_pipeline_state'));
    assert.ok(
      joinBlock.includes(seedRoutedLaneSql('cp')),
      'eps price join must be lane-keyed, not merchant_id-keyed (fails on main)',
    );
  } finally {
    if (priorDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDbUrl;
  }
});

test('fetchCatalogCandidates normal mode is unchanged — still the full shared source gate', async () => {
  const priorDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://stub/stub';
  try {
    const { engine, captured } = loadEngineWithCapturedSql();
    const { activeCatalogProductSourceWhere } = require('../src/services/activeCatalogSourceSql');
    await engine._internals.fetchCatalogCandidates({
      brandHint: 'fenty beauty',
      categoryHint: 'moisturizer',
      categoryPathHint: 'beauty/skincare/moisturizer',
      sourceMerchantHint: '', // NOT the seed lane
      limit: 20,
    });
    const sql = captured[captured.length - 1].sql;
    assert.ok(sql.includes(activeCatalogProductSourceWhere('cp', 'cm')), 'normal mode gate must be untouched');
    assert.ok(sql.includes('LEFT JOIN catalog_merchants'), 'normal mode still joins catalog_merchants');
  } finally {
    if (priorDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDbUrl;
  }
});

test('RecommendationEngine carries no merchant_id-literal catalog gate left', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'RecommendationEngine.js'),
    'utf8',
  );
  // The five correlated category_path lookups (EXTERNAL_SEED_*_SELECT) and the
  // source-unavailable suppression. Each was `merchant_id = 'external_seed'`
  // and each returns nothing / suppresses nothing once the re-key lands.
  assert.equal(
    (src.match(/catalog_seed_product\.merchant_id = 'external_seed'/g) || []).length,
    0,
    'correlated seed lookups must not gate on the merchant_id literal (fails on main)',
  );
  assert.equal(
    (src.match(/cp\.merchant_id = 'external_seed'/g) || []).length,
    0,
    'catalog_products reads must not gate on the merchant_id literal (fails on main)',
  );
  // …and the replacement is present at all five lookup sites.
  assert.equal(
    (src.match(/seedRoutedLaneSql\('catalog_seed_product'\)/g) || []).length,
    5,
    'all five correlated seed lookups must use the shared predicate',
  );
});

// ---------------------------------------------------------------------------
// 3b. CANDIDATE-BUILDER parity — end to end, not on raw rows.
//
// buildCatalogProductRecommendationCandidate is the STAMPER: it decides the
// candidate's `platform`/`source`, and every downstream external/internal
// question reads those stamps rather than the row. A raw-row parity assertion
// says nothing about it, so this drives a row all the way through
// fetchCatalogCandidates and asserts on the emitted candidate.
//
// The MINTED pair is the one that matters: blank platform, so the ONLY seed
// evidence left after the re-key is source_system.
// ---------------------------------------------------------------------------

function catalogRowFor(merchantId) {
  return {
    product_key: `prod::${merchantId}::fenty-eaze-drop-blur-stick`,
    content_key: 'ck_minted_1',
    merchant_id: merchantId,
    platform: '',
    source_system: 'catalog_enrichment_agent_v1',
    source_product_id: 'fenty-beauty-eaze-drop-blur-stick',
    product_title: 'Eaze Drop Blur Stick',
    product_description: 'blurring stick',
    brand: 'Fenty Beauty',
    product_type: 'primer',
    category: 'makeup',
    category_path: 'beauty/makeup/face',
    canonical_url: 'https://fentybeauty.com/products/eaze-drop-blur-stick',
    product_image_url: 'https://cdn.example/img.jpg',
    price_amount: '38.00',
    price_currency: 'USD',
    availability: 'in_stock',
    product_payload: {},
    pivota_signature_id: 'sig_minted_1',
    pivota_canonical_url: 'https://agent.pivota.cc/products/sig_minted_1',
    updated_at: new Date('2026-07-18T00:00:00Z'),
  };
}

async function candidateFor(merchantId) {
  const priorDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://stub/stub';
  try {
    const { engine } = loadEngineWithCapturedSql([catalogRowFor(merchantId)]);
    const products = await engine._internals.fetchCatalogCandidates({
      brandHint: 'fenty beauty',
      categoryHint: 'primer',
      categoryPathHint: 'beauty/makeup/face',
      sourceMerchantHint: 'external_seed',
      limit: 10,
    });
    return { candidate: products[0] || null, isExternalProduct: engine._internals.isExternalProduct };
  } finally {
    if (priorDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDbUrl;
  }
}

test('candidate builder: a re-keyed minted row is stamped exactly like the sentinel row', async () => {
  const sentinel = await candidateFor('external_seed');
  const rekeyed = await candidateFor('merch_obs_c0ffee1234567890');

  assert.ok(sentinel.candidate, 'sentinel row must produce a candidate');
  assert.ok(rekeyed.candidate, 're-keyed row must produce a candidate');

  // The stamps themselves — this is what everything downstream reads.
  assert.equal(sentinel.candidate.platform, 'external');
  assert.equal(sentinel.candidate.source, 'external_seed');
  assert.equal(
    rekeyed.candidate.platform,
    sentinel.candidate.platform,
    're-keyed row must not be stamped as a connected-merchant product (was "catalog")',
  );
  assert.equal(
    rekeyed.candidate.source,
    sentinel.candidate.source,
    're-keyed row must not be stamped source="catalog_products"',
  );

  // …and therefore the external/internal split, retrieval_mix, brand-authority
  // filtering and the external flags all agree for both populations.
  assert.equal(sentinel.isExternalProduct(sentinel.candidate), true);
  assert.equal(
    rekeyed.isExternalProduct(rekeyed.candidate),
    true,
    'classification must not invert between the two halves of one corpus',
  );

  // The row-level evidence the stamp now depends on must actually be projected.
  assert.equal(
    rekeyed.candidate.product_id,
    sentinel.candidate.product_id,
    'both must resolve the seed id, not the product_key fallback',
  );
});

test('candidate builder: source_system reaches it — the column is in the projection', async () => {
  const priorDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://stub/stub';
  try {
    const { engine, captured } = loadEngineWithCapturedSql([]);
    await engine._internals.fetchCatalogCandidates({
      brandHint: 'fenty beauty',
      categoryHint: 'primer',
      categoryPathHint: 'beauty/makeup/face',
      sourceMerchantHint: 'external_seed',
      limit: 10,
    });
    // Without this the WHERE can admit a row on source_system that the builder
    // is then blind to — which is exactly how the stamp inverted.
    assert.match(captured[captured.length - 1].sql, /\bcp\.source_system\b/);
  } finally {
    if (priorDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDbUrl;
  }
});

// ---------------------------------------------------------------------------
// 3c. Alias / precedence regressions the adapter must not introduce. These are
// NOT migration-dependent — they break rows still carrying the sentinel today.
// ---------------------------------------------------------------------------

test('adapter reads the nested merchant.id shape', () => {
  const { isExternalProduct } = require('../src/services/RecommendationEngine')._internals;
  // getMerchantId has always read product.merchant.id, and chat/search items are
  // constructed carrying a nested merchant object (src/server.js:27398).
  assert.equal(isExternalSeedLaneProduct({ merchant: { id: 'external_seed' } }), true);
  assert.equal(isExternalProduct({ merchant: { id: 'external_seed' }, title: 'x' }), true);
  assert.equal(isExternalSeedLaneProduct({ merchant: { id: OBSERVED_SELLER_ID }, platform: 'external_seed' }), true);
  assert.equal(isExternalProduct({ merchant: { id: 'merch_shopify_9a8b' }, platform: 'shopify' }), false);
  assert.equal(isExternalSeedLaneProduct({ merchant: 'external_seed' }), false, 'a string merchant is not an object');
});

test('adapter tests EVERY id alias, not just the first non-empty one', () => {
  const { isExternalProduct } = require('../src/services/RecommendationEngine')._internals;
  // The old legs were a fallback chain over product_id||productId||id, so an
  // ext_ product_id counted even when source_product_id was a plain merchant id.
  const mixed = { merchant_id: 'merch_shopify_x', source_product_id: '8123456789012', product_id: 'ext_abc123' };
  assert.equal(isExternalSeedLaneProduct(mixed), true);
  assert.equal(isExternalProduct(mixed), true);
  // And the reverse ordering still works.
  assert.equal(
    isExternalSeedLaneProduct({ merchant_id: 'merch_shopify_x', source_product_id: 'ext_abc123', id: '999' }),
    true,
  );
  // No id leg at all → not seed lane.
  assert.equal(
    isExternalSeedLaneProduct({ merchant_id: 'merch_shopify_x', source_product_id: '8123456789012', id: '999' }),
    false,
  );
});

test('DISCLOSED WIDENING: id-prefix matching is case-insensitive, matching the SQL twin', () => {
  // Pre-migration this was `pid.startsWith('ext_')` — case-sensitive, ext_ only.
  // seedRoutedLaneSql lowercases and accepts ext: too, and it already governs
  // PDP signature resolution for these same rows, so the JS half matches it
  // rather than disagreeing with it. Pinned here so the widening cannot drift
  // back in unnoticed, in either direction.
  assert.equal(isExternalSeedLaneProduct({ merchant_id: 'merch_x', id: 'EXT_ABC' }), true);
  assert.equal(isExternalSeedLaneProduct({ merchant_id: 'merch_x', id: 'ext_abc' }), true);
  assert.equal(isExternalSeedLaneProduct({ merchant_id: 'merch_x', id: 'EXT:ABC' }), true);
  // Still narrow where it matters: `_` is not a wildcard and `extX` must not match.
  assert.equal(isExternalSeedLaneProduct({ merchant_id: 'merch_x', id: 'extXabc' }), false);
});

// ---------------------------------------------------------------------------
// 4. auroraBff/routes.js — concern-framework external-seed authority.
// ---------------------------------------------------------------------------

test('routes: external-seed authority holds for sentinel AND re-keyed rows', () => {
  const { hasConcernFrameworkExternalSeedAuthority } = require('../src/auroraBff/routes').__internal;
  for (const [label, sentinel, rekeyed] of SEED_PAIRS) {
    assert.equal(hasConcernFrameworkExternalSeedAuthority(sentinel), true, `${label}: sentinel`);
    assert.equal(hasConcernFrameworkExternalSeedAuthority(rekeyed), true, `${label}: re-keyed (fails on main)`);
  }
  assert.equal(
    hasConcernFrameworkExternalSeedAuthority(SHOPIFY_ROW),
    false,
    'a connected shopify row must not gain seed authority',
  );
  // The runtime retrieval_source leg is untouched, including for rows that
  // carry no lane fields at all.
  assert.equal(
    hasConcernFrameworkExternalSeedAuthority({ retrieval_source: 'external_seed' }),
    true,
  );
  assert.equal(
    hasConcernFrameworkExternalSeedAuthority({ retrievalSource: 'external_seed' }),
    true,
  );
  assert.equal(
    hasConcernFrameworkExternalSeedAuthority({ retrieval_source: 'catalog_products', merchant_id: 'merch_x' }),
    false,
  );
  assert.equal(hasConcernFrameworkExternalSeedAuthority(null), false);
});

// ---------------------------------------------------------------------------
// 5. guidanceFastpath ordering — seed-lane products sort AFTER merchant-synced
//    ones. A re-keyed row read as merchant-synced would float above real
//    connected inventory.
// ---------------------------------------------------------------------------

function buildGuidanceSorter() {
  const { createGuidanceFastpathRuntime } = require('../src/modules/decisioning/shopping_agent/guidanceFastpath');
  return createGuidanceFastpathRuntime({
    normalizeSearchHintToken: (v) => String(v || '').trim().toLowerCase(),
    extractSearchAnchorTokens: () => [],
    normalizeSearchTextForMatch: (v) => String(v || '').trim().toLowerCase(),
    // Flat classification and no anchor hits, so the seed/non-seed tiebreak is
    // the ONLY thing deciding order.
    classifyGuidanceTargetRelevance: () => 'generic_family',
    buildSearchDecisionProductKey: (p) => String(p?.source_product_id || p?.product_id || ''),
    classifySharedBeautyCoarseCandidate: () => null,
    withStageBudget: async (_n, fn) => fn(),
  }).sortGuidanceFastpathProducts;
}

test('guidanceFastpath: re-keyed seed rows sort behind merchant-synced rows, like the sentinel', () => {
  const sort = buildGuidanceSorter();
  // The title is chosen to sort AFTER the shopify row under the final
  // reverse-localeCompare fallback. So if the seed/non-seed tiebreak does not
  // fire, the seed row floats to the FRONT and the assertion fails — without
  // this the test would pass on main for the wrong reason.
  const seedTitle = 'Zenith Barrier Repair Cream';
  for (const [label, sentinel, rekeyed] of SEED_PAIRS) {
    const sentinelOrder = sort([{ ...sentinel, title: seedTitle }, SHOPIFY_ROW], '', {}).map(
      (p) => p.merchant_id,
    );
    assert.deepEqual(
      sentinelOrder,
      [SHOPIFY_ROW.merchant_id, sentinel.merchant_id],
      `${label}: sentinel seed row must sort last`,
    );
    const rekeyedOrder = sort([{ ...rekeyed, title: seedTitle }, SHOPIFY_ROW], '', {}).map(
      (p) => p.merchant_id,
    );
    assert.deepEqual(
      rekeyedOrder,
      [SHOPIFY_ROW.merchant_id, rekeyed.merchant_id],
      `${label}: re-keyed seed row must sort last too (fails on main)`,
    );
  }
});

test('guidanceFastpath: two merchant-synced rows keep their old title-order tiebreak', () => {
  const sort = buildGuidanceSorter();
  const a = { merchant_id: 'merch_shopify_aaa', platform: 'shopify', title: 'Alpha', source_product_id: '1' };
  const b = { merchant_id: 'merch_shopify_bbb', platform: 'shopify', title: 'Beta', source_product_id: '2' };
  const order = sort([a, b], '', {}).map((p) => p.title);
  // Neither is seed-lane, so the tiebreak falls through to the pre-existing
  // reverse-localeCompare on title — unchanged by this migration.
  assert.deepEqual(order, ['Beta', 'Alpha']);
});

// --- prototype pollution cannot mark a row seed-lane (review nit 2) -----------------------------
test('a polluted Object.prototype cannot route a clean merchant row into the seed lane', () => {
  // `source_system` is now load-bearing for BOTH the candidate stamp and the price join, so a
  // polluted prototype would otherwise mark EVERY catalog row as seed-lane. The real gate
  // (testMerchantPolicy) is SQL-side and unreachable from JS, so this is defence in depth — but the
  // blast radius grew when source_system became projected, which is why it is pinned.
  const polluted = ['source_system', 'merchant_id', 'platform', 'product_data'];
  for (const key of polluted) {
    const value = key === 'product_data'
      ? { platform: 'external_seed' }
      : (key === 'source_system' ? 'catalog_enrichment_agent_v1' : 'external_seed');
    Object.prototype[key] = value; // eslint-disable-line no-extend-native
    try {
      assert.equal(
        isExternalSeedLaneProduct({ merchant_id: 'merch_shopify_1', platform: 'shopify' }),
        false,
        `Object.prototype.${key} must not make a shopify row seed-lane`,
      );
      // ...and a genuine seed row is still detected while the prototype is dirty.
      assert.equal(
        isExternalSeedLaneProduct({
          merchant_id: 'merch_obs_abc', platform: '', source_system: 'catalog_enrichment_agent_v1',
        }),
        true,
        'a real seed row must still be detected',
      );
    } finally {
      delete Object.prototype[key]; // eslint-disable-line no-extend-native
    }
  }
});

test('a LEGITIMATE prototype still reads — the pollution guard must not narrow inheritance', () => {
  // The first cut of the guard was a bare Object.hasOwn, which also dropped fields defined on a real
  // prototype: a class instance with getters, or an Object.create(base) row, would read as INTERNAL —
  // the exact inversion this module exists to prevent. Pollution lives on Object.prototype
  // specifically, so only that is excluded.
  class SeedRow {
    get merchant_id() { return 'external_seed'; }
  }
  assert.equal(isExternalSeedLaneProduct(new SeedRow()), true, 'class-instance getter must be read');
  assert.equal(
    isExternalSeedLaneProduct(Object.create({ platform: 'external_seed' })), true,
    'Object.create(base) must be read',
  );
  // ...and a legitimate prototype carrying a NON-seed value is still not seed-lane.
  assert.equal(
    isExternalSeedLaneProduct(Object.create({ merchant_id: 'merch_shopify_1', platform: 'shopify' })),
    false,
    'inheritance must not manufacture a seed row',
  );
});

// ---------------------------------------------------------------------------
// 6. auroraBff/routes.js — the residual merchant_id literals PR #1914 left.
//
// Four of these gate the EXTERNAL-SEED EVIDENCE CHAIN:
//
//   caller gate -> loadExternalSeedEvidenceProduct -> extractExternalSeedSnapshotEvidence
//
// and the chain is only as migrated as its narrowest link. The two INNER gates
// (the load function's own `merchantId !== EXTERNAL_SEED_MERCHANT_ID`, and the
// snapshot extractor's) are the reason migrating the call sites alone would
// have accomplished nothing: a re-keyed row would have been waved through the
// call site and then dropped one frame later, silently, with no evidence
// loaded and no error raised.
// ---------------------------------------------------------------------------

function routesInternal() {
  return require('../src/auroraBff/routes').__internal;
}

// A full serving-shaped product: the row's own lane fields (which survive the
// re-key) PLUS the nested canonical_product_ref the four sites also read.
function anchorProductFor(row) {
  return {
    product_id: row.source_product_id,
    merchant_id: row.merchant_id,
    platform: row.platform,
    source_system: row.source_system,
    display_name: row.title,
    canonical_product_ref: { product_id: row.source_product_id, merchant_id: row.merchant_id },
  };
}

test('routes: nested canonical_product_ref reader — sentinel/re-keyed parity', () => {
  const { isExternalSeedLaneProductOrCanonicalRef } = routesInternal();
  for (const [label, sentinel, rekeyed] of SEED_PAIRS) {
    assert.equal(isExternalSeedLaneProductOrCanonicalRef(anchorProductFor(sentinel)), true, `${label}: sentinel`);
    assert.equal(
      isExternalSeedLaneProductOrCanonicalRef(anchorProductFor(rekeyed)),
      true,
      `${label}: re-keyed merch_obs_ anchor (fails on main)`,
    );
  }

  // The legacy leg this replaces: seed evidence ONLY on the nested ref, nothing
  // on the row. Must keep matching for as long as sentinel rows exist.
  assert.equal(
    isExternalSeedLaneProductOrCanonicalRef({
      merchant_id: 'merch_shopify_9a8b7c6d5e4f3021',
      canonical_product_ref: { product_id: 'p1', merchant_id: 'external_seed' },
    }),
    true,
    'sentinel on the nested ref alone must still admit',
  );
  assert.equal(
    isExternalSeedLaneProductOrCanonicalRef({
      canonicalProductRef: { product_id: 'p1', merchant_id: 'external_seed' },
    }),
    true,
    'camelCase nested ref — unified with isExternalRecoAlternativesSeedProduct, which already read it',
  );

  // No over-broadening.
  assert.equal(isExternalSeedLaneProductOrCanonicalRef(anchorProductFor(SHOPIFY_ROW)), false);
  assert.equal(isExternalSeedLaneProductOrCanonicalRef(null), false);
  assert.equal(isExternalSeedLaneProductOrCanonicalRef('external_seed'), false);
  assert.equal(isExternalSeedLaneProductOrCanonicalRef({ canonical_product_ref: 'external_seed' }), false);

  // PINNED LIMIT, not an oversight: a canonical ref carries only
  // {product_id, merchant_id} by contract (src/server.js:23913), so a re-keyed
  // row whose ONLY seed evidence is the nested ref has no durable discriminator
  // left and reads as non-seed. Nothing in the gateway can recover that; it is
  // the same shape of gap documented on summarizeResolverAuthoritySource.
  assert.equal(
    isExternalSeedLaneProductOrCanonicalRef({
      canonical_product_ref: { product_id: 'p1', merchant_id: OBSERVED_SELLER_ID },
    }),
    false,
    'a bare re-keyed ref is undecidable — asserted so the limit cannot rot silently',
  );
});

test('routes: loadExternalSeedEvidenceProduct GATE admits re-keyed rows (the inner gate)', async () => {
  const { loadExternalSeedEvidenceProduct } = routesInternal();
  const dbModule = require('../src/db');
  const priorQuery = dbModule.query;
  const attempts = [];
  dbModule.query = async (sql, params) => {
    attempts.push({ sql: String(sql || ''), params });
    return { rows: [] };
  };
  try {
    for (const [label, sentinel, rekeyed] of SEED_PAIRS) {
      attempts.length = 0;
      await loadExternalSeedEvidenceProduct(anchorProductFor(sentinel));
      assert.equal(attempts.length, 1, `${label}: sentinel must reach the seed lookup`);
      assert.match(attempts[0].sql, /external_product_seeds/, `${label}: sentinel queries the seed table`);
      assert.deepEqual(attempts[0].params, [sentinel.source_product_id]);

      attempts.length = 0;
      await loadExternalSeedEvidenceProduct(anchorProductFor(rekeyed));
      assert.equal(
        attempts.length,
        1,
        `${label}: re-keyed row must reach the SAME seed lookup (fails on main — main returns null before querying)`,
      );
      assert.deepEqual(attempts[0].params, [rekeyed.source_product_id]);
    }

    // No over-broadening: a connected shopify row must never trigger a seed read.
    attempts.length = 0;
    assert.equal(await loadExternalSeedEvidenceProduct(anchorProductFor(SHOPIFY_ROW)), null);
    assert.equal(attempts.length, 0, 'shopify row must not query external_product_seeds');

    // Pre-existing non-lane guards untouched.
    attempts.length = 0;
    assert.equal(await loadExternalSeedEvidenceProduct(null), null);
    assert.equal(await loadExternalSeedEvidenceProduct({ merchant_id: 'external_seed' }), null, 'no product id -> no read');
    assert.equal(attempts.length, 0);
  } finally {
    dbModule.query = priorQuery;
  }
});

test('routes: extractExternalSeedSnapshotEvidence — sentinel/re-keyed parity', () => {
  const { extractExternalSeedSnapshotEvidence } = routesInternal();
  const withSnapshot = (row) => ({
    ...anchorProductFor(row),
    inci_list: ['Water', 'Glycerin', 'Niacinamide', 'Squalane', 'Ceramide NP'],
    source_page_type: 'official_product',
    content_quality: 'high',
    source_url: 'https://example.test/products/x',
  });
  for (const [label, sentinel, rekeyed] of SEED_PAIRS) {
    const fromSentinel = extractExternalSeedSnapshotEvidence(withSnapshot(sentinel));
    const fromRekeyed = extractExternalSeedSnapshotEvidence(withSnapshot(rekeyed));
    assert.equal(fromSentinel?.ok, true, `${label}: sentinel yields evidence`);
    assert.deepEqual(
      fromRekeyed,
      fromSentinel,
      `${label}: re-keyed row must yield IDENTICAL evidence (fails on main — main returns null)`,
    );
  }
  assert.equal(extractExternalSeedSnapshotEvidence(withSnapshot(SHOPIFY_ROW)), null, 'shopify row yields no seed evidence');
  assert.equal(extractExternalSeedSnapshotEvidence(null), null);
  // The pre-existing ingredient guard is untouched: lane membership alone is not evidence.
  assert.equal(extractExternalSeedSnapshotEvidence(anchorProductFor(MIRROR_SENTINEL)), null);
});

test('routes: isExternalRecoAlternativesSeedProduct — catalog-sourced re-keyed row stays external', () => {
  const { isExternalRecoAlternativesSeedProduct } = routesInternal();
  // The exact shape that flips at phase 3: sourced from catalog_products, a
  // canonical NAME SLUG id (no `ext_` rescue), and no external pdp_open path —
  // so after the re-key the merchant leg is the ONLY thing left holding it in.
  const catalogSourced = (row) => ({
    ...anchorProductFor(row),
    retrieval_source: 'catalog_products',
    pdp_open: { path: 'internal' },
    metadata: { match_state: 'catalog_exact' },
  });
  for (const [label, sentinel, rekeyed] of SEED_PAIRS) {
    assert.equal(isExternalRecoAlternativesSeedProduct(catalogSourced(sentinel)), true, `${label}: sentinel`);
    assert.equal(
      isExternalRecoAlternativesSeedProduct(catalogSourced(rekeyed)),
      true,
      `${label}: re-keyed row must stay in the external-alternatives lane (fails on main)`,
    );
  }
  assert.equal(
    isExternalRecoAlternativesSeedProduct(catalogSourced(SHOPIFY_ROW)),
    false,
    'a connected shopify row must not enter the external lane',
  );

  // Every pre-existing NON-merchant leg is preserved verbatim.
  assert.equal(isExternalRecoAlternativesSeedProduct({ metadata: { match_state: 'llm_seed' } }), true);
  assert.equal(isExternalRecoAlternativesSeedProduct({ metadata: { matchState: 'llm_seed' } }), true);
  assert.equal(isExternalRecoAlternativesSeedProduct({ pdp_open: { path: 'external' } }), true);
  assert.equal(isExternalRecoAlternativesSeedProduct({ pdpOpen: { path: 'external' } }), true);
  assert.equal(isExternalRecoAlternativesSeedProduct({ retrieval_source: 'external_seed' }), true);
  assert.equal(isExternalRecoAlternativesSeedProduct({ source: 'external_seed' }), true);
  assert.equal(isExternalRecoAlternativesSeedProduct({ product_id: 'ext_abc123' }), true);
  assert.equal(isExternalRecoAlternativesSeedProduct({ canonicalProductRef: { merchantId: 'external_seed' } }), true);
  assert.equal(isExternalRecoAlternativesSeedProduct({}), false);
  assert.equal(isExternalRecoAlternativesSeedProduct(null), false);

  // The nested `sku` leg: the adapter is row-shaped, so it is asked separately.
  assert.equal(isExternalRecoAlternativesSeedProduct({ sku: { merchant_id: 'external_seed' } }), true);
  assert.equal(
    isExternalRecoAlternativesSeedProduct({ sku: { merchant_id: OBSERVED_SELLER_ID, source_system: 'catalog_enrichment_agent_v1' } }),
    true,
    're-keyed nested sku (fails on main)',
  );
  assert.equal(isExternalRecoAlternativesSeedProduct({ sku: { merchant_id: 'merch_shopify_1', platform: 'shopify' } }), false);
});

test('routes: classifyRecoAuthorityHitSource — re-keyed rows are still external_seed_hit', () => {
  const { classifyRecoAuthorityHitSource } = routesInternal();
  for (const [label, sentinel, rekeyed] of SEED_PAIRS) {
    assert.equal(classifyRecoAuthorityHitSource(anchorProductFor(sentinel)), 'external_seed_hit', `${label}: sentinel`);
    assert.equal(
      classifyRecoAuthorityHitSource(anchorProductFor(rekeyed)),
      'external_seed_hit',
      `${label}: re-keyed row must keep its authority class (fails on main — main says internal_hit)`,
    );
  }
  assert.equal(classifyRecoAuthorityHitSource(anchorProductFor(SHOPIFY_ROW)), 'internal_hit');
  // Pre-existing legs untouched, including the ones that read the NORMALIZED
  // projection rather than the raw row.
  assert.equal(classifyRecoAuthorityHitSource({ product_id: 'p1', retrieval_source: 'external_seed' }), 'external_seed_hit');
  assert.equal(classifyRecoAuthorityHitSource({ product_id: 'p1', source: 'external_catalog' }), 'external_seed_hit');
  assert.equal(classifyRecoAuthorityHitSource({ product_id: 'p1', merchant: { merchant_id: 'external_seed' } }), 'external_seed_hit');
  assert.equal(classifyRecoAuthorityHitSource({ product_id: 'p1', merchant_id: 'merch_shopify_1' }), 'internal_hit');
  assert.equal(classifyRecoAuthorityHitSource(null), '', 'unresolvable candidate keeps its empty class');
});

test('routes.js carries no behavioural merchant_id literal left except the pinned residual', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'auroraBff', 'routes.js'), 'utf8');
  // Match the constant AND the raw string, but ONLY where the line also mentions a merchant —
  // that is the defect class (a merchant_id compared to the sentinel). The bare string is used
  // legitimately all over this file as a SOURCE LABEL (`source: 'external_seed'`, token classifiers),
  // and flagging those would make the guard noise that gets muted. A reviewer showed a constant-only
  // grep misses `String(row?.merchant_id||'').trim() === 'external_seed'`, and that counting alone is
  // insufficient (migrating the residual while adding a literal keeps the count) — so pin LINE CONTENT.
  const hits = source
    .split('\n')
    .map((line, index) => [index + 1, line.trim()])
    .filter(([, line]) => !line.startsWith('//'))
    .filter(([, line]) => (
      line.includes('EXTERNAL_SEED_MERCHANT_ID')
      || (/'external_seed'|"external_seed"/.test(line) && /merchant/i.test(line))
    ));
  const EXPECTED = [
    // the import
    'EXTERNAL_SEED_MERCHANT_ID,',
    // Dead inline fallback for productGroundingResolverInternals.isExternalProduct — the real export
    // IS a function, so this branch never runs. Not a live reader; left as-is.
    "return merchantId === 'external_seed' || source.includes('external_seed');",
    // The pinned, documented residual: telemetry label only, never a serving/eligibility gate
    // (summarizeResolverAuthoritySource -> authority_presence_class / catalog_grounding_resolver_source).
    "String(canonicalRef?.merchant_id || '').trim().toLowerCase() === String(EXTERNAL_SEED_MERCHANT_ID || '').trim().toLowerCase()",
    // A SEARCH FILTER sent to the backend (backendExternalSeedAuthoritySearchFn), not a read of a
    // local row. Migrating it is a cross-repo contract change with its own PR — but it DOES stop
    // matching after the phase-3 re-key, so it is a phase-3 prerequisite, pinned here so it cannot
    // be forgotten or quietly deleted.
    "merchantId: 'external_seed',",
  ];
  assert.deepEqual(
    hits.map(([, line]) => line).sort(),
    [...EXPECTED].sort(),
    `unexpected merchant-keyed external_seed literals in routes.js: ${JSON.stringify(hits, null, 2)}`,
  );
});
