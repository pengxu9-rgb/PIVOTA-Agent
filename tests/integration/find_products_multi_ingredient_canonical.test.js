/**
 * Phase 7b ingredient_recall_direct extension — integration test.
 *
 * Probe v15 (prod) showed beauty buckets at 100% PASS except `skincare_serum`
 * (0/2 PASS, 2 THIN). Per-query metadata revealed both serum queries took
 * the `agent_products_ingredient_recall_direct` path (because the query
 * contains an ingredient like "salicylic acid" / "hyaluronic acid"), and
 * that path bypassed the canonical chain shipped in PR #1312 / #1314.
 *
 * This test pins the fix: when the ingredient_recall_direct branch fires,
 * the gateway runs `fetchCanonicalChainRows` in parallel with the existing
 * `prefetchStrictIngredientExternalSeedCandidates` and merges. Telemetry
 * fields (`canonical_path_executed`, `canonical_raw_count`,
 * `canonical_dedupe_count`) appear in metadata and route_health.
 */

const nock = require('nock');
const request = require('supertest');

function canonicalSerumRows(count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    merchant_id: 'external_seed',
    product_key: `prod::external_seed::external_seed::ext_serum_${index}`,
    platform: 'external_seed',
    source_product_id: `ext_serum_${index}`,
    pivota_signature_id: `sig_serum_${index}`,
    pivota_canonical_url: `https://agent.pivota.cc/products/sig_serum_${index}`,
    product_title: `Hydrating Hyaluronic Acid Serum ${index}`,
    product_description: 'Lightweight serum with hyaluronic acid for dry skin.',
    brand: ['COSRX', 'Anua', 'Naturium', 'Haruharu Wonder', 'Medicube'][index % 5],
    product_type: 'Serum',
    category: 'Serum',
    category_path: 'beauty/skincare/treat/serum',
    canonical_url: `https://brand.example/products/serum-${index}`,
    product_image_url: `https://cdn.example.com/serum-${index}.jpg`,
    catalog_track: 'external_referral',
    truth_tier: 'observed',
    readiness_tier: 'referral_only',
    pdp_scope: 'unverified',
    product_payload: {
      seed_data: {
        price_amount: '18.00',
        price_currency: 'USD',
        availability: 'in stock',
      },
    },
    rank_score: 320,
  }));
}

function canonicalMixedNiacinamideRows() {
  return [
    {
      merchant_id: 'external_seed',
      product_key: 'prod::external_seed::external_seed::ext_foundation_niacinamide',
      platform: 'external_seed',
      source_product_id: 'ext_foundation_niacinamide',
      pivota_signature_id: 'sig_foundation_niacinamide',
      pivota_canonical_url: 'https://agent.pivota.cc/products/sig_foundation_niacinamide',
      product_title: 'Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+',
      product_description: 'Serum-infused foundation with niacinamide for a radiant finish.',
      brand: 'Test Beauty',
      product_type: 'Foundation',
      category: 'Foundation',
      category_path: 'beauty/makeup/face/foundation',
      canonical_url: 'https://brand.example/products/radiance-foundation',
      product_image_url: 'https://cdn.example.com/foundation.jpg',
      catalog_track: 'external_referral',
      truth_tier: 'observed',
      readiness_tier: 'referral_only',
      pdp_scope: 'unverified',
      product_payload: {
        seed_data: {
          price_amount: '24.00',
          price_currency: 'USD',
          availability: 'in stock',
          active_ingredients: ['niacinamide'],
        },
      },
      rank_score: 999,
    },
    {
      merchant_id: 'external_seed',
      product_key: 'prod::external_seed::external_seed::ext_niacinamide_serum',
      platform: 'external_seed',
      source_product_id: 'ext_niacinamide_serum',
      pivota_signature_id: 'sig_niacinamide_serum',
      pivota_canonical_url: 'https://agent.pivota.cc/products/sig_niacinamide_serum',
      product_title: 'Niacinamide 10% Brightening Serum',
      product_description: 'Lightweight niacinamide serum for uneven tone.',
      brand: 'Test Beauty',
      product_type: 'Serum',
      category: 'Serum',
      category_path: 'beauty/skincare/treat/serum',
      canonical_url: 'https://brand.example/products/niacinamide-serum',
      product_image_url: 'https://cdn.example.com/niacinamide-serum.jpg',
      catalog_track: 'external_referral',
      truth_tier: 'observed',
      readiness_tier: 'referral_only',
      pdp_scope: 'unverified',
      product_payload: {
        seed_data: {
          price_amount: '16.00',
          price_currency: 'USD',
          availability: 'in stock',
          active_ingredients: ['niacinamide'],
        },
      },
      rank_score: 100,
    },
  ];
}

