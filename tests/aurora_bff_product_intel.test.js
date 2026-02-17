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
    delete process.env.PIVOTA_BACKEND_BASE_URL;
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
    expect(card.payload.missing_info).toContain('catalog_product_missing');
    expect(card.payload.missing_info).toContain('upstream_deep_scan_skipped_anchor_missing');
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
    expect(Array.isArray(card.payload.competitors?.candidates)).toBe(true);
    expect(card.payload.competitors.candidates.length).toBeGreaterThan(0);
    expect(auroraCalls).toBe(0);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).toContain('url_ingredient_analysis_used');
    expect(card.payload.missing_info).toContain('url_realtime_product_intel_used');
    expect(card.payload.product_intel_contract_version).toBe('aurora.product_intel.contract.v1');

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
    expect(card.payload.missing_info).toContain('competitors_missing');

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

  test('/v1/product/analyze async competitor enrich falls back to aurora alternatives when catalog recall fails', async () => {
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
      .reply(200, (_uri, body) => {
        const query = typeof body?.query === 'string' ? body.query : '';
        if (/return alternatives/i.test(query)) {
          return {
            schema_version: 'aurora.chat.v1',
            intent: 'alternatives',
            structured: {
              alternatives: [
                {
                  kind: 'dupe',
                  product: {
                    product_id: 'aurora_alt_1',
                    sku_id: 'aurora_alt_1',
                    brand: 'Brand D',
                    name: 'Peptide Recovery Serum',
                    display_name: 'Brand D Peptide Recovery Serum',
                  },
                  similarity_score: 0.84,
                  reasons: ['Similar peptide-support positioning.'],
                  tradeoffs: {
                    added_benefits: ['Panthenol'],
                    texture_finish_differences: ['Slightly richer finish'],
                  },
                },
              ],
            },
          };
        }
        return { schema_version: 'aurora.chat.v1', intent: 'chat', answer: 'stub' };
      });

    nock('https://brand.example')
      .get('/product-4.html')
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
      .set('X-Aurora-UID', 'uid_test_url_ingredient_async_comp_fallback_1')
      .send({ url: 'https://brand.example/product-4.html' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).toContain('competitors_missing');

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(upsertProductIntelKbEntry.mock.calls.length).toBeGreaterThanOrEqual(2);
    const lastWrite = upsertProductIntelKbEntry.mock.calls[upsertProductIntelKbEntry.mock.calls.length - 1][0];
    expect(lastWrite.source_meta).toEqual(
      expect.objectContaining({
        competitor_async_enriched: true,
        competitor_async_source: 'aurora_alternatives',
      }),
    );
    expect(Array.isArray(lastWrite.analysis?.competitors?.candidates)).toBe(true);
    expect(lastWrite.analysis.competitors.candidates.length).toBeGreaterThan(0);
  });

  test('/v1/product/analyze filters nav links and recovers competitor candidates from on-page related products', async () => {
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
    expect(competitors.length).toBeGreaterThan(0);
    const names = competitors.map((x) => String(x?.name || '').toLowerCase());
    expect(names.some((n) => n.includes('multi-peptide eye serum') || n.includes('hyaluronic acid'))).toBe(true);
    expect(names.some((n) => n.includes('skip to main content'))).toBe(false);
    expect(names.some((n) => n.includes('contact us'))).toBe(false);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
    expect(card.payload.missing_info).not.toContain('competitors_missing');
  });
});
