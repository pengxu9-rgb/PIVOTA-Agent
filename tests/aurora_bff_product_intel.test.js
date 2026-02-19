const request = require('supertest');
const nock = require('nock');

describe('Aurora BFF product intelligence (structured upstream)', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.AURORA_BFF_USE_MOCK = 'true';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    process.env.AURORA_BFF_PRODUCT_INTEL_CATALOG_FALLBACK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'false';
  });

  afterEach(() => {
    delete process.env.AURORA_BFF_USE_MOCK;
    delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    delete process.env.AURORA_BFF_PRODUCT_INTEL_CATALOG_FALLBACK;
    delete process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL;
    delete process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS;
    delete process.env.AURORA_BFF_RECO_BLOCKS_TIMEOUT_CATALOG_ANN_MS;
    delete process.env.AURORA_BFF_RECO_BLOCKS_BUDGET_MS;
    delete process.env.AURORA_BFF_RECO_BLOCKS_DAG_ENABLED;
    delete process.env.AURORA_BFF_RECO_GUARD_ENABLED;
    delete process.env.AURORA_BFF_RECO_GUARD_CIRCUIT_ENABLED;
    delete process.env.AURORA_BFF_RECO_GUARD_CIRCUIT_THRESHOLD;
    delete process.env.AURORA_BFF_RECO_GUARD_CIRCUIT_COOLDOWN_MS;
    delete process.env.AURORA_BFF_RECO_GUARD_STRICT_DEFAULT_MODE;
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
    expect(card.payload.product).toBeTruthy();
    expect(card.payload.product.sku_id).toBe('mock_sku_1');
    expect(card.payload.confidence).toBeCloseTo(0.7);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
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
    expect(ev.science.key_ingredients).toContain('niacinamide');
    expect(Array.isArray(ev.social_signals.typical_positive)).toBe(true);
    expect(ev.social_signals.typical_positive).toContain('soothing');
    expect(Array.isArray(ev.expert_notes)).toBe(true);
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
    expect(card.payload.confidence).toBeGreaterThan(0);

    const ev = card.payload.evidence;
    expect(ev).toBeTruthy();
    expect(Array.isArray(ev.science.key_ingredients)).toBe(true);
    expect(ev.science.key_ingredients).toContain('niacinamide');
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

  test('normalizePriceObject supports parsed upstream price shapes', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const fromUsd = __internal.normalizePriceObject({ usd: 29.9, unknown: false });
    expect(fromUsd).toEqual({ amount: 29.9, currency: 'USD', unknown: false });

    const fromAmount = __internal.normalizePriceObject({ amount: '42.50', currency: 'usd' });
    expect(fromAmount).toEqual({ amount: 42.5, currency: 'USD', unknown: false });
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

  test('reco guardrail circuit open degrades subsequent competitors to empty', () => {
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
    expect(Array.isArray(second?.competitors?.candidates) ? second.competitors.candidates.length : 0).toBe(0);
    expect(second?.provenance?.guardrail_circuit_open).toBe(true);
    expect(second?.provenance?.auto_rollback_flag).toBe(true);
    expect(second?.confidence_by_block?.competitors?.level).toBe('low');

    const snap = __internal.getRecoGuardrailCircuitSnapshot('main_path');
    expect(snap.open).toBe(true);
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
      source: 'url_realtime_product_intel',
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
    expect(competitors.map((x) => x.product_id)).toEqual(['clean_competitor']);
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

  test('/v1/product/parse falls back to catalog resolve when upstream parse is unavailable', async () => {
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
    expect(card.payload.product.product_id).toBe('p_catalog_1');
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).toContain('catalog_fallback_used');
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
      .send({ url: 'https://example.com/non-catalog-product.html' })
      .expect(200);

    expect(deepScanCalls).toBe(0);
    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(String(card.payload.assessment?.verdict || '')).toMatch(/Unknown|未知/);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).toContain('product_not_resolved');
    expect(card.payload.internal_debug_codes).toBeUndefined();
    expect(card.payload.missing_info_internal).toBeUndefined();
  });

  test('/v1/product/analyze runs realtime URL product-intel first and backfills KB asynchronously', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
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
    expect(card.payload.missing_info).toContain('ingredient_concentration_unknown');
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
        source: 'url_realtime_product_intel',
        kb_key: expect.any(String),
      }),
    );
  });

  test('/v1/product/analyze schedules async competitor enrich when first-pass competitor recall fails', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
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
    expect(card.payload.missing_info).toContain('alternatives_limited');
    expect(card.payload.internal_debug_codes).toBeUndefined();
    expect(card.payload.missing_info_internal).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(upsertProductIntelKbEntry.mock.calls.length).toBeGreaterThanOrEqual(2);
    const lastWrite = upsertProductIntelKbEntry.mock.calls[upsertProductIntelKbEntry.mock.calls.length - 1][0];
    expect(lastWrite).toEqual(
      expect.objectContaining({
        source: 'url_realtime_product_intel',
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
      source: 'url_realtime_product_intel',
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
    expect(card.payload.competitors.candidates.length).toBeGreaterThan(0);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).not.toContain('competitors_missing');
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
      source: 'url_realtime_product_intel',
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
    expect(upsertProductIntelKbEntry).toHaveBeenCalled();
    expect(upsertProductIntelKbEntry.mock.calls.length).toBeGreaterThan(0);
  });

  test('/v1/product/analyze routes on-page fallback into related_products when catalog recall is unavailable', async () => {
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'true';
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
      source: 'url_realtime_product_intel',
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
    expect(card.payload.missing_info).toContain('alternatives_unavailable');
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
    expect(card.payload.provenance.timed_out_blocks).toContain('catalog_ann');
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

  test('/v1/product/analyze async competitor enrich uses reco dag source when catalog recall fails', async () => {
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
    expect(card.payload.missing_info).toContain('alternatives_unavailable');
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
    expect(competitors.length + related.length).toBeGreaterThan(0);
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
    expect(card.payload.missing_info).toContain('alternatives_unavailable');
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
      source: 'url_realtime_product_intel',
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
    expect(card.payload.missing_info).toContain('alternatives_unavailable');

    const valueMomentMode = Array.isArray(res.body.events)
      ? (res.body.events.find((e) => e && e.event_name === 'value_moment')?.data?.mode || '')
      : '';
    expect(valueMomentMode).toBe('url_realtime_product_intel');
  });
});