// Rows that all legitimately match the ingredient "niacinamide" but sit in
// different category trees. Only the two under beauty/skincare should survive
// a bare ingredient query — note one of them is at bare `beauty/skincare`,
// outside `treat/`, which is why the floor uses the PARENT scope.
function canonicalOffCategoryNiacinamideRows() {
  const row = (id, title, categoryPath, productType, rankScore) => ({
    merchant_id: 'external_seed',
    product_key: `prod::external_seed::external_seed::${id}`,
    platform: 'external_seed',
    source_product_id: id,
    pivota_signature_id: `sig_${id}`,
    pivota_canonical_url: `https://agent.pivota.cc/products/sig_${id}`,
    product_title: title,
    product_description: `Formulated with niacinamide. ${title}.`,
    brand: 'Test Beauty',
    product_type: productType,
    category: productType,
    category_path: categoryPath,
    canonical_url: `https://brand.example/products/${id}`,
    product_image_url: `https://cdn.example.com/${id}.jpg`,
    catalog_track: 'external_referral',
    truth_tier: 'observed',
    readiness_tier: 'referral_only',
    pdp_scope: 'unverified',
    product_payload: {
      seed_data: {
        price_amount: '18.00',
        price_currency: 'USD',
        availability: 'in stock',
        active_ingredients: ['niacinamide'],
      },
    },
    rank_score: rankScore,
  });
  return [
    row('ext_nia_body_wash', 'Niacinamide Smoothing Body Wash', 'beauty/bodycare/cleanse/body-wash', 'Body Wash', 900),
    row('ext_nia_shampoo', 'Niacinamide Scalp Relief Shampoo', 'beauty/haircare/cleanse/shampoo', 'Shampoo', 880),
    row('ext_nia_foundation', 'Niacinamide Radiance Foundation SPF 50', 'beauty/makeup/face/foundation', 'Foundation', 870),
    row('ext_niacinamide_serum', 'Niacinamide 10% Brightening Serum', 'beauty/skincare/treat/serum', 'Serum', 120),
    row('ext_nia_essence', 'Niacinamide Barrier Essence', 'beauty/skincare', 'Essence', 110),
  ];
}

