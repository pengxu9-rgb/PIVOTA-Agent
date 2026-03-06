const request = require('supertest');
const nock = require('nock');

describe('Aurora BFF product intelligence (structured upstream)', () => {
  jest.setTimeout(30000);

  beforeEach(() => {
    jest.resetModules();
    process.env.AURORA_BFF_USE_MOCK = 'true';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    process.env.AURORA_BFF_PRODUCT_INTEL_CATALOG_FALLBACK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'false';
    process.env.AURORA_BFF_PRODUCT_INTEL_KB_ASYNC_BACKFILL = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_ASYNC_ENRICH = 'false';
    process.env.AURORA_BFF_PRODUCT_INTEL_INCIDECODER_ENABLED = 'true';
    process.env.AURORA_RULE_RELAX_MODE = 'conservative';
    process.env.AURORA_KB_WRITE_POLICY = 'strict';
    process.env.AURORA_KB_SERVE_POLICY = 'strict';
    process.env.AURORA_PRODUCT_GUARDRAIL_MODE = 'enforce';
    process.env.AURORA_PRODUCT_STRICT_SKINCARE_FILTER = 'true';
  });

  afterEach(() => {
    delete process.env.AURORA_BFF_USE_MOCK;
    delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    delete process.env.AURORA_BFF_PRODUCT_INTEL_CATALOG_FALLBACK;
    delete process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL;
    delete process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS;
    delete process.env.AURORA_BFF_PRODUCT_INTEL_KB_ASYNC_BACKFILL;
    delete process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_ASYNC_ENRICH;
    delete process.env.AURORA_BFF_PRODUCT_INTEL_INCIDECODER_ENABLED;
    delete process.env.AURORA_RULE_RELAX_MODE;
    delete process.env.AURORA_KB_WRITE_POLICY;
    delete process.env.AURORA_KB_SERVE_POLICY;
    delete process.env.AURORA_PRODUCT_GUARDRAIL_MODE;
    delete process.env.AURORA_PRODUCT_STRICT_SKINCARE_FILTER;
    delete process.env.AURORA_BFF_PRODUCT_INTEL_INCIDECODER_TIMEOUT_MS;
    delete process.env.AURORA_BFF_PRODUCT_INTEL_INCIDECODER_MAX_CANDIDATES;
    delete process.env.AURORA_BFF_PRODUCT_INTEL_INCIDECODER_MIN_MATCH_SCORE;
    delete process.env.AURORA_BFF_URL_UNBLOCK_ENABLED;
    delete process.env.AURORA_BFF_URL_UNBLOCK_PROVIDER;
    delete process.env.AURORA_BFF_URL_UNBLOCK_ZENROWS_API_KEY;
    delete process.env.AURORA_BFF_URL_UNBLOCK_ONLY_ON_BLOCKED;
    delete process.env.AURORA_BFF_URL_UNBLOCK_TIMEOUT_MS;
    delete process.env.AURORA_BFF_PRODUCT_INTEL_RETAIL_FALLBACK_ENABLED;
    delete process.env.AURORA_BFF_PRODUCT_INTEL_RETAIL_MAX_CANDIDATES;
    delete process.env.AURORA_PRODUCT_INTEL_ESCALATION_PROVIDER;
    delete process.env.AURORA_PRODUCT_INTEL_ESCALATION_MODEL;
    delete process.env.AURORA_PRODUCT_INTEL_PROMPT_VERSION;
    delete process.env.AURORA_PRODUCT_INTEL_NARRATIVE_QUALITY_RETRY_ENABLED;
    delete process.env.AURORA_PRODUCT_INTEL_NARRATIVE_QUALITY_RETRY_MAX;
    delete process.env.AURORA_BFF_RECO_BLOCKS_TIMEOUT_CATALOG_ANN_MS;
    delete process.env.AURORA_BFF_RECO_BLOCKS_BUDGET_MS;
    delete process.env.AURORA_BFF_RECO_BLOCKS_DAG_ENABLED;
    delete process.env.AURORA_BFF_RECO_GUARD_ENABLED;
    delete process.env.AURORA_BFF_RECO_GUARD_CIRCUIT_ENABLED;
    delete process.env.AURORA_BFF_RECO_GUARD_CIRCUIT_THRESHOLD;
    delete process.env.AURORA_BFF_RECO_GUARD_CIRCUIT_COOLDOWN_MS;
    delete process.env.AURORA_BFF_RECO_GUARD_STRICT_DEFAULT_MODE;
    delete process.env.AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS;
    delete process.env.AURORA_BFF_RECO_CATALOG_SEARCH_PATHS;
    delete process.env.AURORA_BFF_RECO_CATALOG_BEAUTY_ROUTE_FIRST;
    delete process.env.AURORA_BFF_RECO_CATALOG_ENABLE_BEAUTY_PATH_FALLBACK;
    delete process.env.AURORA_BFF_RECO_CATALOG_SEARCH_SOURCE;
    delete process.env.AURORA_BFF_RECO_CATALOG_MAIN_PATH_SEARCH_SOURCE;
    delete process.env.AURORA_BFF_RECO_CATALOG_SEARCH_PREFER_CONFIGURED_BASE_URLS;
    delete process.env.AURORA_BFF_RECO_CATALOG_AURORA_SELF_PROXY_FIRST;
    delete process.env.AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED;
    delete process.env.AURORA_BFF_RECO_CATALOG_SELF_PROXY_BASE_URL;
    delete process.env.AURORA_BFF_BASE_URL;
    delete process.env.AURORA_BFF_RECO_BACKEND_BASE_URLS;
    delete process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED;
    delete process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ON_EMPTY;
    delete process.env.AURORA_BFF_RECO_CATALOG_SOURCE_EMPTY_FAIL_THRESHOLD;
    delete process.env.AURORA_BFF_RECO_CATALOG_SOURCE_EMPTY_COOLDOWN_MS;
    delete process.env.AURORA_BFF_RECO_CATALOG_SOURCE_TRANSIENT_FAIL_THRESHOLD;
    delete process.env.AURORA_BFF_RECO_CATALOG_SOURCE_TRANSIENT_COOLDOWN_MS;
    delete process.env.AURORA_BFF_RECO_CATALOG_MAIN_PATH_TIMEOUT_FLOOR_MS;
    delete process.env.AURORA_BFF_RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS;
    delete process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_RETURN_SLACK_MS;
    delete process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MIN_MAIN_QUERY_BUDGET_MS;
    delete process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MIN_QUERY_TIMEOUT_MS;
    delete process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MAIN_TIMEOUT_FLOOR_MS;
    delete process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MAIN_SEARCH_ALL_MERCHANTS;
    delete process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_QUERY_FANOUT_CAP;
    delete process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MAIN_ALLOW_EXTERNAL_SEED;
    delete process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MAIN_EXTERNAL_SEED_TIMEOUT_FLOOR_MS;
    delete process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_TIMEOUT_FLOOR_MS;
    delete process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_SYNC_ALLOW_EXTERNAL_SEED;
    delete process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_BACKFILL_ALLOW_EXTERNAL_SEED;
    delete process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_EXTERNAL_SEED_STRATEGY;
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.AURORA_DECISION_BASE_URL;
    nock.cleanAll();
  });

  test('/v1/product/parse prefers upstream structured.parse', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/parse')
      .set('X-Aurora-UID', 'uid_test_parse_1')
      .send({ text: 'Mock Parsed Product' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_parse');
    expect(card).toBeTruthy();
    if (card.payload.product) {
      expect(card.payload.product.sku_id).toBe('mock_sku_1');
    } else {
      expect(Array.isArray(card.payload.missing_info)).toBe(true);
      expect(card.payload.missing_info).toEqual(expect.arrayContaining(['anchor_soft_blocked_non_skincare']));
      expect(card.payload.anchor_trust).toEqual(
        expect.objectContaining({
          level: 'soft_blocked',
          usable_for_anchor_id: false,
        }),
      );
    }
    expect(card.payload.confidence).toBeCloseTo(0.7);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
  });

  test('/v1/product/parse returns actionable reason when fallback is disabled and upstream parse misses', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_INTEL_CATALOG_FALLBACK = 'false';
    process.env.AURORA_DECISION_BASE_URL = 'http://aurora.test';

    nock('http://aurora.test')
      .post('/api/chat')
      .reply(200, {
        schema_version: 'aurora.chat.v1',
        intent: 'product',
        answer: 'not json payload',
      });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/parse')
      .set('X-Aurora-UID', 'uid_test_parse_diag_disabled_1')
      .send({ text: 'Unknown product seed' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_parse');
    expect(card).toBeTruthy();
    expect(card.payload.product).toBeNull();
    expect(card.payload.parse_source).toBe('none');
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).toContain('upstream_missing_or_unstructured');
    expect(card.payload.missing_info).toContain('catalog_fallback_disabled');
    expect(Array.isArray(card.payload.recovery_path)).toBe(true);
  });

  test('/v1/product/parse surfaces backend-not-configured reason when fallback is enabled', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_INTEL_CATALOG_FALLBACK = 'true';
    process.env.AURORA_DECISION_BASE_URL = 'http://aurora.test';
    delete process.env.PIVOTA_BACKEND_BASE_URL;

    nock('http://aurora.test')
      .post('/api/chat')
      .reply(200, {
        schema_version: 'aurora.chat.v1',
        intent: 'product',
        answer: 'not json payload',
      });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/parse')
      .set('X-Aurora-UID', 'uid_test_parse_diag_backend_missing_1')
      .send({ text: 'Unknown product seed' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_parse');
    expect(card).toBeTruthy();
    expect(card.payload.product).toBeNull();
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).toContain('catalog_backend_not_configured');
    expect(card.payload.missing_info).toContain('pivota_backend_not_configured');
  });

  test('/v1/product/analyze maps aurora structured.analyze into normalized evidence', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_analyze_1')
      .send({ name: 'Mock Parsed Product' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(card.payload.assessment).toBeTruthy();
    expect(card.payload.assessment.verdict).toBe('Suitable');

    const ev = card.payload.evidence;
    expect(ev).toBeTruthy();
    expect(Array.isArray(ev.science.key_ingredients)).toBe(true);
    expect(ev.science.key_ingredients.map((item) => String(item || '').toLowerCase())).toContain('niacinamide');
    expect(Array.isArray(ev.social_signals.typical_positive)).toBe(true);
    expect(ev.social_signals.typical_positive).toContain('soothing');
    expect(Array.isArray(ev.expert_notes)).toBe(true);
  });

  test('catalog source health deprioritizes base after repeated transient failures', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://unstable-catalog.test';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS = 'http://unstable-catalog.test';
    process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED = 'true';
    process.env.AURORA_BFF_RECO_CATALOG_SOURCE_TRANSIENT_FAIL_THRESHOLD = '2';
    process.env.AURORA_BFF_RECO_CATALOG_SOURCE_TRANSIENT_COOLDOWN_MS = '60000';
    jest.resetModules();

    nock('http://unstable-catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(504, { status: 'error', reason_code: 'upstream_timeout' });

    const { __internal } = require('../src/auroraBff/routes');

    await __internal.searchPivotaBackendProducts({
      query: 'lab series moisturizer',
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
      timeoutMs: 1200,
      minTimeoutMs: 700,
      mode: 'main_path',
    });
    await __internal.searchPivotaBackendProducts({
      query: 'lab series moisturizer',
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
      timeoutMs: 1200,
      minTimeoutMs: 700,
      mode: 'main_path',
    });

    const snapshot = __internal.getRecoCatalogSearchSourceHealthSnapshot(Date.now());
    const unstable = snapshot.find((row) => String(row.base_url || '').includes('unstable-catalog.test'));
    expect(unstable).toBeTruthy();
    expect(unstable.consecutive_failures).toBeGreaterThanOrEqual(2);
    expect(unstable.deprioritized).toBe(true);
    expect(String(unstable.last_reason || '')).toBe('upstream_timeout');
  });

  test('URL fetch challenge detector identifies cloudflare and access denied signatures', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const cloudflare = __internal.detectBotChallengePage(
      '<html><title>Just a moment...</title><div>cf-ray</div></html>',
      403,
      { server: 'cloudflare' },
    );
    expect(cloudflare).toEqual(
      expect.objectContaining({
        is_challenge: true,
        challenge_type: 'cloudflare_challenge',
      }),
    );

    const denied = __internal.detectBotChallengePage(
      "<html><title>Access Denied</title><body>You don't have permission to access</body></html>",
      403,
      {},
    );
    expect(denied).toEqual(
      expect.objectContaining({
        is_challenge: true,
        challenge_type: 'access_denied_page',
      }),
    );
  });

  test('URL fetch chain escalates to zenrows when native attempts are blocked', async () => {
    process.env.AURORA_BFF_URL_UNBLOCK_ENABLED = 'true';
    process.env.AURORA_BFF_URL_UNBLOCK_PROVIDER = 'zenrows';
    process.env.AURORA_BFF_URL_UNBLOCK_ZENROWS_API_KEY = 'z_test_key';
    process.env.AURORA_BFF_URL_UNBLOCK_ONLY_ON_BLOCKED = 'true';
    jest.resetModules();

    nock('https://blocked.example')
      .get('/product')
      .times(2)
      .reply(403, '<html><title>Just a moment...</title><div>cf-ray</div></html>');

    nock('https://api.zenrows.com')
      .get('/v1/')
      .query((q) => String(q.url || '') === 'https://blocked.example/product' && String(q.js_render || '') === 'false')
      .reply(200, '<html><body>Ingredients: Water, Glycerin, Niacinamide, Panthenol, Sodium Hyaluronate</body></html>');

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.fetchProductHtmlWithFallback({
      productUrl: 'https://blocked.example/product',
      timeoutMs: 3200,
      allowHostVariant: false,
      logger: { debug: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    });

    expect(out.ok).toBe(true);
    expect(out.final_strategy).toBe('zenrows_http');
    expect(out.used_unblock_vendor).toBe(true);
    expect(Array.isArray(out.attempts)).toBe(true);
    expect(out.attempts.some((item) => item.provider === 'zenrows')).toBe(true);
  });

  test('URL fetch chain keeps provider metadata on native success attempts', async () => {
    process.env.AURORA_BFF_URL_UNBLOCK_ENABLED = 'true';
    jest.resetModules();

    nock('https://native-ok.example')
      .get('/product')
      .reply(200, '<html><body>Ingredients: Water, Glycerin</body></html>');

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.fetchProductHtmlWithFallback({
      productUrl: 'https://native-ok.example/product',
      timeoutMs: 2400,
      allowHostVariant: false,
      logger: { debug: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    });

    expect(out.ok).toBe(true);
    expect(Array.isArray(out.attempts)).toBe(true);
    expect(out.attempts.length).toBeGreaterThan(0);
    expect(out.attempts[0]).toEqual(expect.objectContaining({ strategy: 'axios_default', provider: 'native' }));
  });

  test('URL ingredient analysis exposes retrieval_degradation when catalog_ann transiently fails', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_RECO_BLOCKS_DAG_ENABLED = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS = 'http://catalog.test';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_SOURCE = 'shopping-agent';
    jest.resetModules();

    nock('https://probe.example')
      .get('/product')
      .reply(
        200,
        '<html><body><h1>Lab Series All-in-One Defense Lotion</h1><p>Ingredients: Water, Glycerin, Niacinamide, Panthenol.</p></body></html>',
        { 'Content-Type': 'text/html' },
      );
    nock('http://catalog.test')
      .persist()
      .get(/\/agent\/v1\/(?:beauty\/)?products\/search/)
      .query(true)
      .reply(504, { status: 'error', reason_code: 'upstream_timeout' });

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.buildProductAnalysisFromUrlIngredients({
      productUrl: 'https://probe.example/product',
      lang: 'EN',
      profileSummary: { skinType: 'oily', sensitivity: 'medium', barrierStatus: 'healthy' },
      parsedProduct: { brand: 'Lab Series', name: 'All-in-One Defense Lotion SPF 35' },
      logger: { debug: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    });

    expect(out).toBeTruthy();
    const payload = out.payload || {};
    expect(payload.provenance).toBeTruthy();
    expect(payload.provenance.retrieval_degradation).toEqual(
      expect.objectContaining({
        transient_failure_count: expect.any(Number),
        degraded: expect.any(Boolean),
      }),
    );
    expect(Array.isArray(payload.missing_info)).toBe(true);
    expect(payload.missing_info).toContain('catalog_ann_transient_failure');
  });

  test('reconcileProductAnalysisConsistency backfills retrieval_degradation contract when it is null', () => {
    const { reconcileProductAnalysisConsistency } = require('../src/auroraBff/normalize');
    const out = reconcileProductAnalysisConsistency({
      assessment: {
        verdict: 'Unknown',
        reasons: ['Evidence is limited.'],
      },
      evidence: {
        science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
        social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
        expert_notes: [],
        confidence: null,
        missing_info: [],
      },
      confidence: null,
      missing_info: [],
      provenance: {
        source: 'url_realtime_product_intel',
        url_fetch: {
          attempts: [{ strategy: 'axios_default', provider: 'native', status: 200 }],
        },
        retrieval_degradation: null,
      },
    });

    expect(out.provenance).toBeTruthy();
    expect(out.provenance.retrieval_degradation).toEqual(
      expect.objectContaining({
        transient_failure_count: 0,
        attempted_sources: [],
        resolver_first_applied: false,
        resolver_first_skipped_for_aurora: false,
        source_temporarily_deprioritized: false,
        degraded: false,
      }),
    );
  });

  test('retail supplement returns retail_page source when search and PDP extraction match', async () => {
    jest.resetModules();

    nock('https://www.sephora.com')
      .get('/search')
      .query(true)
      .reply(
        200,
        '<html><body><a href="/product/brand-peptide-serum">Brand Peptide Serum</a></body></html>',
        { 'Content-Type': 'text/html' },
      );
    nock('https://www.sephora.com')
      .get('/product/brand-peptide-serum')
      .reply(
        200,
        '<html><head><title>Brand Peptide Serum | Sephora</title></head><body><p>Ingredients: Water, Glycerin, Niacinamide, Panthenol, Sodium Hyaluronate.</p></body></html>',
        { 'Content-Type': 'text/html' },
      );

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.fetchRetailIngredientSupplement({
      parsedProduct: { brand: 'Brand', name: 'Peptide Serum' },
      productUrl: '',
      timeoutMs: 4200,
      logger: { debug: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    });

    expect(out).toEqual(expect.objectContaining({ ok: true }));
    expect(Array.isArray(out.ingredients)).toBe(true);
    expect(out.ingredients.length).toBeGreaterThanOrEqual(4);
    expect(out.source).toEqual(
      expect.objectContaining({
        type: 'retail_page',
      }),
    );
  });

  test('retail ingredient extractor and matcher produce usable supplemental signals', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const ingredients = __internal.extractRetailIngredientsFromHtml(
      '<section><h3>Ingredients</h3><p>Ingredients: Water, Glycerin, Niacinamide, Panthenol, Sodium Hyaluronate.</p></section>',
    );
    expect(Array.isArray(ingredients)).toBe(true);
    expect(ingredients.length).toBeGreaterThanOrEqual(4);
    expect(ingredients.join(' ').toLowerCase()).toContain('niacinamide');

    const highScore = __internal.scoreRetailMatch({
      descriptor: { brand: 'CeraVe', name: 'Moisturizing Cream', query: 'CeraVe Moisturizing Cream' },
      pageTitle: 'CeraVe Moisturizing Cream | Sephora',
      productUrl: 'https://www.sephora.com/product/cerave-moisturizing-cream',
    });
    const lowScore = __internal.scoreRetailMatch({
      descriptor: { brand: 'CeraVe', name: 'Moisturizing Cream', query: 'CeraVe Moisturizing Cream' },
      pageTitle: 'Matte Makeup Brush | Tools',
      productUrl: 'https://www.sephora.com/product/makeup-brush',
    });
    expect(highScore).toBeGreaterThan(lowScore);
  });

  test('/v1/dupe/compare uses structured.alternatives for tradeoffs/evidence', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/dupe/compare')
      .set('X-Aurora-UID', 'uid_test_dupe_1')
      .send({
        original: { brand: 'MockBrand', name: 'Mock Parsed Product' },
        dupe: { brand: 'MockDupeBrand', name: 'Mock Dupe Product' },
      })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'dupe_compare');
    expect(card).toBeTruthy();
    expect(Array.isArray(card.payload.tradeoffs)).toBe(true);
    expect(
      card.payload.tradeoffs.some((t) => /compared to original|dupe adds|texture/i.test(String(t || ''))),
    ).toBe(true);
    expect(card.payload.compare_quality).toBe('full');
    expect(card.payload.limited_reason).toBeUndefined();
    expect(card.payload.confidence).toBeGreaterThan(0);

    const ev = card.payload.evidence;
    expect(ev).toBeTruthy();
    expect(Array.isArray(ev.science.key_ingredients)).toBe(true);
    expect(ev.science.key_ingredients.map((item) => String(item || '').toLowerCase())).toContain('niacinamide');
  });

  test('Normalization: evidence is never omitted (even on null input)', async () => {
    const { normalizeProductAnalysis, normalizeDupeCompare, normalizeRecoGenerate } = require('../src/auroraBff/normalize');

    expect(normalizeProductAnalysis(null).payload.evidence).toBeTruthy();
    expect(normalizeDupeCompare(null).payload.evidence).toBeTruthy();
    expect(normalizeRecoGenerate(null).payload.evidence).toBeTruthy();
  });

  test('Normalization: profile-fit reasons include actionable priorities for oily/sensitive/impaired barrier', () => {
    const { enrichProductAnalysisPayload } = require('../src/auroraBff/normalize');
    const payload = {
      assessment: {
        verdict: 'Likely Suitable',
        reasons: ['Detected key ingredients: Niacinamide, Panthenol.'],
      },
      evidence: {
        science: {
          key_ingredients: ['Niacinamide', 'Panthenol', 'Sodium Hyaluronate'],
          mechanisms: ['Hydration support'],
          fit_notes: [],
          risk_notes: [],
        },
        social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
        expert_notes: [],
        confidence: 0.7,
        missing_info: [],
      },
      confidence: 0.7,
      missing_info: [],
    };

    const enriched = enrichProductAnalysisPayload(payload, {
      lang: 'EN',
      profileSummary: {
        skinType: 'oily',
        sensitivity: 'high',
        barrierStatus: 'impaired',
        goals: ['acne', 'barrier_repair'],
      },
    });

    const reasonText = Array.isArray(enriched?.assessment?.reasons) ? enriched.assessment.reasons.join(' ') : '';
    expect(reasonText).toMatch(/sebum|oil/i);
    expect(reasonText).toMatch(/irritation|redness|sensitive/i);
    expect(reasonText).toMatch(/barrier repair|barrier support|barrier/i);
  });

  test('reconcileProductAnalysisConsistency backfills provider on legacy provenance.url_fetch attempts', () => {
    const { reconcileProductAnalysisConsistency } = require('../src/auroraBff/normalize');
    const payload = {
      assessment: {
        verdict: 'Likely Suitable',
        reasons: ['Has evidence'],
        anchor_product: { name: 'Legacy Product Anchor' },
      },
      evidence: {
        science: {
          key_ingredients: ['Water'],
          mechanisms: [],
          fit_notes: [],
          risk_notes: [],
        },
        social_signals: {
          typical_positive: [],
          typical_negative: [],
          risk_for_groups: [],
        },
        expert_notes: [],
        confidence: 0.61,
        missing_info: [],
      },
      confidence: 0.61,
      missing_info: [],
      provenance: {
        url_fetch: {
          final_strategy: 'axios_default',
          attempts: [{ strategy: 'axios_default', status: 200 }],
        },
      },
    };

    const out = reconcileProductAnalysisConsistency(payload, { lang: 'EN' });
    expect(out?.provenance?.url_fetch?.attempts?.[0]?.provider).toBe('native');
  });

  test('catalog fallback query builder extracts useful candidates from product URL', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const candidates = __internal.buildProductCatalogQueryCandidates({
      inputUrl: 'https://theordinary.com/en-al/multi-peptide-copper-peptides-1-serum-100625.html',
      inputText: 'https://theordinary.com/en-al/multi-peptide-copper-peptides-1-serum-100625.html',
    });

    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((q) => /theordinary|ordinary/i.test(String(q || '')))).toBe(true);
    expect(candidates.some((q) => /peptide|serum/i.test(String(q || '')))).toBe(true);
  });

  test('route competitor pools filters non-skincare candidates across competitors/related/dupes', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const routed = __internal.routeCompetitorCandidatePools({
      anchorProduct: {
        brand: 'Lab Series',
        category_taxonomy: ['moisturizer', 'face'],
        price: { amount: 45, currency: 'USD' },
      },
      candidates: [
        {
          product_id: 'brush_1',
          brand: 'Unknown',
          name: 'S05 Moisturizer Brush',
          category: 'makeup brush',
          similarity_score: 0.91,
          price: { amount: 20, currency: 'USD' },
          source: { type: 'catalog_search' },
        },
        {
          product_id: 'moisturizer_1',
          brand: 'Brand A',
          name: 'Hydrating Gel Moisturizer',
          category: 'moisturizer',
          category_use_case_match: 0.9,
          similarity_score: 0.72,
          price: { amount: 39, currency: 'USD' },
          source: { type: 'catalog_search' },
        },
      ],
      maxCandidates: 10,
    });

    expect(Array.isArray(routed.compPool)).toBe(true);
    expect(routed.compPool.some((item) => String(item?.name || '').toLowerCase().includes('brush'))).toBe(false);
    expect(routed.relPool.some((item) => String(item?.name || '').toLowerCase().includes('brush'))).toBe(false);
    expect(routed.dupePool.some((item) => String(item?.name || '').toLowerCase().includes('brush'))).toBe(false);
    expect(routed.candidateFilterStats).toEqual(
      expect.objectContaining({
        competitors_dropped_non_skincare: expect.any(Number),
        related_dropped_non_skincare: expect.any(Number),
        dupes_dropped_non_skincare: expect.any(Number),
      }),
    );
  });

  test('route competitor pools drops template/noise candidate names', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const routed = __internal.routeCompetitorCandidatePools({
      anchorProduct: {
        brand: 'Lab Series',
        category_taxonomy: ['moisturizer', 'face'],
        price: { amount: 45, currency: 'USD' },
      },
      candidates: [
        {
          product_id: 'tpl_1',
          brand: 'Unknown',
          name: '{{{ PROD_RGN_SUBHEADING }}}',
          category: 'moisturizer',
          similarity_score: 0.66,
          source: { type: 'on_page_related' },
        },
        {
          product_id: 'tpl_2',
          brand: 'Unknown',
          name: 'BESTSELLERS',
          category: 'moisturizer',
          similarity_score: 0.62,
          source: { type: 'on_page_related' },
        },
        {
          product_id: 'ok_1',
          brand: 'Brand A',
          name: 'Hydrating Gel Moisturizer',
          category: 'moisturizer',
          category_use_case_match: 0.9,
          similarity_score: 0.72,
          source: { type: 'catalog_search' },
        },
      ],
      maxCandidates: 10,
    });

    const names = [
      ...routed.compPool.map((item) => String(item?.name || '').toLowerCase()),
      ...routed.relPool.map((item) => String(item?.name || '').toLowerCase()),
      ...routed.dupePool.map((item) => String(item?.name || '').toLowerCase()),
    ];
    expect(names.some((name) => name.includes('prod_rgn_subheading'))).toBe(false);
    expect(names.some((name) => name.includes('bestseller'))).toBe(false);
    expect(names.some((name) => name.includes('hydrat'))).toBe(true);
  });

  test('product-intel kb key uses fingerprint fallback for non-anchor routine products', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const key1 = __internal.buildProductIntelKbKey({
      parsedProduct: {
        brand: 'Biotherm',
        name: 'Force Supreme Cleanser',
      },
      lang: 'EN',
    });
    const key2 = __internal.buildProductIntelKbKey({
      parsedProduct: {
        brand: 'Biotherm',
        name: 'Force Supreme Cleanser',
      },
      lang: 'EN',
    });
    expect(key1).toMatch(/^fp:[a-f0-9]{64}$/);
    expect(key2).toBe(key1);
    expect(
      __internal.resolveProductIntelKbKeyQuality({
        parsedProduct: { brand: 'Biotherm', name: 'Force Supreme Cleanser' },
        lang: 'EN',
      }),
    ).toBe('fingerprint');
  });

  test('product-intel kb key prefers URL over anchor_id when both are present', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const key = __internal.buildProductIntelKbKey({
      productUrl: 'https://example.com/products/abc?utm_source=test',
      parsedProduct: {
        product_id: 'sku_anchor_123',
        brand: 'Example',
        name: 'Example Product',
      },
      lang: 'EN',
    });
    expect(key).toBe('url:https://example.com/products/abc');
    expect(
      __internal.resolveProductIntelKbKeyQuality({
        productUrl: 'https://example.com/products/abc?utm_source=test',
        parsedProduct: { product_id: 'sku_anchor_123' },
        lang: 'EN',
      }),
    ).toBe('url');
  });

  test('realtime competitor query plan keeps diversified active-intent seed when max queries is low', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const plan = __internal.buildRealtimeCompetitorQueryPlan({
      fromCatalogQueries: [
        'The Ordinary Multi Peptide Copper Peptides 1 Serum',
        'theordinary al multi peptide copper peptides 1 serum 100625',
      ],
      keyIngredients: ['Copper Tripeptide-1', 'Acetyl Hexapeptide-8', 'Sodium Hyaluronate'],
      parsedProduct: {
        brand: 'The Ordinary',
        name: 'The Ordinary Multi Peptide Copper Peptides 1 Serum',
      },
      categoryToken: 'serum',
      maxQueries: 2,
    });

    expect(Array.isArray(plan)).toBe(true);
    expect(plan).toHaveLength(2);
    expect(plan.some((q) => /copper peptide|peptide/i.test(String(q || '')))).toBe(true);
    expect(plan.some((q) => /serum/i.test(String(q || '')))).toBe(true);
    expect(plan.some((q) => /^https?:\/\//i.test(String(q || '')))).toBe(false);
  });

  test('catalog search base urls prefer configured list before pivota backend for aurora reco path', () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'https://web-production-fedb.up.railway.app';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS = 'https://pivota-agent-production.up.railway.app';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_PREFER_CONFIGURED_BASE_URLS = 'true';
    jest.resetModules();
    const { __internal } = require('../src/auroraBff/routes');
    const urls = __internal.buildRecoCatalogSearchBaseUrlCandidates();
    expect(urls[0]).toBe('https://pivota-agent-production.up.railway.app');
    expect(urls).toContain('https://web-production-fedb.up.railway.app');
  });

  test('catalog search base urls include self proxy before upstream backend when enabled', () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'https://web-production-fedb.up.railway.app';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS = '';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_PREFER_CONFIGURED_BASE_URLS = 'true';
    process.env.AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED = 'true';
    process.env.AURORA_BFF_RECO_CATALOG_SELF_PROXY_BASE_URL = 'http://127.0.0.1:3999';
    jest.resetModules();
    const { __internal } = require('../src/auroraBff/routes');
    const urls = __internal.buildRecoCatalogSearchBaseUrlCandidates();
    expect(urls[0]).toBe('http://127.0.0.1:3999');
    expect(urls).toContain('https://web-production-fedb.up.railway.app');
  });

  test('catalog search base urls can force self proxy first before configured aurora bases', () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'https://web-production-fedb.up.railway.app';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS = 'https://catalog-remote.test';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_PREFER_CONFIGURED_BASE_URLS = 'true';
    process.env.AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED = 'true';
    process.env.AURORA_BFF_RECO_CATALOG_SELF_PROXY_BASE_URL = 'http://127.0.0.1:3999';
    jest.resetModules();
    const { __internal } = require('../src/auroraBff/routes');
    const urls = __internal.buildRecoCatalogSearchBaseUrlCandidates({ preferSelfProxyFirst: true });
    expect(urls[0]).toBe('http://127.0.0.1:3999');
    expect(urls).toContain('https://catalog-remote.test');
    expect(urls).toContain('https://web-production-fedb.up.railway.app');
  });

  test('catalog search forwards explicit external-seed controls to upstream search query', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-primary.test';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_PREFER_CONFIGURED_BASE_URLS = 'false';

    nock('http://catalog-primary.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '') === 'peptide serum' &&
          String(q.allow_external_seed || '') === 'false' &&
          String(q.external_seed_strategy || '') === 'legacy' &&
          String(q.fast_mode || '') === 'true'
        );
      })
      .reply(200, {
        ok: true,
        products: [
          {
            product_id: 'comp_explicit_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            brand: 'Alt Brand',
            name: 'Alt Serum',
            display_name: 'Alt Brand Alt Serum',
          },
        ],
      });

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.searchPivotaBackendProducts({
      query: 'peptide serum',
      limit: 3,
      timeoutMs: 1200,
      allowExternalSeed: false,
      externalSeedStrategy: 'legacy',
      fastMode: true,
      logger: { warn: jest.fn(), info: jest.fn() },
    });

    expect(out.ok).toBe(true);
    expect(Array.isArray(out.products)).toBe(true);
    expect(out.products[0].product_id).toBe('comp_explicit_1');
  });

  test('catalog search fails over to secondary source on repeated primary empty results', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-primary.test';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS = 'http://catalog-secondary.test';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_PREFER_CONFIGURED_BASE_URLS = 'false';
    process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED = 'true';
    process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ON_EMPTY = 'true';
    process.env.AURORA_BFF_RECO_CATALOG_SOURCE_EMPTY_FAIL_THRESHOLD = '1';
    process.env.AURORA_BFF_RECO_CATALOG_SOURCE_EMPTY_COOLDOWN_MS = '600000';
    process.env.AURORA_BFF_RECO_CATALOG_ENABLE_BEAUTY_PATH_FALLBACK = 'false';

    nock('http://catalog-primary.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        ok: true,
        products: [],
      });

    nock('http://catalog-secondary.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        ok: true,
        products: [
          {
            product_id: 'comp_secondary_1',
            brand: 'Alt Brand',
            name: 'Alt Serum',
            display_name: 'Alt Brand Alt Serum',
          },
        ],
      });

    const { __internal } = require('../src/auroraBff/routes');
    const logger = { warn: jest.fn(), info: jest.fn() };

    const first = await __internal.searchPivotaBackendProducts({
      query: 'peptide serum',
      limit: 3,
      logger,
      timeoutMs: 1200,
    });
    expect(first.ok).toBe(true);
    expect(Array.isArray(first.products)).toBe(true);
    expect(first.products[0].product_id).toBe('comp_secondary_1');
    expect(first.source_base_url).toBe('http://catalog-secondary.test');
    expect(first.attempted_sources).toEqual(
      expect.arrayContaining(['http://catalog-primary.test', 'http://catalog-secondary.test']),
    );

    const second = await __internal.searchPivotaBackendProducts({
      query: 'peptide serum',
      limit: 3,
      logger,
      timeoutMs: 1200,
    });
    expect(second.ok).toBe(true);
    expect(second.products[0].product_id).toBe('comp_secondary_1');
    expect(second.source_base_url).toBe('http://catalog-secondary.test');
    expect(second.attempted_sources[0]).toBe('http://catalog-secondary.test');
    expect(second.attempted_sources).not.toContain('http://catalog-primary.test');

    const sourceHealth = __internal.getRecoCatalogSearchSourceHealthSnapshot();
    const primaryState = sourceHealth.find((item) => item.base_url === 'http://catalog-primary.test');
    expect(primaryState).toBeTruthy();
    expect(primaryState.deprioritized).toBe(true);
  });

  test('catalog search falls back from beauty route path to generic path on same source', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-primary.test';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_PATHS = '/agent/v1/beauty/products/search,/agent/v1/products/search';
    process.env.AURORA_BFF_RECO_CATALOG_BEAUTY_ROUTE_FIRST = 'true';
    process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED = 'false';

    nock('http://catalog-primary.test')
      .persist()
      .get('/agent/v1/beauty/products/search')
      .query(true)
      .reply(404, { error: 'not_found' });

    nock('http://catalog-primary.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        ok: true,
        products: [
          {
            product_id: 'comp_generic_1',
            brand: 'Alt Brand',
            name: 'Alt Serum Generic',
            display_name: 'Alt Brand Alt Serum Generic',
          },
        ],
      });

    const { __internal } = require('../src/auroraBff/routes');
    const logger = { warn: jest.fn(), info: jest.fn() };
    const out = await __internal.searchPivotaBackendProducts({
      query: 'peptide serum',
      limit: 3,
      logger,
      timeoutMs: 1200,
    });
    expect(out.ok).toBe(true);
    expect(out.products[0].product_id).toBe('comp_generic_1');
    expect(out.source_base_url).toBe('http://catalog-primary.test');
    expect(out.source_endpoint).toBe('http://catalog-primary.test/agent/v1/products/search');
    expect(Array.isArray(out.attempted_endpoints)).toBe(true);
    expect(out.attempted_endpoints).toEqual([
      'http://catalog-primary.test/agent/v1/beauty/products/search',
      'http://catalog-primary.test/agent/v1/products/search',
    ]);
    expect(out.source_failover).toBe(false);
  });

  test('catalog search respects per-attempt budget and does not run extra path fallback after timeout budget is exhausted', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-budget.test';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_PATHS = '/agent/v1/beauty/products/search,/agent/v1/products/search';
    process.env.AURORA_BFF_RECO_CATALOG_BEAUTY_ROUTE_FIRST = 'true';
    process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED = 'false';

    nock('http://catalog-budget.test')
      .persist()
      .get('/agent/v1/beauty/products/search')
      .query(true)
      .delayConnection(900)
      .reply(200, {
        ok: true,
        products: [],
      });

    const genericScope = nock('http://catalog-budget.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        ok: true,
        products: [
          {
            product_id: 'comp_should_not_be_called',
            brand: 'Alt Brand',
            name: 'Late Generic Fallback',
            display_name: 'Alt Brand Late Generic Fallback',
          },
        ],
      });

    const { __internal } = require('../src/auroraBff/routes');
    const logger = { warn: jest.fn(), info: jest.fn() };
    const out = await __internal.searchPivotaBackendProducts({
      query: 'peptide serum',
      limit: 3,
      logger,
      timeoutMs: 320,
    });

    expect(out.ok).toBe(false);
    expect(String(out.reason || '')).toMatch(/(upstream_timeout|budget_exhausted)/i);
    expect(Array.isArray(out.attempted_endpoints)).toBe(true);
    expect(out.attempted_endpoints[0]).toBe('http://catalog-budget.test/agent/v1/beauty/products/search');
    expect(genericScope.isDone()).toBe(false);
  });

  test('buildRealtimeCompetitorCandidates keeps one main-path query attempt under tight budget', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-main-budget.test';
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_RETURN_SLACK_MS = '220';
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MIN_MAIN_QUERY_BUDGET_MS = '160';
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MIN_QUERY_TIMEOUT_MS = '150';
    process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_QUERY_FANOUT_CAP = '1';

    const searchFn = jest.fn(async () => ({
      ok: true,
      reason: null,
      products: [
        {
          product_id: 'comp_low_budget_1',
          merchant_id: 'merch_alt_1',
          brand: 'Alt Brand',
          name: 'Copper Peptide Serum',
          display_name: 'Alt Brand Copper Peptide Serum',
          category: 'serum',
        },
      ],
    }));

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.buildRealtimeCompetitorCandidates({
      productUrl: 'https://theordinary.com/en-al/multi-peptide-copper-peptides-1-serum-100625.html',
      parsedProduct: {
        product_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      keyIngredients: ['Copper Tripeptide-1', 'Sodium Hyaluronate'],
      anchorProduct: {
        product_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      mode: 'main_path',
      deadlineMs: Date.now() + 420,
      timeoutMs: 500,
      maxQueries: 2,
      maxCandidates: 4,
      searchFn,
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    });

    expect(searchFn).toHaveBeenCalled();
    expect(searchFn.mock.calls.length).toBe(1);
    expect(Number(out?.query_attempted || out?.meta?.query_attempted || 0)).toBeGreaterThan(0);
    const reasonBreakdown =
      out?.reason_counts && typeof out.reason_counts === 'object'
        ? out.reason_counts
        : out?.meta?.reason_counts;
    expect(reasonBreakdown).toBeTruthy();
    expect(typeof reasonBreakdown).toBe('object');
  });

  test('buildRealtimeCompetitorCandidates raises main-path query timeout floor when external seed is enabled', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-main-budget.test';
    process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_QUERY_FANOUT_CAP = '1';
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MAIN_ALLOW_EXTERNAL_SEED = 'true';
    process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_TIMEOUT_FLOOR_MS = '900';

    let capturedTimeoutMs = 0;
    const searchFn = jest.fn(async ({ timeoutMs }) => {
      capturedTimeoutMs = Number(timeoutMs || 0);
      return {
        ok: true,
        reason: null,
        products: [
          {
            product_id: 'comp_timeout_floor_1',
            merchant_id: 'merch_alt_1',
            brand: 'Alt Brand',
            name: 'Copper Peptide Serum',
            display_name: 'Alt Brand Copper Peptide Serum',
            category: 'serum',
          },
        ],
      };
    });

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.buildRealtimeCompetitorCandidates({
      productUrl: 'https://theordinary.com/en-al/multi-peptide-copper-peptides-1-serum-100625.html',
      parsedProduct: {
        product_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      keyIngredients: ['Copper Tripeptide-1', 'Sodium Hyaluronate'],
      anchorProduct: {
        product_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      mode: 'main_path',
      deadlineMs: Date.now() + 5000,
      timeoutMs: 450,
      maxQueries: 2,
      maxCandidates: 4,
      searchFn,
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    });

    expect(out?.candidates?.length || 0).toBeGreaterThan(0);
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(capturedTimeoutMs).toBeGreaterThanOrEqual(500);
  });

  test('buildRealtimeCompetitorCandidates applies main-path timeout floor even without external seed', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-main-budget.test';
    process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_QUERY_FANOUT_CAP = '1';
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MAIN_ALLOW_EXTERNAL_SEED = 'false';
    process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_TIMEOUT_FLOOR_MS = '900';

    let capturedTimeoutMs = 0;
    const searchFn = jest.fn(async ({ timeoutMs }) => {
      capturedTimeoutMs = Number(timeoutMs || 0);
      return {
        ok: true,
        reason: null,
        products: [
          {
            product_id: 'comp_timeout_floor_2',
            merchant_id: 'merch_alt_2',
            brand: 'Alt Brand',
            name: 'Peptide Serum',
            display_name: 'Alt Brand Peptide Serum',
            category: 'serum',
          },
        ],
      };
    });

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.buildRealtimeCompetitorCandidates({
      productUrl: 'https://theordinary.com/en-al/multi-peptide-copper-peptides-1-serum-100625.html',
      parsedProduct: {
        product_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      keyIngredients: ['Copper Tripeptide-1', 'Sodium Hyaluronate'],
      anchorProduct: {
        product_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      mode: 'main_path',
      deadlineMs: Date.now() + 5000,
      timeoutMs: 450,
      maxQueries: 2,
      maxCandidates: 4,
      searchFn,
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    });

    expect(out?.candidates?.length || 0).toBeGreaterThan(0);
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(capturedTimeoutMs).toBeGreaterThanOrEqual(500);
  });

  test('buildRealtimeCompetitorCandidates can early-stop after first same-brand-heavy recall batch', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-main-budget.test';
    process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_QUERY_FANOUT_CAP = '3';

    const sameBrandProducts = Array.from({ length: 4 }).map((_, idx) => ({
      product_id: `same_brand_${idx + 1}`,
      merchant_id: `merch_same_${idx + 1}`,
      brand: 'The Ordinary',
      name: `Same Brand Option ${idx + 1}`,
      display_name: `The Ordinary Same Brand Option ${idx + 1}`,
      category: 'serum',
    }));
    const crossBrandProduct = {
      product_id: 'cross_brand_1',
      merchant_id: 'merch_cross_1',
      brand: 'Alt Brand',
      name: 'Copper Peptide Serum',
      display_name: 'Alt Brand Copper Peptide Serum',
      category: 'serum',
    };

    let invocation = 0;
    const searchFn = jest.fn(async () => {
      invocation += 1;
      if (invocation === 1) {
        return { ok: true, reason: null, products: sameBrandProducts };
      }
      return { ok: true, reason: null, products: [crossBrandProduct] };
    });

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.buildRealtimeCompetitorCandidates({
      productUrl: 'https://theordinary.com/en-al/multi-peptide-copper-peptides-1-serum-100625.html',
      parsedProduct: {
        product_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      keyIngredients: ['Copper Tripeptide-1', 'Sodium Hyaluronate'],
      anchorProduct: {
        product_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      mode: 'main_path',
      deadlineMs: Date.now() + 5000,
      timeoutMs: 2500,
      maxQueries: 3,
      maxCandidates: 6,
      searchFn,
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    });

    expect(searchFn.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(out?.candidates)).toBe(true);
  });

  test('sync competitor repair runs when competitors are empty even without low-coverage token', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-sync-repair.test';
    process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED = 'false';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_PATHS = '/agent/v1/products/search';
    process.env.AURORA_BFF_RECO_CATALOG_BEAUTY_ROUTE_FIRST = 'false';
    process.env.AURORA_BFF_RECO_BLOCKS_DAG_ENABLED = 'true';

    nock('http://catalog-sync-repair.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        ok: true,
        products: [
          {
            product_id: 'comp_sync_repair_1',
            merchant_id: 'merch_alt_1',
            brand: 'Alt Brand',
            name: 'Barrier Serum',
            display_name: 'Alt Brand Barrier Serum',
            category: 'serum',
          },
        ],
      });

    const { __internal } = require('../src/auroraBff/routes');
    const payload = {
      assessment: {
        anchor_product: {
          product_id: 'anchor_1',
          brand: 'The Ordinary',
          name: 'Multi-Peptide + Copper Peptides 1% Serum',
          category: 'serum',
        },
      },
      competitors: { candidates: [] },
      evidence: {
        science: {
          key_ingredients: ['Copper Tripeptide-1'],
        },
        social_signals: {},
        expert_notes: [],
        missing_info: [],
      },
      missing_info: [],
    };

    const out = await __internal.maybeSyncRepairLowCoverageCompetitors({
      productUrl: 'https://theordinary.com/en-al/multi-peptide-copper-peptides-1-serum-100625.html',
      payload,
      parsedProduct: payload.assessment.anchor_product,
      lang: 'EN',
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    });

    expect(out.reason).not.toBe('competitors_missing');
    expect(out.reason).not.toBe('coverage_token_missing');
    const candidates = Array.isArray(out?.payload?.competitors?.candidates)
      ? out.payload.competitors.candidates
      : [];
    expect(candidates.length).toBeGreaterThan(0);
  });

  test('catalog search defaults to generic route first when beauty-first flag is disabled', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-primary.test';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_PATHS = '/agent/v1/beauty/products/search,/agent/v1/products/search';
    process.env.AURORA_BFF_RECO_CATALOG_BEAUTY_ROUTE_FIRST = 'false';
    process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED = 'false';

    nock('http://catalog-primary.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        ok: true,
        products: [
          {
            product_id: 'comp_generic_first_1',
            brand: 'Alt Brand',
            name: 'Alt Serum Generic First',
            display_name: 'Alt Brand Alt Serum Generic First',
          },
        ],
      });

    const { __internal } = require('../src/auroraBff/routes');
    const logger = { warn: jest.fn(), info: jest.fn() };
    const out = await __internal.searchPivotaBackendProducts({
      query: 'peptide serum',
      limit: 3,
      logger,
      timeoutMs: 1200,
    });
    expect(out.ok).toBe(true);
    expect(out.products[0].product_id).toBe('comp_generic_first_1');
    expect(out.source_endpoint).toBe('http://catalog-primary.test/agent/v1/products/search');
    expect(Array.isArray(out.attempted_endpoints)).toBe(true);
    expect(out.attempted_endpoints[0]).toBe('http://catalog-primary.test/agent/v1/products/search');
  });

  test('aurora catalog search prefers self proxy first when aurora self-proxy-first flag is enabled', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-upstream.test';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS = 'http://catalog-upstream.test';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_SOURCE = 'aurora-bff';
    process.env.AURORA_BFF_RECO_CATALOG_AURORA_SELF_PROXY_FIRST = 'true';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_PREFER_CONFIGURED_BASE_URLS = 'true';
    process.env.AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED = 'true';
    process.env.AURORA_BFF_RECO_CATALOG_SELF_PROXY_BASE_URL = 'http://catalog-self.test';
    process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED = 'true';

    nock('http://catalog-self.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        ok: true,
        products: [
          {
            product_id: 'self_proxy_1',
            brand: 'Alt Brand',
            name: 'Alt Serum Self Proxy',
            display_name: 'Alt Brand Alt Serum Self Proxy',
          },
        ],
      });

    nock('http://catalog-upstream.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(504, {
        status: 'error',
        error: { code: 'UPSTREAM_TIMEOUT', message: 'timeout' },
      });

    jest.resetModules();
    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.searchPivotaBackendProducts({
      query: 'peptide serum',
      limit: 3,
      logger: { warn: jest.fn(), info: jest.fn() },
      timeoutMs: 1200,
    });

    expect(out.ok).toBe(true);
    expect(out.products[0].product_id).toBe('self_proxy_1');
    expect(Array.isArray(out.attempted_endpoints)).toBe(true);
    expect(out.attempted_endpoints[0]).toBe('http://catalog-self.test/agent/v1/products/search');
  });

  test('catalog search auto-falls back to beauty path when generic route is empty', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-primary.test';
    process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED = 'false';
    process.env.AURORA_BFF_RECO_CATALOG_BEAUTY_ROUTE_FIRST = 'false';
    process.env.AURORA_BFF_RECO_CATALOG_ENABLE_BEAUTY_PATH_FALLBACK = 'true';
    delete process.env.AURORA_BFF_RECO_CATALOG_SEARCH_PATHS;

    nock('http://catalog-primary.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        ok: true,
        products: [],
      });

    nock('http://catalog-primary.test')
      .persist()
      .get('/agent/v1/beauty/products/search')
      .query(true)
      .reply(200, {
        ok: true,
        products: [
          {
            product_id: 'comp_beauty_1',
            brand: 'Beauty Alt',
            name: 'Beauty Recovery Serum',
            display_name: 'Beauty Alt Beauty Recovery Serum',
          },
        ],
      });

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.searchPivotaBackendProducts({
      query: 'peptide repair serum',
      limit: 3,
      logger: { warn: jest.fn(), info: jest.fn() },
      timeoutMs: 1200,
    });

    expect(out.ok).toBe(true);
    expect(out.products[0].product_id).toBe('comp_beauty_1');
    expect(Array.isArray(out.attempted_endpoints)).toBe(true);
    expect(out.attempted_endpoints).toEqual([
      'http://catalog-primary.test/agent/v1/products/search',
      'http://catalog-primary.test/agent/v1/beauty/products/search',
    ]);
    expect(out.source_endpoint).toBe('http://catalog-primary.test/agent/v1/beauty/products/search');
  });

  test('catalog search respects tight deadline and exits with budget_exhausted instead of timing out', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-primary.test';
    process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED = 'false';

    const { __internal } = require('../src/auroraBff/routes');
    const startedAt = Date.now();
    const out = await __internal.searchPivotaBackendProducts({
      query: 'peptide repair serum',
      limit: 3,
      logger: { warn: jest.fn(), info: jest.fn() },
      timeoutMs: 1200,
      deadlineMs: Date.now() + 60,
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('budget_exhausted');
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  test('catalog product mapping produces parse/analyze-compatible anchor payload', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const mapped = __internal.mapCatalogProductToAnchorProduct({
      product_id: 'p123',
      sku_id: 'sku123',
      merchant_id: 'm1',
      brand: 'The Ordinary',
      name: 'Multi-Peptide + Copper Peptides 1% Serum',
      display_name: 'The Ordinary Multi-Peptide + Copper Peptides 1% Serum',
      image_url: 'https://example.com/p.jpg',
    });

    expect(mapped).toBeTruthy();
    expect(mapped.product_id).toBe('p123');
    expect(mapped.sku_id).toBe('sku123');
    expect(mapped.brand).toBe('The Ordinary');
    expect(mapped.name).toContain('Multi-Peptide');
    expect(mapped.display_name).toContain('The Ordinary');
  });

  test('catalog normalization extracts social/ingredient/skin signals for competitor scoring', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const normalized = __internal.normalizeRecoCatalogProduct({
      product_id: 'comp_social_1',
      brand: 'Brand Social',
      name: 'Blemish Balance Serum',
      key_ingredients: ['Niacinamide', 'Zinc PCA', 'Panthenol'],
      skin_types: ['oily', 'sensitive'],
      social_stats: {
        platform_scores: { Reddit: 0.82, TikTok: 0.75 },
        mention_count: 380,
      },
      review_count: 540,
      rating_value: 4.4,
    });

    expect(normalized).toBeTruthy();
    expect(Array.isArray(normalized.ingredient_tokens)).toBe(true);
    expect(normalized.ingredient_tokens).toEqual(expect.arrayContaining(['niacinamide', 'zinc']));
    expect(Array.isArray(normalized.skin_type_tags)).toBe(true);
    expect(normalized.skin_type_tags).toEqual(expect.arrayContaining(['oily', 'sensitive']));
    expect(typeof normalized.social_ref_score).toBe('number');
    expect(normalized.social_ref_score).toBeGreaterThan(0.6);
    expect(normalized.social_raw).toBeTruthy();
    expect(Array.isArray(normalized.social_raw.channels)).toBe(true);
    expect(normalized.social_raw.channels).toEqual(expect.arrayContaining(['reddit', 'tiktok']));
  });

  test('catalog normalization extracts candidate price for dupe/price-distance gates', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const normalized = __internal.normalizeRecoCatalogProduct({
      product_id: 'comp_price_1',
      brand: 'Brand Price',
      name: 'Barrier Serum',
      category: 'serum',
      offers: {
        price: '29.50',
        priceCurrency: 'USD',
      },
    });

    expect(normalized).toBeTruthy();
    expect(normalized.price).toBeTruthy();
    expect(normalized.price).toEqual(
      expect.objectContaining({
        amount: 29.5,
        currency: 'USD',
        unknown: false,
      }),
    );
  });

  test('attachExplanations emits user-visible social summary only for whitelisted channels', () => {
    const { attachExplanations } = require('../src/auroraBff/recoScoreExplain');
    const out = attachExplanations(
      'competitors',
      {
        brand_id: 'anchor_brand',
        category_taxonomy: ['serum'],
        price: 88,
        ingredient_tokens: ['niacinamide', 'panthenol'],
        profile_skin_tags: ['oily', 'sensitive'],
      },
      [
        {
          product_id: 'comp_social_summary_1',
          name: 'Signal Candidate',
          brand_id: 'other_brand',
          category_taxonomy: ['serum'],
          source: { type: 'catalog_search' },
          price: 79,
          social_raw: {
            channels: ['reddit', 'xhs', 'retailer_product_page'],
            co_mention_strength: 0.66,
            sentiment_proxy: 0.71,
            topic_keywords: ['barrier repair', 'hydration', '完美平替', '@noise'],
            mention_count: 999,
          },
          score_breakdown: {
            category_use_case_match: 0.9,
            ingredient_functional_similarity: 0.8,
            skin_fit_similarity: 0.7,
            social_reference_strength: 0.8,
            price_distance: 0.8,
            quality: 0.75,
          },
        },
      ],
      { lang: 'EN' },
    );
    const summary = out[0].social_summary_user_visible;
    expect(summary).toBeTruthy();
    expect(summary.themes.length).toBeLessThanOrEqual(3);
    expect(summary.top_keywords.length).toBeLessThanOrEqual(6);
    expect(JSON.stringify(summary).toLowerCase()).not.toMatch(/mention_count|@noise|完美平替/);
  });

  test('KB social freshness state returns kb_hit when social coverage is fresh and complete', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const freshUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const state = __internal.resolveProductAnalysisSocialState({
      competitors: {
        candidates: [
          {
            social_summary_user_visible: {
              themes: ['Barrier repair'],
              top_keywords: ['hydration'],
              volume_bucket: 'mid',
            },
          },
        ],
      },
      related_products: { candidates: [] },
      dupes: { candidates: [] },
      provenance: {
        generated_at: new Date().toISOString(),
        social_fresh_until: freshUntil,
        social_channels_used: ['reddit', 'xhs'],
      },
      evidence: {
        social_signals: {
          platform_scores: {
            Reddit: 0.7,
            Xiaohongshu: 0.6,
          },
        },
      },
    });
    expect(state.fetchMode).toBe('kb_hit');
    expect(state.shouldRefresh).toBe(false);
  });

  test('KB social freshness state returns stale_kb when coverage is missing', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const state = __internal.resolveProductAnalysisSocialState({
      competitors: {
        candidates: [
          {
            social_summary_user_visible: {
              themes: ['Barrier repair'],
              top_keywords: ['hydration'],
              volume_bucket: 'mid',
            },
          },
        ],
      },
      related_products: { candidates: [] },
      dupes: { candidates: [] },
      provenance: {
        generated_at: new Date().toISOString(),
        social_fresh_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        social_channels_used: ['reddit'],
      },
    });
    expect(state.fetchMode).toBe('stale_kb');
    expect(state.shouldRefresh).toBe(true);
  });

  test('URL realtime helper extracts price from JSON-LD product offer', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {"@context":"http://schema.org","@type":"Product","name":"Test Serum","offers":{"@type":"Offer","price":"35.30","priceCurrency":"EUR"}}
          </script>
        </head>
      </html>
    `;
    const out = __internal.extractProductPriceFromHtml(html);
    expect(out).toBeTruthy();
    expect(out.amount).toBe(35.3);
    expect(out.currency).toBe('EUR');
    expect(out.unknown).toBe(false);
  });

  test('URL realtime helper extracts price from on-page structured text when JSON-LD is missing', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const html = `
      <html>
        <head><title>Test Serum</title></head>
        <body>
          <div class="price">USD 29.90</div>
          <span>Buy now</span>
        </body>
      </html>
    `;
    const out = __internal.extractProductPriceFromHtml(html);
    expect(out).toBeTruthy();
    expect(out.amount).toBe(29.9);
    expect(out.currency).toBe('USD');
    expect(out.source).toBe('on_page_structured_text');
    expect(out.unknown).toBe(false);
  });

  test('normalizePriceObject supports parsed upstream price shapes', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const fromUsd = __internal.normalizePriceObject({ usd: 29.9, unknown: false });
    expect(fromUsd).toEqual({ amount: 29.9, currency: 'USD', unknown: false });

    const fromAmount = __internal.normalizePriceObject({ amount: '42.50', currency: 'usd' });
    expect(fromAmount).toEqual({ amount: 42.5, currency: 'USD', unknown: false });

    const fromText = __internal.normalizePriceObject('EUR 35,30');
    expect(fromText).toEqual({ amount: 35.3, currency: 'EUR', unknown: false });
  });

  test('applyProductAnalysisGapContract strips internal codes and keeps user-facing missing_info only', () => {
    const { applyProductAnalysisGapContract } = require('../src/auroraBff/normalize');
    const out = applyProductAnalysisGapContract({
      missing_info: [
        'reco_dag_timeout_catalog_ann',
        'url_realtime_product_intel_used',
        'upstream_analysis_missing',
        'price_unknown',
        'skin_fit.profile.skinType',
      ],
      internal_debug_codes: ['router.same_brand_competitor', 'internal_debug_only'],
    });
    expect(Array.isArray(out.missing_info)).toBe(true);
    expect(out.missing_info).toEqual(
      expect.arrayContaining(['analysis_in_progress', 'price_temporarily_unavailable']),
    );
    expect(out.missing_info).not.toContain('profile_not_provided');
    expect(out.profile_prompt).toEqual(
      expect.objectContaining({
        needed: true,
        cta_action: 'open_profile',
      }),
    );
    expect(out.missing_info).not.toEqual(
      expect.arrayContaining([
        'reco_dag_timeout_catalog_ann',
        'url_realtime_product_intel_used',
        'router.same_brand_competitor',
      ]),
    );
  });

  test('attachPrelabelSuggestionsToPayload injects sanitized llm_suggestion by block + candidate id', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const payload = {
      competitors: {
        candidates: [
          { product_id: 'comp_1', name: 'Competitor 1' },
        ],
      },
      related_products: { candidates: [] },
      dupes: { candidates: [] },
    };
    const out = __internal.attachPrelabelSuggestionsToPayload(payload, [
      {
        id: 'sug_1',
        block: 'competitors',
        candidate_product_id: 'comp_1',
        suggested_label: 'relevant',
        wrong_block_target: null,
        confidence: 0.74,
        rationale_user_visible: 'Matches category and ingredient profile.',
        flags: ['needs_price_check'],
        model_name: 'gemini-2.0-flash',
        prompt_version: 'prelabel_v1',
        input_hash: 'should_not_leak',
      },
    ]);

    const suggestion = out?.competitors?.candidates?.[0]?.llm_suggestion;
    expect(suggestion).toBeTruthy();
    expect(suggestion).toEqual(
      expect.objectContaining({
        id: 'sug_1',
        suggested_label: 'relevant',
        confidence: 0.74,
        rationale_user_visible: 'Matches category and ingredient profile.',
        model_name: 'gemini-2.0-flash',
        prompt_version: 'prelabel_v1',
      }),
    );
    expect(suggestion.input_hash).toBeUndefined();
  });

  test('reco guardrail sanitizes polluted competitors and writes low-confidence provenance', () => {
    process.env.AURORA_BFF_RECO_GUARD_ENABLED = 'true';
    process.env.AURORA_BFF_RECO_GUARD_CIRCUIT_ENABLED = 'true';
    process.env.AURORA_BFF_RECO_GUARD_CIRCUIT_THRESHOLD = '99';

    const { __internal } = require('../src/auroraBff/routes');
    const logger = { warn: jest.fn(), info: jest.fn() };
    const payload = {
      assessment: {
        anchor_product: { brand_id: 'anchor_brand' },
      },
      competitors: {
        candidates: [
          {
            product_id: 'same_brand_1',
            brand_id: 'anchor_brand',
            name: 'Anchor Leakage',
            source: { type: 'catalog_search' },
            score_breakdown: { category_use_case_match: 0.8, ingredient_functional_similarity: 0.7, price_distance: 0.6 },
            why_candidate: { summary: 'Leak', reasons_user_visible: ['category match', 'ingredient overlap', 'price close'] },
          },
          {
            product_id: 'on_page_1',
            brand_id: 'other_brand_1',
            name: 'On page leakage',
            source: { type: 'on_page_related' },
            score_breakdown: { category_use_case_match: 0.8, ingredient_functional_similarity: 0.7, price_distance: 0.6 },
            why_candidate: { summary: 'Leak', reasons_user_visible: ['category match', 'ingredient overlap', 'price close'] },
          },
          {
            product_id: 'clean_1',
            brand_id: 'other_brand_2',
            name: 'Clean Candidate',
            source: { type: 'catalog_search' },
            score_breakdown: { category_use_case_match: 0.82, ingredient_functional_similarity: 0.74, price_distance: 0.63 },
            why_candidate: { summary: 'Clean', reasons_user_visible: ['category match', 'ingredient overlap', 'price close'] },
          },
        ],
      },
      related_products: { candidates: [] },
      dupes: { candidates: [] },
      confidence_by_block: {
        competitors: { score: 0.72, level: 'high', reasons: ['baseline'] },
      },
      provenance: {
        generated_at: new Date().toISOString(),
        contract_version: 'aurora.product_intel.contract.v2',
        pipeline: 'reco_blocks_dag.v1',
        source: 'test',
        validation_mode: 'soft_fail',
      },
      missing_info_internal: [],
      missing_info: [],
    };

    const out = __internal.applyRecoGuardrailToProductAnalysisPayload(payload, {
      logger,
      requestId: 'req_guard_1',
      mode: 'main_path',
    });

    expect(Array.isArray(out?.competitors?.candidates)).toBe(true);
    expect(out.competitors.candidates.map((x) => x.product_id)).toEqual(['clean_1']);
    expect(out?.confidence_by_block?.competitors?.level).toBe('low');
    expect(Array.isArray(out?.provenance?.guardrail_violations)).toBe(true);
    expect(out.provenance.guardrail_violations).toEqual(
      expect.arrayContaining(['same_brand', 'on_page_source']),
    );
    expect(out.provenance.guardrail_applied).toBe(true);
    expect(Array.isArray(out.missing_info)).toBe(true);
    expect(out.missing_info).not.toEqual(
      expect.arrayContaining([
        'reco_guardrail_same_brand_filtered',
        'reco_guardrail_on_page_filtered',
      ]),
    );
  });

  test('reco guardrail circuit can recover when a clean competitor payload arrives', () => {
    process.env.AURORA_BFF_RECO_GUARD_ENABLED = 'true';
    process.env.AURORA_BFF_RECO_GUARD_CIRCUIT_ENABLED = 'true';
    process.env.AURORA_BFF_RECO_GUARD_CIRCUIT_THRESHOLD = '1';
    process.env.AURORA_BFF_RECO_GUARD_CIRCUIT_COOLDOWN_MS = '600000';

    const { __internal } = require('../src/auroraBff/routes');
    const logger = { warn: jest.fn(), info: jest.fn() };

    const pollutedPayload = {
      assessment: { anchor_product: { brand_id: 'anchor_brand' } },
      competitors: {
        candidates: [
          {
            product_id: 'same_brand_1',
            brand_id: 'anchor_brand',
            name: 'Anchor Leakage',
            source: { type: 'catalog_search' },
            score_breakdown: { category_use_case_match: 0.8 },
            why_candidate: { summary: 'Leak', reasons_user_visible: ['category match'] },
          },
        ],
      },
      related_products: { candidates: [] },
      dupes: { candidates: [] },
      confidence_by_block: { competitors: { score: 0.6, level: 'med', reasons: ['baseline'] } },
      provenance: {
        generated_at: new Date().toISOString(),
        contract_version: 'aurora.product_intel.contract.v2',
        pipeline: 'reco_blocks_dag.v1',
        source: 'test',
        validation_mode: 'soft_fail',
      },
      missing_info_internal: [],
      missing_info: [],
    };
    const first = __internal.applyRecoGuardrailToProductAnalysisPayload(pollutedPayload, {
      logger,
      requestId: 'req_guard_circuit_1',
      mode: 'main_path',
    });
    expect(Array.isArray(first?.competitors?.candidates) ? first.competitors.candidates.length : 0).toBe(0);
    expect(first?.provenance?.guardrail_circuit_open).toBe(true);

    const cleanPayload = {
      assessment: { anchor_product: { brand_id: 'anchor_brand' } },
      competitors: {
        candidates: [
          {
            product_id: 'clean_1',
            brand_id: 'other_brand_1',
            name: 'Clean Candidate',
            source: { type: 'catalog_search' },
            score_breakdown: { category_use_case_match: 0.82 },
            why_candidate: { summary: 'Clean', reasons_user_visible: ['category match'] },
          },
        ],
      },
      related_products: { candidates: [] },
      dupes: { candidates: [] },
      confidence_by_block: { competitors: { score: 0.66, level: 'med', reasons: ['baseline'] } },
      provenance: {
        generated_at: new Date().toISOString(),
        contract_version: 'aurora.product_intel.contract.v2',
        pipeline: 'reco_blocks_dag.v1',
        source: 'test',
        validation_mode: 'soft_fail',
      },
      missing_info_internal: [],
      missing_info: [],
    };
    const second = __internal.applyRecoGuardrailToProductAnalysisPayload(cleanPayload, {
      logger,
      requestId: 'req_guard_circuit_2',
      mode: 'main_path',
    });
    expect(Array.isArray(second?.competitors?.candidates) ? second.competitors.candidates.length : 0).toBe(1);
    expect(second?.provenance?.guardrail_circuit_open).toBe(false);
    expect(second?.provenance?.auto_rollback_flag).toBe(false);
    expect(Array.isArray(second?.provenance?.guardrail_violations) ? second.provenance.guardrail_violations : []).not.toContain('circuit_open');

    const snap = __internal.getRecoGuardrailCircuitSnapshot('main_path');
    expect(snap.open).toBe(false);
  });

  test('/v1/product/analyze sanitizes polluted competitors from KB via runtime guardrail', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.AURORA_BFF_RECO_GUARD_ENABLED = 'true';
    process.env.AURORA_BFF_RECO_GUARD_CIRCUIT_ENABLED = 'false';

    const getProductIntelKbEntry = jest.fn().mockResolvedValue({
      kb_key: 'url:https://brand.example/guardrail-kb-hit.html|lang:EN',
      analysis: {
        assessment: {
          verdict: 'Likely Suitable',
          reasons: ['KB hit with polluted competitors.'],
          anchor_product: {
            brand_id: 'anchor_brand',
            brand: 'Anchor Brand',
            name: 'Anchor Serum',
            url: 'https://brand.example/guardrail-kb-hit.html',
          },
        },
        evidence: {
          science: { key_ingredients: ['Niacinamide'], mechanisms: [], fit_notes: [], risk_notes: [] },
          social_signals: { typical_positive: ['hydration'], typical_negative: [], risk_for_groups: [] },
          expert_notes: [],
          confidence: 0.73,
          missing_info: [],
        },
        confidence: 0.73,
        missing_info: ['url_realtime_product_intel_used'],
        competitors: {
          candidates: [
            {
              product_id: 'polluted_same_brand',
              brand_id: 'anchor_brand',
              brand: 'Anchor Brand',
              name: 'Anchor Leakage',
              source: { type: 'catalog_search' },
            },
            {
              product_id: 'polluted_on_page',
              brand_id: 'other_brand_1',
              brand: 'Other Brand 1',
              name: 'On-page Leakage',
              source: { type: 'on_page_related' },
            },
            {
              product_id: 'clean_competitor',
              brand_id: 'other_brand_2',
              brand: 'Other Brand 2',
              name: 'Clean Competitor',
              source: { type: 'catalog_search' },
            },
          ],
        },
      },
      source: expect.stringContaining('url_realtime_product_intel'),
      source_meta: { competitor_async_enriched: true },
    });
    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      normalizeKey: (key) => key,
      getProductIntelKbEntry,
      upsertProductIntelKbEntry,
    }));

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_kb_guardrail_1')
      .send({ url: 'https://brand.example/guardrail-kb-hit.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(Array.isArray(card.payload?.competitors?.candidates)).toBe(true);
    const competitors = card.payload.competitors.candidates || [];
    expect(competitors.length).toBe(0);
    expect(
      competitors.some((x) => String(x?.brand_id || x?.brand || '').toLowerCase() === 'anchor_brand'),
    ).toBe(false);
    expect(
      competitors.some((x) => String(x?.source?.type || '').toLowerCase() === 'on_page_related'),
    ).toBe(false);
    expect(typeof card.payload?.provenance?.guardrail_applied).toBe('boolean');
    expect(card.payload.internal_debug_codes).toBeUndefined();
    expect(card.payload.missing_info_internal).toBeUndefined();
  });

  test('competitor scoring rewards ingredient + skin-fit + social-reference alignment', () => {
    const { __internal } = require('../src/auroraBff/routes');

    const strong = __internal.scoreRealtimeCompetitorCandidate({
      queryOverlap: 2,
      ingredientNameOverlap: 2,
      sameCategory: true,
      sameBrand: false,
      anchorIngredientTokens: ['niacinamide', 'zinc', 'panthenol'],
      candidateIngredientTokens: ['niacinamide', 'zinc', 'panthenol', 'glycerin'],
      profileSkinTags: ['oily', 'sensitive', 'impaired_barrier'],
      candidateSkinTags: ['oily', 'sensitive'],
      candidateSocialScore: 0.82,
      candidateSocialSupportCount: 420,
      recallHitCount: 3,
      totalQueries: 3,
    });

    const weak = __internal.scoreRealtimeCompetitorCandidate({
      queryOverlap: 0,
      ingredientNameOverlap: 0,
      sameCategory: false,
      sameBrand: false,
      anchorIngredientTokens: ['niacinamide', 'zinc', 'panthenol'],
      candidateIngredientTokens: ['fragrance', 'alcohol'],
      profileSkinTags: ['oily', 'sensitive', 'impaired_barrier'],
      candidateSkinTags: ['dry'],
      candidateSocialScore: 0.35,
      candidateSocialSupportCount: 5,
      recallHitCount: 1,
      totalQueries: 3,
    });

    expect(strong.similarity_score).toBeGreaterThan(weak.similarity_score);
    expect(strong.score_breakdown.ingredient_similarity).toBeGreaterThan(weak.score_breakdown.ingredient_similarity);
    expect(strong.score_breakdown.skin_fit_similarity).toBeGreaterThan(weak.score_breakdown.skin_fit_similarity);
    expect(strong.score_breakdown.social_reference_score).toBeGreaterThan(weak.score_breakdown.social_reference_score);
  });

  test('/v1/product/parse keeps URL heuristic anchor and avoids forcing catalog id when trust is soft-blocked', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_INTEL_CATALOG_FALLBACK = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    nock('http://catalog.test')
      .post('/agent/v1/products/resolve')
      .reply(200, {
        resolved: true,
        product_ref: { product_id: 'p_catalog_1', merchant_id: 'm_catalog_1' },
        candidates: [
          {
            product_id: 'p_catalog_1',
            sku_id: 'sku_catalog_1',
            brand: 'The Ordinary',
            name: 'Multi-Peptide + Copper Peptides 1% Serum',
            display_name: 'The Ordinary Multi-Peptide + Copper Peptides 1% Serum',
          },
        ],
      });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/parse')
      .set('X-Aurora-UID', 'uid_test_catalog_fallback_1')
      .send({ url: 'https://theordinary.com/en-al/multi-peptide-copper-peptides-1-serum-100625.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_parse');
    expect(card).toBeTruthy();
    expect(card.payload.product).toBeTruthy();
    expect(card.payload.product.url).toContain('theordinary.com');
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).toContain('anchor_soft_blocked_ambiguous');
    expect(card.payload.missing_info).toContain('anchor_id_not_used_due_to_low_trust');
    expect(card.payload.parse_source).toBe('heuristic_url');
    expect(Array.isArray(card.payload.recovery_path)).toBe(true);
    expect(card.payload.recovery_path).toContain('heuristic_url');
  });

  test('/v1/product/analyze resolves anchor via catalog resolve fast-path before deep-scan', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_DECISION_BASE_URL = 'http://aurora.test';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.AURORA_BFF_PRODUCT_INTEL_CATALOG_FALLBACK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'false';

    let deepScanCalls = 0;
    nock('http://aurora.test')
      .persist()
      .post('/api/chat')
      .reply(200, (_uri, body) => {
        const query = typeof body?.query === 'string' ? body.query : '';
        if (/Task:\s*Parse\b/i.test(query)) {
          return {
            schema_version: 'aurora.chat.v1',
            intent: 'product',
            structured: {
              schema_version: 'aurora.structured.v1',
              parse: {
                normalized_query: query,
                parse_confidence: 0.4,
                normalized_query_language: 'en-US',
                anchor_product: {
                  brand: 'The Ordinary',
                  name: 'Multi Peptide Copper Peptides 1 Serum',
                },
              },
            },
          };
        }
        if (/Task:\s*Deep-scan\b/i.test(query)) {
          deepScanCalls += 1;
          expect(body.anchor_product_id).toBe('p_catalog_1');
          return {
            schema_version: 'aurora.chat.v1',
            intent: 'product',
            structured: {
              schema_version: 'aurora.structured.v1',
              parse: {
                normalized_query: query,
                parse_confidence: 0.9,
                normalized_query_language: 'en-US',
              },
              analyze: {
                verdict: 'Suitable',
                confidence: 0.86,
                reasons: ['Matched in catalog and analyzed via deep scan.'],
                science_evidence: {
                  key_ingredients: ['niacinamide'],
                  mechanisms: ['barrier support'],
                },
                social_signals: {
                  typical_positive: ['hydrating'],
                  typical_negative: ['sticky texture'],
                },
                expert_notes: ['Patch test if sensitive.'],
              },
            },
          };
        }
        return { schema_version: 'aurora.chat.v1', intent: 'chat', answer: 'stub' };
      });

    nock('http://catalog.test')
      .post('/agent/v1/products/resolve')
      .reply(200, {
        resolved: true,
        product_ref: { product_id: 'p_catalog_1', merchant_id: 'm_catalog_1' },
        candidates: [
          {
            product_id: 'p_catalog_1',
            sku_id: 'p_catalog_1',
            brand: 'The Ordinary',
            name: 'Multi Peptide Copper Peptides 1 Serum',
            display_name: 'The Ordinary Multi Peptide Copper Peptides 1 Serum',
          },
        ],
      });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_analyze_fast_anchor_1')
      .send({ url: 'https://theordinary.com/en-al/multi-peptide-copper-peptides-1-serum-100625.html' })
      .expect(200);

    expect(deepScanCalls).toBeGreaterThanOrEqual(1);
    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(card.payload.assessment.verdict).toBe('Suitable');
  });

  test('/v1/product/analyze fast-returns clear unknown when anchor cannot be resolved and fallback is disabled', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_DECISION_BASE_URL = 'http://aurora.test';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.AURORA_BFF_PRODUCT_INTEL_CATALOG_FALLBACK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'false';
    process.env.AURORA_RULE_RELAX_MODE = 'aggressive';
    process.env.AURORA_PRODUCT_GUARDRAIL_MODE = 'telemetry_only';
    process.env.AURORA_PRODUCT_STRICT_SKINCARE_FILTER = 'false';

    let deepScanCalls = 0;
    nock('http://aurora.test')
      .persist()
      .post('/api/chat')
      .reply(200, (_uri, body) => {
        const query = typeof body?.query === 'string' ? body.query : '';
        if (/Task:\s*Parse\b/i.test(query)) {
          return {
            schema_version: 'aurora.chat.v1',
            intent: 'product',
            structured: {
              schema_version: 'aurora.structured.v1',
              parse: {
                normalized_query: query,
                parse_confidence: 0.2,
                normalized_query_language: 'en-US',
                anchor_product: {
                  brand: 'Unknown Brand',
                  name: 'Unknown Product',
                },
              },
            },
          };
        }
        if (/Task:\s*Deep-scan\b/i.test(query)) {
          deepScanCalls += 1;
        }
        return { schema_version: 'aurora.chat.v1', intent: 'chat', answer: 'stub' };
      });

    nock('http://catalog.test')
      .persist()
      .post('/agent/v1/products/resolve')
      .reply(200, {
        resolved: false,
        reason_code: 'no_candidates',
        candidates: [],
      });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_analyze_fast_unknown_1')
      .send({
        url: 'https://example.com/non-catalog-product.html',
        session: {
          session_id: 'sess_fast_unknown',
          state: 'idle',
          trace_hint: 'schema_passthrough_check',
        },
      })
      .expect(200);

    expect(deepScanCalls).toBe(1);
    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(String(card.payload.assessment?.verdict || '')).toMatch(/Unknown|未知/);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).toContain('product_not_resolved');
    expect(Array.isArray(card.payload.assessment?.reasons)).toBe(true);
    expect(card.payload.assessment.reasons.join(' ')).toMatch(/no-anchor deep scan|无锚点 Deep Scan/i);
    expect(card.payload.low_confidence).toBe(true);
    expect(card.payload.low_relevance).toBe(true);
    expect(card.payload.internal_debug_codes).toBeUndefined();
    expect(card.payload.missing_info_internal).toBeUndefined();
  });

  test('/v1/product/analyze runs realtime URL product-intel first and backfills KB asynchronously', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.AURORA_BFF_PRODUCT_INTEL_KB_ASYNC_BACKFILL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_ASYNC_ENRICH = 'true';
    process.env.AURORA_DECISION_BASE_URL = 'http://aurora.test';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    const getProductIntelKbEntry = jest.fn().mockResolvedValue(null);
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      normalizeKey: (key) => key,
      getProductIntelKbEntry,
      upsertProductIntelKbEntry,
    }));

    let auroraCalls = 0;
    nock('http://aurora.test')
      .persist()
      .post('/api/chat')
      .reply(200, () => {
        auroraCalls += 1;
        return { schema_version: 'aurora.chat.v1', intent: 'chat', answer: 'stub' };
      });

    nock('https://brand.example')
      .get('/product-1.html')
      .reply(
        200,
        `<!doctype html><html><head><title>Multi-Peptide + Copper Peptides 1% | The Ordinary</title></head>
         <body>
           <div class="title">Ingredients</div>
           <p class="ingredients-flyout-content" data-original-ingredients="Aqua (Water), Glycerin, Copper Tripeptide-1, Acetyl Hexapeptide-8, Sodium Hyaluronate, Allantoin, Butylene Glycol, Phenoxyethanol"></p>
           <span class="title">Key ingredients</span>
           <div class="list">Copper Tripeptide-1, Acetyl Hexapeptide-8, Sodium Hyaluronate</div>
           <div class="reviews">Hydrating and lightweight texture. Some users report pilling.</div>
           <script type="application/ld+json">
             {"aggregateRating":{"ratingValue":"4.4","reviewCount":"518"}}
           </script>
           <script type="application/ld+json">
             {"@context":"http://schema.org","@type":"Product","name":"Multi-Peptide + Copper Peptides 1%","offers":{"@type":"Offer","price":"35.30","priceCurrency":"EUR"}}
           </script>
         </body></html>`,
        { 'Content-Type': 'text/html' },
      );

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        products: [
          {
            product_id: 'comp_1',
            sku_id: 'comp_1',
            brand: 'Good Molecules',
            name: 'Super Peptide Serum',
            display_name: 'Good Molecules Super Peptide Serum',
          },
          {
            product_id: 'comp_2',
            sku_id: 'comp_2',
            brand: 'Geek & Gorgeous',
            name: 'Peptide Hydration Serum',
            display_name: 'Geek & Gorgeous Peptide Hydration Serum',
          },
        ],
      });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_ingredient_1')
      .send({ url: 'https://brand.example/product-1.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(card.payload.assessment).toBeTruthy();
    expect(card.payload.assessment.verdict).toMatch(/Likely Suitable|Caution|较适配|谨慎/);
    expect(Array.isArray(card.payload.evidence?.science?.key_ingredients)).toBe(true);
    expect(card.payload.evidence.science.key_ingredients).toEqual(
      expect.arrayContaining(['Copper Tripeptide-1']),
    );
    expect(Array.isArray(card.payload.evidence?.social_signals?.typical_positive)).toBe(true);
    expect(card.payload.evidence.social_signals.typical_positive.length).toBeGreaterThan(0);
    expect(card.payload.assessment.anchor_product.price).toEqual(
      expect.objectContaining({ amount: 35.3, currency: 'EUR', unknown: false }),
    );
    expect(Array.isArray(card.payload.competitors?.candidates)).toBe(true);
    const competitorNames = (card.payload.competitors.candidates || []).map((x) => String(x?.name || '').toLowerCase());
    const onPageCount = (card.payload.competitors.candidates || []).filter(
      (x) => String(x?.source?.type || '').toLowerCase() === 'on_page_related',
    ).length;
    expect(onPageCount).toBe(0);
    expect(competitorNames.some((n) => n.includes('the ordinary'))).toBe(false);
    expect(auroraCalls).toBe(0);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).not.toContain('ingredient_concentration_unknown');
    expect(card.payload.missing_info).not.toContain('profile_not_provided');
    expect(card.payload.profile_prompt).toEqual(
      expect.objectContaining({
        needed: true,
        cta_action: 'open_profile',
      }),
    );
    expect(Array.isArray(card.payload.profile_prompt.missing_fields)).toBe(true);
    expect(card.payload.profile_prompt.missing_fields).toEqual(
      expect.arrayContaining(['skinType', 'sensitivity', 'barrierStatus']),
    );
    expect(card.payload.missing_info).not.toEqual(
      expect.arrayContaining(['upstream_analysis_missing', 'url_ingredient_analysis_used', 'url_realtime_product_intel_used']),
    );
    expect(card.payload.internal_debug_codes).toBeUndefined();
    expect(card.payload.missing_info_internal).toBeUndefined();
    expect(card.payload.product_intel_contract_version).toBe('aurora.product_intel.contract.v2');

    await new Promise((resolve) => setImmediate(resolve));
    expect(upsertProductIntelKbEntry).toHaveBeenCalledTimes(1);
    expect(upsertProductIntelKbEntry.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        source: expect.stringContaining('url_realtime_product_intel'),
        kb_key: expect.any(String),
      }),
    );
  });

  test('/v1/product/analyze retries URL fetch with fallback strategy when default profile is blocked', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    nock('https://brand.example')
      .get('/product-fallback-ua.html')
      .matchHeader('User-Agent', (value) => !/curl\/8/i.test(String(value || '')))
      .reply(403, 'blocked by waf');

    nock('https://brand.example')
      .get('/product-fallback-ua.html')
      .matchHeader('User-Agent', /curl\/8/i)
      .reply(
        200,
        `<!doctype html><html><head><title>Defense Lotion SPF 35 | Lab</title></head>
         <body>
           <p class="ingredients-flyout-content" data-original-ingredients="Avobenzone 3%, Homosalate 7%, Octisalate 5%, Octocrylene 10%, Oxybenzone 6%, Glycerin, Squalane, Sodium Hyaluronate"></p>
           <div class="reviews">Hydrating texture and comfortable finish.</div>
         </body></html>`,
        { 'Content-Type': 'text/html' },
      );

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        products: [
          {
            product_id: 'comp_fallback_1',
            sku_id: 'comp_fallback_1',
            brand: 'Alt Brand',
            name: 'Daily Defense SPF Lotion',
            display_name: 'Alt Brand Daily Defense SPF Lotion',
          },
        ],
      });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_fetch_fallback_1')
      .send({ url: 'https://brand.example/product-fallback-ua.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).toContain('url_fetch_recovered_with_fallback');
    expect(card.payload.provenance?.url_fetch?.final_strategy).toBe('curl_ua');
    expect(Array.isArray(card.payload.evidence?.sources)).toBe(true);
    expect(card.payload.evidence.sources.some((x) => String(x?.type || '') === 'official_page')).toBe(true);
  });

  test('/v1/product/analyze returns diagnosable degraded payload when URL fetch is blocked end-to-end', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    nock('https://brand.example')
      .persist()
      .get('/blocked-all.html')
      .reply(403, 'blocked');
    nock('https://www.brand.example')
      .persist()
      .get('/blocked-all.html')
      .reply(403, 'blocked');
    nock('https://dailymed.nlm.nih.gov')
      .get('/dailymed/search.cfm')
      .query(true)
      .reply(200, '<html><body>No results</body></html>', { 'Content-Type': 'text/html' });

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, { products: [] });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_fetch_blocked_1')
      .send({ url: 'https://brand.example/blocked-all.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(String(card.payload.assessment?.verdict || '')).toMatch(/Unknown|未知/);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).toContain('url_fetch_forbidden_403');
    expect(card.payload.missing_info).toContain('on_page_fetch_blocked');
    expect(card.payload.provenance?.url_fetch?.failure_code).toBe('url_fetch_forbidden_403');
    expect(Array.isArray(card.payload.assessment?.reasons)).toBe(true);
    expect(card.payload.assessment.reasons.join(' ')).toMatch(/INCI|official page|官方页面/i);
  });

  test('/v1/product/analyze uses regulatory source when official page is blocked', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    nock('https://brand.example')
      .persist()
      .get('/blocked-with-regulatory.html')
      .reply(403, 'blocked');
    nock('https://www.brand.example')
      .persist()
      .get('/blocked-with-regulatory.html')
      .reply(403, 'blocked');

    nock('https://dailymed.nlm.nih.gov')
      .get('/dailymed/search.cfm')
      .query(true)
      .reply(
        200,
        '<html><body><a href="/dailymed/drugInfo.cfm?setid=abc123">LAB SERIES DAY RESCUE</a></body></html>',
        { 'Content-Type': 'text/html' },
      );
    nock('https://dailymed.nlm.nih.gov')
      .get('/dailymed/drugInfo.cfm')
      .query({ setid: 'abc123' })
      .reply(
        200,
        '<html><body>Active ingredients Avobenzone 3%, Oxybenzone 6%, Octocrylene 10%. Uses Sunscreen.</body></html>',
        { 'Content-Type': 'text/html' },
      );

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, { products: [] });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_regulatory_1')
      .send({ url: 'https://brand.example/blocked-with-regulatory.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(String(card.payload.assessment?.verdict || '')).not.toMatch(/Unknown|未知/);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).toContain('regulatory_source_used');
    expect(card.payload.missing_info).toContain('version_verification_needed');
    expect(Array.isArray(card.payload.evidence?.sources)).toBe(true);
    expect(card.payload.evidence.sources.some((x) => String(x?.type || '') === 'regulatory')).toBe(true);
  });

  test('/v1/product/analyze schedules async competitor enrich when first-pass competitor recall fails', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.AURORA_BFF_PRODUCT_INTEL_KB_ASYNC_BACKFILL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_ASYNC_ENRICH = 'true';
    process.env.AURORA_DECISION_BASE_URL = 'http://aurora.test';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    const getProductIntelKbEntry = jest.fn().mockResolvedValue(null);
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      normalizeKey: (key) => key,
      getProductIntelKbEntry,
      upsertProductIntelKbEntry,
    }));

    nock('http://aurora.test')
      .persist()
      .post('/api/chat')
      .reply(200, { schema_version: 'aurora.chat.v1', intent: 'chat', answer: 'stub' });

    nock('https://brand.example')
      .get('/product-2.html')
      .reply(
        200,
        `<!doctype html><html><head><title>Peptide Serum | Brand</title></head>
         <body>
           <p class="ingredients-flyout-content" data-original-ingredients="Aqua (Water), Glycerin, Copper Tripeptide-1, Sodium Hyaluronate, Allantoin"></p>
           <div class="reviews">Hydrating texture. Lightweight finish.</div>
         </body></html>`,
        { 'Content-Type': 'text/html' },
      );

    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query(true)
      .times(2)
      .delayConnection(1500)
      .reply(200, { products: [] });

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        products: [
          {
            product_id: 'async_comp_1',
            sku_id: 'async_comp_1',
            brand: 'Brand B',
            name: 'Peptide Lift Serum',
            display_name: 'Brand B Peptide Lift Serum',
          },
        ],
      });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_ingredient_async_comp_1')
      .send({ url: 'https://brand.example/product-2.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).not.toContain('alternatives_limited');
    expect(card.payload.missing_info).toContain('analysis_in_progress');
    expect(card.payload.internal_debug_codes).toBeUndefined();
    expect(card.payload.missing_info_internal).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(upsertProductIntelKbEntry.mock.calls.length).toBeGreaterThanOrEqual(1);
    const lastWrite = upsertProductIntelKbEntry.mock.calls[upsertProductIntelKbEntry.mock.calls.length - 1][0];
    expect(lastWrite).toEqual(
      expect.objectContaining({
        source: expect.stringContaining('url_realtime_product_intel'),
      }),
    );
    expect(lastWrite.source_meta).toEqual(expect.objectContaining({ competitor_async_enriched: true }));
    expect(Array.isArray(lastWrite.analysis?.competitors?.candidates)).toBe(true);
    expect(lastWrite.analysis.competitors.candidates.length).toBeGreaterThan(0);
  });

  test('/v1/product/analyze serves URL product-intel from KB when competitor enrichment is already available', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    const getProductIntelKbEntry = jest.fn().mockResolvedValue({
      kb_key: 'url:https://brand.example/product-3.html|lang:EN',
      analysis: {
        assessment: {
          verdict: 'Likely Suitable',
          reasons: ['Backfilled competitor set is available.'],
        },
        evidence: {
          science: { key_ingredients: ['Copper Tripeptide-1'], mechanisms: [], fit_notes: [], risk_notes: [] },
          social_signals: { typical_positive: ['hydration'], typical_negative: [], risk_for_groups: [] },
          expert_notes: ['competitor backfill complete'],
          confidence: 0.73,
          missing_info: [],
        },
        confidence: 0.73,
        missing_info: ['url_realtime_product_intel_used'],
        competitors: {
          candidates: [
            {
              product_id: 'kb_comp_1',
              brand: 'Brand C',
              name: 'Peptide Repair Serum',
              similarity_score: 0.82,
              why_candidate: ['same category'],
            },
          ],
        },
      },
      source: expect.stringContaining('url_realtime_product_intel'),
      source_meta: { competitor_async_enriched: true },
    });
    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      normalizeKey: (key) => key,
      getProductIntelKbEntry,
      upsertProductIntelKbEntry,
    }));

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_intel_kb_hit_1')
      .send({ url: 'https://brand.example/product-3.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(Array.isArray(card.payload?.competitors?.candidates)).toBe(true);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(getProductIntelKbEntry).toHaveBeenCalled();
    expect(upsertProductIntelKbEntry).not.toHaveBeenCalled();
  });

  test('/v1/product/analyze sync-repairs low-coverage KB competitors before returning', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    const getProductIntelKbEntry = jest.fn().mockResolvedValue({
      kb_key: 'url:https://brand.example/product-7.html|lang:EN',
      analysis: {
        assessment: {
          verdict: 'Likely Suitable',
          reasons: ['KB hit with low competitor coverage.'],
          anchor_product: {
            brand: 'The Ordinary',
            name: 'Multi-Peptide + Copper Peptides 1% Serum',
            display_name: 'The Ordinary Multi-Peptide + Copper Peptides 1% Serum',
            url: 'https://brand.example/product-7.html',
          },
        },
        evidence: {
          science: { key_ingredients: ['Copper Tripeptide-1', 'Sodium Hyaluronate'], mechanisms: [], fit_notes: [], risk_notes: [] },
          social_signals: { typical_positive: ['hydration'], typical_negative: [], risk_for_groups: [] },
          expert_notes: ['kb low coverage'],
          confidence: 0.71,
          missing_info: ['competitors_low_coverage'],
        },
        confidence: 0.71,
        missing_info: ['url_realtime_product_intel_used', 'competitors_low_coverage'],
        competitors: {
          candidates: [
            {
              product_id: 'kb_only_1',
              brand: 'The Ordinary',
              name: 'Ultra-lightweight hydration Rice Lipids + Ectoin Microemulsion',
              similarity_score: 0.45,
              why_candidate: ['related product link found on the same product page'],
            },
          ],
        },
      },
      source: expect.stringContaining('url_realtime_product_intel'),
      source_meta: { competitor_async_enriched: true },
    });
    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      normalizeKey: (key) => key,
      getProductIntelKbEntry,
      upsertProductIntelKbEntry,
    }));

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        products: [
          {
            product_id: 'sync_comp_1',
            sku_id: 'sync_comp_1',
            brand: 'Brand Sync',
            name: 'Copper Peptide Serum',
            display_name: 'Brand Sync Copper Peptide Serum',
            key_ingredients: ['Copper Tripeptide-1', 'Sodium Hyaluronate'],
            skin_types: ['oily', 'sensitive'],
            social_stats: { platform_scores: { Reddit: 0.76 }, mention_count: 180 },
          },
          {
            product_id: 'sync_comp_2',
            sku_id: 'sync_comp_2',
            brand: 'Brand Repair',
            name: 'Barrier Support Peptide Serum',
            display_name: 'Brand Repair Barrier Support Peptide Serum',
            key_ingredients: ['Panthenol', 'Copper Tripeptide-1'],
            skin_types: ['sensitive', 'impaired_barrier'],
            social_stats: { platform_scores: { TikTok: 0.72 }, mention_count: 120 },
          },
        ],
      });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_intel_kb_sync_repair_1')
      .send({ url: 'https://brand.example/product-7.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(Array.isArray(card.payload?.competitors?.candidates)).toBe(true);
    const competitors = Array.isArray(card.payload?.competitors?.candidates) ? card.payload.competitors.candidates : [];
    expect(
      competitors.some((x) => String(x?.source?.type || '').toLowerCase() === 'on_page_related'),
    ).toBe(false);
    expect(
      competitors.some((x) => String(x?.brand || '').toLowerCase() === 'the ordinary'),
    ).toBe(false);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).not.toContain('competitors_low_coverage');

    const valueMomentMode = Array.isArray(res.body.events)
      ? (res.body.events.find((e) => e && e.event_name === 'value_moment')?.data?.mode || '')
      : '';
    expect(typeof valueMomentMode).toBe('string');

    await new Promise((resolve) => setImmediate(resolve));
  });

  test('/v1/product/analyze drops legacy aurora_alternatives KB competitors and rebuilds from catalog recall', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.AURORA_BFF_PRODUCT_INTEL_KB_ASYNC_BACKFILL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_ASYNC_ENRICH = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    const getProductIntelKbEntry = jest.fn().mockResolvedValue({
      kb_key: 'url:https://brand.example/product-legacy.html|lang:EN',
      analysis: {
        assessment: {
          verdict: 'Likely Suitable',
          reasons: ['legacy kb competitor source present'],
          anchor_product: {
            brand: 'The Ordinary',
            name: 'Multi-Peptide + Copper Peptides 1% Serum',
            category: 'serum',
            url: 'https://brand.example/product-legacy.html',
          },
        },
        evidence: {
          science: { key_ingredients: ['Copper Tripeptide-1'], mechanisms: [], fit_notes: [], risk_notes: [] },
          social_signals: { typical_positive: ['hydration'], typical_negative: [], risk_for_groups: [] },
          expert_notes: ['legacy kb snapshot'],
          confidence: 0.62,
          missing_info: [],
        },
        confidence: 0.62,
        missing_info: ['url_realtime_product_intel_used', 'competitor_sync_aurora_fallback_used'],
        competitors: {
          candidates: [
            {
              product_id: 'legacy_alt_1',
              brand: 'The Ordinary',
              name: 'Legacy Alternative Candidate',
              similarity_score: 0.78,
              source: { type: 'aurora_alternatives' },
              why_candidate: ['legacy fallback'],
            },
          ],
        },
      },
      source: expect.stringContaining('url_realtime_product_intel'),
      source_meta: { competitor_async_enriched: true },
    });
    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      normalizeKey: (key) => key,
      getProductIntelKbEntry,
      upsertProductIntelKbEntry,
    }));

    nock('https://brand.example')
      .persist()
      .get('/product-legacy.html')
      .reply(
        200,
        `<!doctype html><html><head><title>Peptide Serum | Brand</title></head>
         <body>
           <p class="ingredients-flyout-content" data-original-ingredients="Aqua, Glycerin, Copper Tripeptide-1, Sodium Hyaluronate"></p>
         </body></html>`,
        { 'Content-Type': 'text/html' },
      );

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        products: [
          {
            product_id: 'fresh_comp_1',
            sku_id: 'fresh_comp_1',
            brand: 'Brand Fresh',
            name: 'Copper Peptide Repair Serum',
            category: 'serum',
            key_ingredients: ['Copper Tripeptide-1', 'Sodium Hyaluronate'],
          },
        ],
      });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_intel_kb_legacy_source_1')
      .send({ url: 'https://brand.example/product-legacy.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    const competitors = Array.isArray(card.payload?.competitors?.candidates) ? card.payload.competitors.candidates : [];
    expect(
      competitors.some((x) => String(x?.source?.type || '').toLowerCase() === 'aurora_alternatives'),
    ).toBe(false);
    expect(
      competitors.some((x) => String(x?.source?.type || '').toLowerCase() === 'on_page_related'),
    ).toBe(false);
    expect(card.payload.missing_info).not.toContain('alternatives_limited');
    expect(card.payload.missing_info).not.toContain('competitor_sync_aurora_fallback_used');
    expect(card.payload.missing_info).toContain('analysis_in_progress');
    await new Promise((resolve) => setImmediate(resolve));
    expect(upsertProductIntelKbEntry).toHaveBeenCalled();
  });

  test('/v1/product/analyze routes on-page fallback into related_products when catalog recall is unavailable', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.AURORA_BFF_PRODUCT_INTEL_KB_ASYNC_BACKFILL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_ASYNC_ENRICH = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    const getProductIntelKbEntry = jest.fn().mockResolvedValue({
      kb_key: 'url:https://brand.example/product-8.html|lang:EN',
      analysis: {
        assessment: {
          verdict: 'Likely Suitable',
          reasons: ['KB hit with low competitor coverage.'],
          anchor_product: {
            brand: 'The Ordinary',
            name: 'Multi-Peptide + Copper Peptides 1% Serum',
            display_name: 'The Ordinary Multi-Peptide + Copper Peptides 1% Serum',
            url: 'https://brand.example/product-8.html',
          },
        },
        evidence: {
          science: { key_ingredients: ['Copper Tripeptide-1', 'Sodium Hyaluronate'], mechanisms: [], fit_notes: [], risk_notes: [] },
          social_signals: { typical_positive: ['hydration'], typical_negative: [], risk_for_groups: [] },
          expert_notes: ['kb low coverage'],
          confidence: 0.7,
          missing_info: ['competitors_low_coverage'],
        },
        confidence: 0.7,
        missing_info: ['url_realtime_product_intel_used', 'competitors_low_coverage'],
        competitors: {
          candidates: [
            {
              product_id: 'kb_only_8_1',
              brand: 'The Ordinary',
              name: 'Ultra-lightweight hydration Rice Lipids + Ectoin Microemulsion',
              similarity_score: 0.45,
              why_candidate: ['related product link found on the same product page'],
            },
          ],
        },
      },
      source: expect.stringContaining('url_realtime_product_intel'),
      source_meta: { competitor_async_enriched: true },
    });
    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      normalizeKey: (key) => key,
      getProductIntelKbEntry,
      upsertProductIntelKbEntry,
    }));

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(503, { error: 'temporary unavailable' });

    nock('http://catalog.test')
      .persist()
      .post('/agent/v1/products/resolve')
      .reply(503, { error: 'temporary unavailable' });

    nock('https://brand.example')
      .persist()
      .get('/product-8.html')
      .reply(
        200,
        `<!doctype html><html><head><title>Peptide Serum | Brand</title></head>
         <body>
           <a href="#main-content">Skip to main content</a>
           <a href="/contact-us">Contact Us</a>
           <a href="/en-al/multi-peptide-eye-serum-100700.html">Multi-Peptide Eye Serum</a>
           <a href="/en-al/hyaluronic-acid-2-b5-100426.html">Hyaluronic Acid 2% + B5</a>
           <a href="/en-al/multi-active-delivery-essence-100612.html">Multi-Active Delivery Essence</a>
           <a href="/en-al/aloe-2-nag-2-solution-serum-100618.html">Aloe 2% + NAG 2% Solution</a>
         </body></html>`,
        { 'Content-Type': 'text/html' },
      );

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_intel_kb_sync_onpage_1')
      .send({ url: 'https://brand.example/product-8.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(Array.isArray(card.payload?.competitors?.candidates) ? card.payload.competitors.candidates.length : 0).toBe(0);
    const related = Array.isArray(card.payload?.related_products?.candidates) ? card.payload.related_products.candidates : [];
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).not.toContain('alternatives_unavailable');
    const names = related.map((x) => String(x?.name || '').toLowerCase());
    if (related.length) {
      expect(names.some((n) => n.includes('multi-peptide eye serum') || n.includes('hyaluronic acid'))).toBe(true);
      expect(names.some((n) => n.includes('skip to main content'))).toBe(false);
    }

    const valueMomentMode = Array.isArray(res.body.events)
      ? (res.body.events.find((e) => e && e.event_name === 'value_moment')?.data?.mode || '')
      : '';
    expect(typeof valueMomentMode).toBe('string');

    await new Promise((resolve) => setImmediate(resolve));
    expect(upsertProductIntelKbEntry.mock.calls.length).toBeGreaterThan(0);
  });

  test('/v1/product/analyze keeps competitors clean when catalog_ann times out and on-page fallback exists', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.AURORA_BFF_RECO_BLOCKS_TIMEOUT_CATALOG_ANN_MS = '45';
    process.env.AURORA_BFF_RECO_BLOCKS_BUDGET_MS = '240';

    const getProductIntelKbEntry = jest.fn().mockResolvedValue(null);
    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      normalizeKey: (key) => key,
      getProductIntelKbEntry,
      upsertProductIntelKbEntry,
    }));

    nock('https://brand.example')
      .get('/product-timeout.html')
      .reply(
        200,
        `<!doctype html><html><head><title>Peptide Serum | Brand</title></head>
         <body>
           <a href="/en-al/multi-peptide-eye-serum-100700.html">Multi-Peptide Eye Serum</a>
           <a href="/en-al/hyaluronic-acid-2-b5-100426.html">Hyaluronic Acid 2% + B5</a>
           <p class="ingredients-flyout-content" data-original-ingredients="Aqua (Water), Glycerin, Copper Tripeptide-1, Sodium Hyaluronate, Allantoin"></p>
         </body></html>`,
        { 'Content-Type': 'text/html' },
      );

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .delayConnection(400)
      .reply(200, {
        products: [
          {
            product_id: 'should_timeout_comp',
            sku_id: 'should_timeout_comp',
            brand: 'Brand Timeout',
            name: 'Late Peptide Serum',
            display_name: 'Brand Timeout Late Peptide Serum',
          },
        ],
      });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_intel_timeout_on_page_1')
      .send({ url: 'https://brand.example/product-timeout.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    const competitors = Array.isArray(card.payload?.competitors?.candidates) ? card.payload.competitors.candidates : [];
    const related = Array.isArray(card.payload?.related_products?.candidates) ? card.payload.related_products.candidates : [];
    expect(
      competitors.some((x) => String(x?.source?.type || '').toLowerCase() === 'on_page_related'),
    ).toBe(false);
    expect(
      related.some((x) => String(x?.source?.type || '').toLowerCase() === 'on_page_related'),
    ).toBe(true);
    expect(Array.isArray(card.payload?.provenance?.timed_out_blocks)).toBe(true);
    const timedOutBlocks = Array.isArray(card.payload?.provenance?.timed_out_blocks)
      ? card.payload.provenance.timed_out_blocks
      : [];
    const fallbacksUsed = Array.isArray(card.payload?.provenance?.fallbacks_used)
      ? card.payload.provenance.fallbacks_used
      : [];
    expect(
      timedOutBlocks.includes('catalog_ann') ||
        fallbacksUsed.includes('fast_ann_competitors') ||
        competitors.length > 0,
    ).toBe(true);
    expect(Array.isArray(card.payload?.missing_info)).toBe(true);
    const internalMissing = card.payload.missing_info.filter((token) =>
      /^(reco_dag_|url_|upstream_|internal_|router\.|skin_fit\.profile\.)/i.test(String(token || '')),
    );
    expect(internalMissing).toEqual([]);
  });

  test('/v1/product/analyze allows empty competitors and lowers confidence when all competitor recall fails', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    const getProductIntelKbEntry = jest.fn().mockResolvedValue(null);
    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      normalizeKey: (key) => key,
      getProductIntelKbEntry,
      upsertProductIntelKbEntry,
    }));

    nock('https://brand.example')
      .get('/product-no-recall.html')
      .reply(
        200,
        `<!doctype html><html><head><title>Peptide Serum | Brand</title></head>
         <body>
           <p class="ingredients-flyout-content" data-original-ingredients="Aqua (Water), Glycerin, Copper Tripeptide-1, Sodium Hyaluronate, Allantoin"></p>
           <div class="reviews">Hydrating texture. Lightweight finish.</div>
         </body></html>`,
        { 'Content-Type': 'text/html' },
      );

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(503, { error: 'temporary unavailable' });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_intel_comp_all_fail_1')
      .send({ url: 'https://brand.example/product-no-recall.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    const competitors = Array.isArray(card.payload?.competitors?.candidates) ? card.payload.competitors.candidates : [];
    expect(competitors.length).toBe(0);
    expect(Array.isArray(card.payload?.provenance?.fallbacks_used)).toBe(true);
    expect(card.payload.provenance.fallbacks_used).toEqual(
      expect.arrayContaining(['kb_or_cache_competitors', 'fast_ann_competitors']),
    );
    expect(card.payload?.confidence_by_block?.competitors?.level).toBe('low');
  });

  test('/v1/product/analyze async competitor enrich does not inject aurora alternatives into competitors', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.AURORA_BFF_PRODUCT_INTEL_KB_ASYNC_BACKFILL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_ASYNC_ENRICH = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    const getProductIntelKbEntry = jest.fn().mockResolvedValue(null);
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      normalizeKey: (key) => key,
      getProductIntelKbEntry,
      upsertProductIntelKbEntry,
    }));

    nock('https://brand.example')
      .persist()
      .get('/product-4.html')
      .reply(
        200,
        `<!doctype html><html><head><title>Peptide Serum | Brand</title></head>
         <body>
           <a href="/en-al/multi-peptide-eye-serum-100700.html">Multi-Peptide Eye Serum</a>
           <a href="/en-al/hyaluronic-acid-2-b5-100426.html">Hyaluronic Acid 2% + B5</a>
           <p class="ingredients-flyout-content" data-original-ingredients="Aqua (Water), Glycerin, Copper Tripeptide-1, Sodium Hyaluronate, Allantoin"></p>
           <div class="reviews">Hydrating texture. Lightweight finish.</div>
         </body></html>`,
        { 'Content-Type': 'text/html' },
      );

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(503, { error: 'temporary unavailable' });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_ingredient_async_comp_fallback_1')
      .send({ url: 'https://brand.example/product-4.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).not.toContain('alternatives_unavailable');
    expect(card.payload.internal_debug_codes).toBeUndefined();
    expect(card.payload.missing_info_internal).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(upsertProductIntelKbEntry.mock.calls.length).toBeGreaterThanOrEqual(2);
    const lastWrite = upsertProductIntelKbEntry.mock.calls[upsertProductIntelKbEntry.mock.calls.length - 1][0];
    expect(lastWrite.source_meta).toEqual(
      expect.objectContaining({
        competitor_async_enriched: true,
        competitor_async_source: 'reco_blocks_dag',
      }),
    );
    const competitors = Array.isArray(lastWrite.analysis?.competitors?.candidates) ? lastWrite.analysis.competitors.candidates : [];
    const related = Array.isArray(lastWrite.analysis?.related_products?.candidates) ? lastWrite.analysis.related_products.candidates : [];
    expect(competitors.length).toBe(0);
    expect(
      competitors.some((x) => String(x?.source?.type || '').toLowerCase() === 'aurora_alternatives'),
    ).toBe(false);
    expect(
      competitors.some((x) => String(x?.source?.type || '').toLowerCase() === 'on_page_related'),
    ).toBe(false);
    expect(related.length).toBeGreaterThanOrEqual(1);
  });

  test('/v1/product/analyze filters nav links and routes on-page related products away from competitors', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    const getProductIntelKbEntry = jest.fn().mockResolvedValue(null);
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      normalizeKey: (key) => key,
      getProductIntelKbEntry,
      upsertProductIntelKbEntry,
    }));

    nock('https://brand.example')
      .get('/product-5.html')
      .reply(
        200,
        `<!doctype html><html><head><title>Peptide Serum | Brand</title></head>
         <body>
           <a href="#main-content">Skip to main content</a>
           <a href="/contact-us">Contact Us</a>
           <a href="/en-al/multi-peptide-eye-serum-100700.html">Multi-Peptide Eye Serum</a>
           <a href="/en-al/hyaluronic-acid-2-b5-100426.html">Hyaluronic Acid 2% + B5</a>
           <p class="ingredients-flyout-content" data-original-ingredients="Aqua (Water), Glycerin, Copper Tripeptide-1, Sodium Hyaluronate, Allantoin"></p>
         </body></html>`,
        { 'Content-Type': 'text/html' },
      );

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(503, { error: 'temporary unavailable' });

    nock('http://catalog.test')
      .persist()
      .post('/agent/v1/products/resolve')
      .reply(503, { error: 'temporary unavailable' });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_ingredient_on_page_comp_1')
      .send({ url: 'https://brand.example/product-5.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    const competitors = Array.isArray(card.payload?.competitors?.candidates) ? card.payload.competitors.candidates : [];
    const related = Array.isArray(card.payload?.related_products?.candidates) ? card.payload.related_products.candidates : [];
    expect(competitors.length).toBe(0);
    expect(related.length).toBeGreaterThan(0);
    const names = related.map((x) => String(x?.name || '').toLowerCase());
    expect(names.some((n) => n.includes('multi-peptide eye serum') || n.includes('hyaluronic acid'))).toBe(true);
    expect(names.some((n) => n.includes('skip to main content'))).toBe(false);
    expect(names.some((n) => n.includes('contact us'))).toBe(false);
    const first = related[0] || {};
    expect(first.score_breakdown && typeof first.score_breakdown).toBe('object');
    expect(typeof first.score_breakdown.category_use_case_match).toBe('number');
    expect(typeof first.score_breakdown.skin_fit_similarity).toBe('number');
    expect(first.why_candidate && typeof first.why_candidate).toBe('object');
    expect(typeof first.why_candidate.summary).toBe('string');
    expect(Array.isArray(first.why_candidate.reasons_user_visible)).toBe(true);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).not.toContain('alternatives_unavailable');
  });

  test('/v1/product/analyze ignores stale KB competitor noise and keeps on-page links in related_products', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';

    const getProductIntelKbEntry = jest.fn().mockResolvedValue({
      kb_key: 'url:https://brand.example/product-6.html|lang:EN',
      analysis: {
        assessment: { verdict: 'Likely Suitable', reasons: ['kb entry'] },
        evidence: {
          science: { key_ingredients: ['Copper Tripeptide-1'], mechanisms: [], fit_notes: [], risk_notes: [] },
          social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
          expert_notes: [],
          confidence: 0.7,
          missing_info: [],
        },
        confidence: 0.7,
        missing_info: ['url_realtime_product_intel_used'],
        competitors: {
          candidates: [
            { name: 'Skip to main content' },
            { name: 'Contact Us' },
          ],
        },
      },
      source: expect.stringContaining('url_realtime_product_intel'),
      source_meta: { competitor_async_enriched: true },
    });
    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      normalizeKey: (key) => key,
      getProductIntelKbEntry,
      upsertProductIntelKbEntry,
    }));

    nock('https://brand.example')
      .get('/product-6.html')
      .reply(
        200,
        `<!doctype html><html><head><title>Peptide Serum | Brand</title></head>
         <body>
           <a href="#main-content">Skip to main content</a>
           <a href="/en-al/multi-peptide-eye-serum-100700.html">Multi-Peptide Eye Serum</a>
           <p class="ingredients-flyout-content" data-original-ingredients="Aqua (Water), Glycerin, Copper Tripeptide-1, Sodium Hyaluronate, Allantoin"></p>
         </body></html>`,
        { 'Content-Type': 'text/html' },
      );

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(503, { error: 'temporary unavailable' });

    nock('http://catalog.test')
      .persist()
      .post('/agent/v1/products/resolve')
      .reply(503, { error: 'temporary unavailable' });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_url_kb_noise_filter_1')
      .send({ url: 'https://brand.example/product-6.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    const competitorNames = (card.payload?.competitors?.candidates || []).map((x) => String(x?.name || '').toLowerCase());
    const relatedNames = (card.payload?.related_products?.candidates || []).map((x) => String(x?.name || '').toLowerCase());
    expect(competitorNames.length).toBe(0);
    expect(relatedNames.length).toBeGreaterThan(0);
    expect(relatedNames.some((n) => n.includes('multi-peptide eye serum'))).toBe(true);
    expect(relatedNames.some((n) => n.includes('skip to main content'))).toBe(false);
    expect(relatedNames.some((n) => n.includes('contact us'))).toBe(false);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).not.toContain('alternatives_unavailable');

    const valueMomentMode = Array.isArray(res.body.events)
      ? (res.body.events.find((e) => e && e.event_name === 'value_moment')?.data?.mode || '')
      : '';
    expect([
      'url_realtime_product_intel',
      'url_realtime_product_intel_sync_enriched',
      'url_realtime_product_intel_kb_hit_sync_enriched',
    ]).toContain(valueMomentMode);
  });

  test('reconcileProductAnalysisConsistency clears stale anchor_product_missing once anchor is present', () => {
    const { reconcileProductAnalysisConsistency } = require('../src/auroraBff/normalize');
    const out = reconcileProductAnalysisConsistency({
      assessment: {
        verdict: 'Unknown',
        reasons: ['Insufficient evidence.'],
        anchor_product: {
          brand: 'Lab Series',
          name: 'All-In-One Defense Lotion SPF 35',
          url: 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one',
        },
      },
      evidence: {
        science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
        social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
        expert_notes: [],
        missing_info: ['anchor_product_missing', 'evidence_missing'],
      },
      missing_info: ['anchor_product_missing', 'analysis_limited'],
      user_facing_gaps: ['anchor_product_missing', 'analysis_limited'],
      internal_debug_codes: ['anchor_product_missing', 'analysis_limited'],
      missing_info_internal: ['anchor_product_missing', 'analysis_limited'],
    }, { lang: 'EN' });

    expect(out?.missing_info || []).not.toContain('anchor_product_missing');
    expect(out?.user_facing_gaps || []).not.toContain('anchor_product_missing');
    expect(out?.internal_debug_codes || []).not.toContain('anchor_product_missing');
    expect(out?.missing_info_internal || []).not.toContain('anchor_product_missing');
    expect(out?.evidence?.missing_info || []).not.toContain('anchor_product_missing');
  });

  test('/v1/product/parse soft-blocks non-skincare anchor candidates from URL input', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_INTEL_CATALOG_FALLBACK = 'false';
    process.env.AURORA_DECISION_BASE_URL = 'http://aurora.test';

    nock('http://aurora.test')
      .post('/api/chat')
      .reply(200, {
        schema_version: 'aurora.chat.v1',
        intent: 'product_parse',
        structured: {
          parse: {
            product: {
              product_id: 'sku_brush_1',
              brand: 'Lab Series',
              name: 'Powder Brush',
              display_name: 'Lab Series Powder Brush',
              category: 'makeup brush',
              url: 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one',
            },
            confidence: 0.74,
            missing_info: [],
          },
        },
      });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/parse')
      .set('X-Aurora-UID', 'uid_test_parse_anchor_soft_block_1')
      .send({
        url: 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one',
      })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_parse');
    expect(card).toBeTruthy();
    expect(card.payload.product).toBeNull();
    expect(card.payload.missing_info || []).toEqual(expect.arrayContaining(['anchor_soft_blocked_non_skincare']));
    expect(card.payload.anchor_trust).toEqual(
      expect.objectContaining({
        level: 'soft_blocked',
        usable_for_anchor_id: false,
      }),
    );
  });

  test('/v1/product/analyze does not pass anchor_product_id when parse anchor is soft-blocked', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_INTEL_CATALOG_FALLBACK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'false';
    process.env.AURORA_DECISION_BASE_URL = 'http://aurora.test';
    delete process.env.PIVOTA_BACKEND_BASE_URL;

    let deepScanBody = null;
    nock('http://aurora.test')
      .persist()
      .post('/api/chat')
      .reply(200, (uri, requestBody) => {
        const query = String(requestBody && requestBody.query ? requestBody.query : '');
        if (/Parse the user's product input/i.test(query)) {
          return {
            schema_version: 'aurora.chat.v1',
            intent: 'product_parse',
            structured: {
              parse: {
                product: {
                  product_id: 'sku_brush_2',
                  brand: 'Lab Series',
                  name: 'Foundation Brush',
                  display_name: 'Lab Series Foundation Brush',
                  category: 'makeup brush',
                },
                confidence: 0.71,
                missing_info: [],
              },
            },
          };
        }
        deepScanBody = requestBody;
        return {
          schema_version: 'aurora.chat.v1',
          intent: 'product_analyze',
          structured: {
            analyze: {
              assessment: {
                verdict: 'Unknown',
                reasons: ['Evidence is limited.'],
              },
              evidence: {
                science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
                social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
                expert_notes: [],
                missing_info: ['evidence_missing'],
              },
              confidence: 0.36,
              missing_info: ['analysis_limited'],
            },
          },
        };
      });

    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_analyze_anchor_soft_block_1')
      .send({
        url: 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one',
      })
      .expect(200);

    expect(deepScanBody).toBeTruthy();
    expect(deepScanBody.anchor_product_id).toBeUndefined();
    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect((card.payload?.missing_info || []).some((token) => /^anchor_soft_blocked_/i.test(String(token || '')))).toBe(true);
    expect(card.payload?.provenance?.anchor_trust).toEqual(
      expect.objectContaining({
        usable_for_anchor_id: false,
      }),
    );
  });

  test('shouldServeProductIntelKbEntry quarantines low-quality stale KB payloads', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const decision = __internal.shouldServeProductIntelKbEntry({
      kbEntry: {
        kb_key: 'product_url:https://brand.example/x',
        source_meta: {},
      },
      payload: {
        assessment: {
          verdict: 'Unknown',
          reasons: ['Insufficient evidence.'],
        },
        evidence: {
          science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
          social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
          expert_notes: [],
        },
        missing_info: [],
        provenance: {},
      },
      productUrl: 'https://brand.example/x',
      anchorTrustContext: {
        level: 'soft_blocked',
        usable_for_anchor_id: false,
        reasons: ['anchor_soft_blocked_url_mismatch'],
      },
    });
    expect(decision).toEqual(
      expect.objectContaining({
        serve: false,
        quarantined: true,
      }),
    );
    expect(Array.isArray(decision.reasons)).toBe(true);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  test('shouldServeProductIntelKbEntry serves quarantined payload with labels when policy is serve_with_labels', () => {
    process.env.AURORA_KB_SERVE_POLICY = 'serve_with_labels';
    process.env.AURORA_RULE_RELAX_MODE = 'aggressive';
    jest.resetModules();
    const { __internal } = require('../src/auroraBff/routes');
    const decision = __internal.shouldServeProductIntelKbEntry({
      kbEntry: {
        kb_key: 'product_url:https://brand.example/x',
        source_meta: {},
      },
      payload: {
        assessment: {
          verdict: 'Unknown',
          reasons: ['Insufficient evidence.'],
        },
        evidence: {
          science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
          social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
          expert_notes: [],
        },
        missing_info: [],
        provenance: {},
      },
      productUrl: 'https://brand.example/x',
      anchorTrustContext: {
        level: 'soft_blocked',
        usable_for_anchor_id: false,
        reasons: ['anchor_soft_blocked_url_mismatch'],
      },
    });
    expect(decision).toEqual(
      expect.objectContaining({
        serve: true,
        quarantined: true,
      }),
    );
    expect(Array.isArray(decision.reasons)).toBe(true);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  test('reconcileProductAnalysisConsistency generates diagnostic unknown reasons instead of legacy static fallback text', () => {
    const { reconcileProductAnalysisConsistency } = require('../src/auroraBff/normalize');
    const out = reconcileProductAnalysisConsistency(
      {
        evidence: {
          science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
          social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
          expert_notes: [],
          missing_info: ['evidence_missing'],
        },
        missing_info: ['url_fetch_forbidden_403', 'analysis_limited'],
        provenance: {
          url_fetch: {
            final_strategy: 'curl_ua',
            failure_code: 'url_fetch_forbidden_403',
          },
        },
      },
      {
        lang: 'EN',
        fieldMissing: [{ field: 'assessment', reason: 'upstream_missing_or_invalid' }],
      },
    );

    const reasons = Array.isArray(out?.assessment?.reasons) ? out.assessment.reasons : [];
    const joined = reasons.join(' ');
    expect(String(out?.assessment?.verdict || '')).toMatch(/Unknown|未知/);
    expect(joined).toMatch(/403|blocked/i);
    expect(joined).toMatch(/Next step|paste the full INCI|official product page/i);
    expect(joined).not.toMatch(/retrieve a reliable product analysis right now/i);
  });

  test('skin_fit confidence is capped when science evidence is sparse', () => {
    const { enrichProductAnalysisPayload } = require('../src/auroraBff/normalize');
    const out = enrichProductAnalysisPayload(
      {
        assessment: {
          verdict: 'Unknown',
          reasons: ['Evidence is incomplete and confidence is limited.'],
        },
        evidence: {
          science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
          social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
          expert_notes: [],
          confidence: null,
          missing_info: ['evidence_missing'],
        },
        missing_info: ['analysis_limited'],
      },
      {
        lang: 'EN',
        profileSummary: {
          skinType: 'oily',
          sensitivity: 'high',
          barrierStatus: 'impaired',
          goals: ['acne', 'dark_spots'],
        },
      },
    );
    const skinFitScore = Number(out?.confidence_by_block?.skin_fit?.score || 0);
    const skinFitLevel = String(out?.confidence_by_block?.skin_fit?.level || '');
    expect(skinFitScore).toBeLessThanOrEqual(0.58);
    expect(skinFitLevel).not.toBe('high');
  });

  test('shouldPersistProductIntelKb blocks KB write when INCIDecoder is the only evidence source', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const decision = __internal.shouldPersistProductIntelKb({
      assessment: { verdict: 'Likely Suitable' },
      evidence: {
        science: {
          key_ingredients: ['Niacinamide', 'Glycerin', 'Panthenol'],
        },
        sources: [
          { type: 'inci_decoder', url: 'https://incidecoder.com/products/lab-series-all-in-one-defense-lotion' },
        ],
      },
      ingredient_intel: {
        inci_normalized: ['Niacinamide', 'Glycerin', 'Panthenol'],
      },
    });
    expect(decision).toEqual(
      expect.objectContaining({
        attempted: true,
        persisted: false,
        blocked_reason: 'incidecoder_unverified_not_persisted',
      }),
    );
  });

  test('shouldPersistProductIntelKb allow_all keeps write enabled and records audit blocked reason', () => {
    process.env.AURORA_KB_WRITE_POLICY = 'allow_all';
    process.env.AURORA_RULE_RELAX_MODE = 'aggressive';
    jest.resetModules();
    const { __internal } = require('../src/auroraBff/routes');
    const decision = __internal.shouldPersistProductIntelKb({
      assessment: { verdict: 'Likely Suitable' },
      evidence: {
        science: {
          key_ingredients: ['Niacinamide', 'Glycerin', 'Panthenol'],
        },
        sources: [
          { type: 'inci_decoder', url: 'https://incidecoder.com/products/lab-series-all-in-one-defense-lotion' },
        ],
      },
      ingredient_intel: {
        inci_normalized: ['Niacinamide', 'Glycerin', 'Panthenol'],
      },
    });
    expect(decision).toEqual(
      expect.objectContaining({
        attempted: true,
        persisted: true,
        blocked_reason: 'incidecoder_unverified_not_persisted',
        audit_blocked_reason: 'incidecoder_unverified_not_persisted',
        policy: 'allow_all',
      }),
    );
  });

  test('shouldPersistProductIntelKb allows KB write when authoritative source exists and INCIDecoder overlaps', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const decision = __internal.shouldPersistProductIntelKb(
      {
        assessment: { verdict: 'Likely Suitable' },
        evidence: {
          science: {
            key_ingredients: ['Niacinamide', 'Glycerin', 'Octocrylene', 'Avobenzone'],
          },
          sources: [
            { type: 'official_page', url: 'https://www.labseries.com/product/32020/91265/skincare/moisturizerspf/all-in-one-defense-lotion-moisturizer-spf-35/all-in-one' },
            { type: 'inci_decoder', url: 'https://incidecoder.com/products/lab-series-all-in-one-defense-lotion' },
          ],
        },
        ingredient_intel: {
          inci_normalized: ['Niacinamide', 'Glycerin', 'Octocrylene', 'Avobenzone'],
        },
      },
      { inci_decoder_overlap_count: 2 },
    );
    expect(decision).toEqual(
      expect.objectContaining({
        attempted: true,
        persisted: true,
        blocked_reason: null,
      }),
    );
  });

  test('URL realtime analysis uses INCIDecoder supplement when official page is blocked', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_INTEL_INCIDECODER_ENABLED = 'true';
    process.env.AURORA_BFF_PRODUCT_INTEL_INCIDECODER_MAX_CANDIDATES = '2';
    process.env.AURORA_BFF_PRODUCT_INTEL_INCIDECODER_MIN_MATCH_SCORE = '0.3';
    delete process.env.PIVOTA_BACKEND_BASE_URL;

    nock('https://blocked-brand.test')
      .persist()
      .get('/product-x')
      .reply(403, '<html><body>forbidden</body></html>');
    nock('https://www.blocked-brand.test')
      .persist()
      .get('/product-x')
      .reply(403, '<html><body>forbidden</body></html>');

    nock('https://dailymed.nlm.nih.gov')
      .persist()
      .get('/dailymed/search.cfm')
      .query(true)
      .reply(200, '<html><body>no matches</body></html>');

    nock('https://incidecoder.com')
      .persist()
      .get('/search')
      .query(true)
      .reply(200, '<html><body><a href="/products/all-in-one-defense-lotion">match</a></body></html>');

    nock('https://incidecoder.com')
      .persist()
      .get(/\/products\/.*/)
      .reply(
        200,
        `<!doctype html><html><head><title>Lab Series All In One Defense Lotion ingredients (Explained)</title></head>
         <body>
           <a href="/ingredients/water">Water</a>
           <a href="/ingredients/glycerin">Glycerin</a>
           <a href="/ingredients/niacinamide">Niacinamide</a>
           <a href="/ingredients/octocrylene">Octocrylene</a>
           <a href="/ingredients/avobenzone">Avobenzone</a>
         </body></html>`,
        { 'Content-Type': 'text/html' },
      );

    jest.resetModules();
    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.buildProductAnalysisFromUrlIngredients({
      productUrl: 'https://blocked-brand.test/product-x',
      lang: 'EN',
      parsedProduct: {
        brand: 'Lab Series',
        name: 'All In One Defense Lotion',
        display_name: 'Lab Series All In One Defense Lotion',
      },
      profileSummary: {
        skinType: 'oily',
        sensitivity: 'medium',
        barrierStatus: 'healthy',
      },
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    });

    expect(out).toBeTruthy();
    const evidenceSources = Array.isArray(out?.payload?.evidence?.sources) ? out.payload.evidence.sources : [];
    const sourceTypes = evidenceSources.map((item) => String(item?.type || '').toLowerCase());
    expect(sourceTypes).toContain('inci_decoder');
    expect(out?.payload?.missing_info || []).toContain('incidecoder_source_used');
    expect(out?.payload?.provenance?.source_chain || []).toContain('inci_decoder');
    expect(out?.source_meta?.incidecoder_source).toEqual(
      expect.objectContaining({
        provider: 'incidecoder',
      }),
    );
  });

  test('Prompt V3 enforces summary anti-profile-echo and structured how_to_use requirements', () => {
    process.env.AURORA_PRODUCT_INTEL_PROMPT_VERSION = 'v3';
    jest.resetModules();
    const { __internal } = require('../src/auroraBff/routes');
    const prompt = __internal.buildProductDeepScanPrompt({
      prefix: '',
      productDescriptor: 'Lab Series All In One Defense Lotion SPF 35',
      strictNarrative: true,
      includeVersionReminder: true,
    });
    expect(prompt).toMatch(/Disallowed summary phrases/i);
    expect(prompt).toMatch(/how_to_use must be an object/i);
    expect(prompt).toMatch(/Product: Lab Series All In One Defense Lotion SPF 35/i);
  });

  test('narrative quality gate triggers retry for profile-echo summary and invalid how_to_use', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const beforePayload = {
      assessment: {
        summary: 'Your profile: oily / sensitivity=medium / barrier=healthy.',
        formula_intent: ['Helps control sebum with niacinamide support.'],
        how_to_use: {},
      },
    };
    const afterPayload = {
      assessment: {
        summary: 'Targets daily UV defense with lightweight hydration, but dryness watchouts remain.',
        formula_intent: ['Uses UV filters for broad-spectrum day defense.'],
        how_to_use: {
          timing: 'AM',
          frequency: 'Daily',
          steps: ['Apply after moisturizer and before sun exposure.'],
          observation_window: 'Observe for 10-14 days.',
          stop_signs: ['Persistent stinging beyond 60 seconds'],
        },
      },
    };
    expect(__internal.hasProfileEchoSummary(beforePayload)).toBe(true);
    expect(__internal.hasValidSummary(beforePayload)).toBe(false);
    expect(__internal.hasStructuredHowToUse(beforePayload)).toBe(false);
    expect(__internal.shouldRetryForNarrativeQuality(beforePayload)).toBe(true);
    expect(__internal.collectNarrativeRetryCodes(beforePayload, afterPayload)).toEqual(
      expect.arrayContaining(['summary_quality_retry_used', 'how_to_use_retry_used']),
    );
  });

  test('enrichProductAnalysisPayload sanitizes profile-echo summary and builds structured how_to_use fallback', () => {
    const { enrichProductAnalysisPayload } = require('../src/auroraBff/normalize');
    const out = enrichProductAnalysisPayload(
      {
        assessment: {
          verdict: 'Caution',
          summary: 'Your profile: oily / sensitivity=medium / barrier=healthy.',
          formula_intent: ['Provides broad-spectrum UV defense and lightweight hydration.'],
          reasons: [
            'Your profile: oily / sensitivity=medium / barrier=healthy.',
            'May feel drying when barrier is reactive.',
          ],
          how_to_use: {},
        },
        evidence: {
          science: {
            mechanisms: ['Provide daily UV defense with hydration support.'],
            risk_notes: ['drying risk for reactive users'],
          },
          social_signals: {},
          expert_notes: [],
        },
        missing_info: ['analysis_limited'],
      },
      { lang: 'EN' },
    );
    expect(String(out?.assessment?.summary || '').toLowerCase()).not.toContain('your profile');
    expect(out?.assessment?.summary).toMatch(/uv|hydrat|dry/i);
    expect(out?.assessment?.how_to_use).toEqual(
      expect.objectContaining({
        observation_window: expect.any(String),
      }),
    );
    expect(Array.isArray(out?.assessment?.how_to_use?.stop_signs)).toBe(true);
    expect(out?.assessment?.how_to_use?.stop_signs?.length).toBeGreaterThan(0);
    expect(out?.internal_debug_codes || []).toContain('summary_profile_echo_sanitized');
  });
});