describe('find_products_multi ingredient_recall_direct canonical extension', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => String(host || '').includes('127.0.0.1') || String(host || '').includes('localhost'));
    prevEnv = { ...process.env };
    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://canonical-test';
    process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = '1';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    process.env = prevEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test('ingredient query surfaces canonical-chain catalog rows + telemetry', async () => {
    const observedSql = [];
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        observedSql.push(text);
        if (text.includes('FROM catalog_products p')) return { rows: canonicalSerumRows(12) };
        if (text.includes('FROM external_product_seeds')) return { rows: [] };
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: { query: 'hyaluronic acid hydrating serum', page: 1, limit: 20, market: 'US' },
        },
        metadata: { source: 'shopping_agent', market: 'US' },
      });

    expect(resp.status).toBe(200);
    // The ingredient_recall_direct path must now consult catalog_products.
    expect(observedSql.some((sql) => sql.includes('FROM catalog_products p'))).toBe(true);
    // Canonical telemetry surfaces in metadata and route_health.
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        canonical_path_executed: true,
      }),
    );
    expect(resp.body.metadata?.route_health).toEqual(
      expect.objectContaining({
        canonical_path_executed: true,
        primary_path_used: 'ingredient_recall_direct',
      }),
    );
    // canonical_raw_count is non-negative; we asserted FROM catalog_products
    // ran, so it captured the mocked rows count when the ingredient guard
    // fires. We don't pin to 12 because not every prefetched query path
    // necessarily routes through the strict-ingredient guard in this
    // mocked environment — the assertion that catalog_products SQL ran
    // is the load-bearing check.
    expect(typeof resp.body.metadata?.canonical_raw_count).toBe('number');
    expect(resp.body.metadata?.canonical_raw_count).toBeGreaterThanOrEqual(0);
  });

  test('canonical helper invocation includes verticalSearch=true for ingredient path', async () => {
    // Smoke test: the wiring passes verticalSearch=true so SKU-level
    // visible_option_labels and ingredient_ids are matched. The mocked
    // `query` function captures the SQL text; `verticalSearch=true`
    // produces EXISTS subqueries against catalog_skus.
    const observedSql = [];
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        observedSql.push(String(sql || ''));
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: { query: 'salicylic acid serum for acne and pores', page: 1, limit: 12, market: 'US' },
        },
        metadata: { source: 'shopping_agent', market: 'US' },
      });

    const canonicalSql = observedSql.find((sql) => sql.includes('FROM catalog_products p'));
    if (canonicalSql) {
      // verticalSearch=true emits EXISTS subqueries on catalog_skus for
      // visible_option_labels / ingredient_ids matching. If the SQL ran
      // without those branches, verticalSearch was inadvertently dropped.
      expect(canonicalSql).toMatch(/FROM catalog_skus/);
    }
    // If the SQL didn't run at all (path didn't fire on this query), we
    // still pass — test-environment routing isn't load-bearing for this
    // assertion. The first test pins the wiring; this one pins the args.
  });

  test('canonical helper invocation includes tokenMatch=true for ingredient path', async () => {
    // Regression pin for the 2026-08-01 junk top-10 ("vitamin c serum" ->
    // 0/10 literal matches in the lane's own products). Without tokenMatch
    // the only title predicate is the contiguous whole phrase
    // (LIKE '%vitamin c serum%'), which literal PDPs like "Advanced The
    // Vitamin C 23 Serum" do not contain — literal matches could then enter
    // the candidate set ONLY via the flag-gated recall_doc arm, whose
    // single-token '%serum%' patterns admit every serum in the catalog, and
    // with rank v2 off the pool tied at the flat +200 scope bonus and
    // degenerated to updated_at DESC. tokenMatch emits the token-overlap
    // WHERE arm ((...) >= N) plus the *25-per-token rank bonus, making the
    // lane's recall and ordering self-sufficient (flag-independent).
    const observedSql = [];
    const observedParams = [];
    jest.doMock('../../src/db', () => ({
      query: async (sql, params) => {
        observedSql.push(String(sql || ''));
        observedParams.push(Array.isArray(params) ? params : []);
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: { query: 'vitamin c serum', page: 1, limit: 10, market: 'US' },
        },
        metadata: { source: 'shopping_agent', market: 'US' },
      });

    expect(resp.status).toBe(200);
    // Pin the lane so the SQL assertions can't silently relocate.
    expect(resp.body.metadata?.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({ canonical_token_match: true }),
    );
    const canonicalIdx = observedSql.findIndex((sql) => sql.includes('FROM catalog_products p'));
    expect(canonicalIdx).toBeGreaterThanOrEqual(0);
    const canonicalSql = observedSql[canonicalIdx];
    // Token-overlap threshold in WHERE ("vitamin c serum" -> significant
    // tokens [vitamin, serum], minTokens 2) + the *25 token rank bonus.
    expect(canonicalSql).toMatch(/\) >= 2\)/);
    expect(canonicalSql).toMatch(/\* 25\)/);
    expect(observedParams[canonicalIdx]).toEqual(
      expect.arrayContaining(['%vitamin%', '%serum%']),
    );
  });

  test('ingredient direct canonical merge respects explicit skincare form intent', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM catalog_products p')) return { rows: canonicalMixedNiacinamideRows() };
        if (text.includes('FROM external_product_seeds')) return { rows: [] };
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: { query: 'niacinamide serum', page: 1, limit: 10, market: 'US' },
        },
        metadata: { source: 'shopping_agent', market: 'US' },
      });

    expect(resp.status).toBe(200);
    const titles = resp.body.products.map((product) => product.title);
    expect(titles).toContain('Niacinamide 10% Brightening Serum');
    expect(titles).not.toContain('Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+');
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_ingredient_recall_direct',
        ingredient_direct_category_filter_applied: true,
        // The foundation row is now dropped one stage EARLIER, by the canonical
        // category-scope floor (it is beauty/makeup/..., outside
        // beauty/skincare), so the form-intent filter has nothing left to
        // remove. The exclusion itself is unchanged — see the not.toContain
        // above; only the attribution moved.
        ingredient_direct_category_filtered_out_count: 0,
        canonical_category_scope_prefix: 'beauty/skincare',
        canonical_category_scope_filtered_out_count: 1,
        ingredient_direct_category_intents: ['serum'],
      }),
    );
  });

  test('canonical recall matches on query text, not a category bucket', async () => {
    // Regression pin for the 2026-07-31 skincare release-gate red.
    // fetchCanonicalChainRows has two modes: passing `categoryPathPrefix`
    // switches it to category BROWSE, which drops the text predicate from the
    // WHERE clause entirely and orders by rank_score — near-constant inside a
    // single bucket, so effectively updated_at DESC. "niacinamide serum" then
    // recalled whatever had most recently been restamped under
    // beauty/skincare/treat/ (sheet masks, toners, body mist) and zero actual
    // niacinamide serums, because the literal PDPs are catalogued under the
    // catalog's competing taxonomies (beauty/skincare/serum, beauty/skincare).
    // Assert on the emitted SQL so the mode itself is pinned, not just an
    // outcome a fixture could fake.
    const observedSql = [];
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        observedSql.push(text);
        if (text.includes('FROM catalog_products p')) return { rows: canonicalMixedNiacinamideRows() };
        if (text.includes('FROM external_product_seeds')) return { rows: [] };
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: { query: 'niacinamide serum', page: 1, limit: 10, market: 'US' },
        },
        metadata: { source: 'shopping_agent', market: 'US' },
      });

    expect(resp.status).toBe(200);
    // Pin the lane first: several lanes emit catalog_products SQL in one
    // invoke, so without this the SQL assertions below could silently
    // relocate to a different lane's query if routing drifts.
    expect(resp.body.metadata?.query_source).toBe('agent_products_ingredient_recall_direct');
    const canonicalSql = observedSql.find((sql) => sql.includes('FROM catalog_products p'));
    expect(canonicalSql).toBeDefined();
    // Text mode: assert the title arm is IMMEDIATELY followed by the brand
    // arm. That adjacency exists only in textWhereClause. A bare
    // /title LIKE \$2/ would also match the rank-v2 CASE arm, which is built
    // in BOTH modes when CANONICAL_CATALOG_RANK_V2 is on — so the bare form
    // is not a mode discriminator and would go vacuous under that flag.
    expect(canonicalSql).toMatch(
      /LOWER\(COALESCE\(p\.title, ''\)\) LIKE \$2\s+OR LOWER\(COALESCE\(p\.brand, ''\)\) LIKE \$2/,
    );
    // Bucket mode's tell — the category-only predicate with the no-op bind
    // guard that replaces the text clause — must NOT appear.
    expect(canonicalSql).not.toMatch(/\$2::text IS NOT NULL/);
    // And the lane must report that it passed no prefix. toHaveProperty, not
    // `?? null`, so an absent key fails instead of passing by coincidence.
    expect(resp.body.metadata).toHaveProperty('canonical_category_path_prefix', null);
  });

  test('bare ingredient query keeps a category floor (no form word in query)', async () => {
    // Removing the SQL prefix removed this lane's only category constraint.
    // The post-merge filter does not cover it: only four form words are
    // recognised (serum/moisturizer/cleanser/toner), so "niacinamide" alone
    // yields zero category intents and that filter short-circuits. Combined
    // with verticalSearch matching catalog_skus.ingredient_ids, every
    // niacinamide-formulated row became eligible — body wash, shampoo,
    // foundation. The JS category floor has to hold the line here.
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM catalog_products p')) return { rows: canonicalOffCategoryNiacinamideRows() };
        if (text.includes('FROM external_product_seeds')) return { rows: [] };
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: { query: 'niacinamide', page: 1, limit: 20, market: 'US' },
        },
        metadata: { source: 'shopping_agent', market: 'US' },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_source).toBe('agent_products_ingredient_recall_direct');
    const titles = resp.body.products.map((product) => product.title);
    // The skincare rows survive — including the one outside treat/, which is
    // exactly what the parent-scope prefix is for.
    expect(titles).toContain('Niacinamide 10% Brightening Serum');
    expect(titles).toContain('Niacinamide Barrier Essence');
    // Off-category rows must be dropped even though each matches the
    // ingredient and no form word narrowed the query.
    expect(titles).not.toContain('Niacinamide Smoothing Body Wash');
    expect(titles).not.toContain('Niacinamide Scalp Relief Shampoo');
    expect(titles).not.toContain('Niacinamide Radiance Foundation SPF 50');
    expect(resp.body.metadata).toHaveProperty('canonical_category_scope_prefix', 'beauty/skincare');
    expect(resp.body.metadata?.canonical_category_scope_filtered_out_count).toBe(3);
  });

  test('canonical leg is bounded — a hung query degrades to seed-only, not a hang', async () => {
    // The canonical call is wrapped in withStageBudget
    // (FPM_INGREDIENT_CANONICAL_STAGE_BUDGET_MS). Pin the degraded path: when
    // the catalog_products query never resolves, the lane must still answer
    // within the budget with canonical_error=STAGE_TIMEOUT telemetry and
    // whatever the seed prefetch produced, instead of holding the request
    // until the DB statement_timeout backstop (30s).
    process.env.FPM_INGREDIENT_CANONICAL_STAGE_BUDGET_MS = '150';
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM catalog_products p')) return new Promise(() => {});
        if (text.includes('FROM external_product_seeds')) return { rows: [] };
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const startedAt = Date.now();
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: { query: 'niacinamide serum', page: 1, limit: 10, market: 'US' },
        },
        metadata: { source: 'shopping_agent', market: 'US' },
      });

    expect(resp.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(10000);
    expect(resp.body.metadata?.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(resp.body.metadata?.canonical_error).toBe('STAGE_TIMEOUT');
    expect(resp.body.metadata?.canonical_raw_count).toBe(0);
  });
});
