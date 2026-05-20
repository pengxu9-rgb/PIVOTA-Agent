const request = require('supertest');
const nock = require('nock');

describe('find_similar_products mainline wrapper', () => {
  const apiBase = 'http://localhost:8080';

  beforeEach(() => {
    nock.cleanAll();
    jest.resetModules();
    jest.dontMock('../src/db');
    process.env.API_MODE = 'REAL';
    process.env.PIVOTA_API_BASE = apiBase;
    process.env.PIVOTA_API_KEY = 'test-token';
    delete process.env.DATABASE_URL;
    delete process.env.PDP_SIMILAR_CARD_DETAIL_ENRICH_ENABLED;
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('returns RecommendationEngine results and does not fall back upstream', async () => {
    const recommendMock = jest.fn().mockResolvedValue({
      items: [
        {
          product_id: 'sim_1',
          merchant_id: 'external_seed',
          title: 'Similar Product 1',
          image_url: 'https://cdn.example.test/sim-1.jpg',
          description: 'A verified similar product highlight for PDP card presentation.',
          card_highlight_status: 'ready',
          card_highlight: 'Same routine fit with a stronger finish.',
        },
      ],
      metadata: {
        low_confidence: false,
        retrieval_mix: { internal: 0, external: 1 },
      },
    });

    jest.doMock('../src/services/RecommendationEngine', () => ({
      ...jest.requireActual('../src/services/RecommendationEngine'),
      recommend: recommendMock,
      getCacheStats: jest.fn(() => ({})),
    }));

    const upstreamScope = nock(apiBase)
      .post('/agent/shop/v1/invoke')
      .reply(200, { products: [{ product_id: 'upstream_should_not_run' }] });

    const app = require('../src/server');

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_similar_products',
        payload: {
          product_id: 'ext_demo_1',
          merchant_id: 'external_seed',
          limit: 4,
        },
      })
      .expect(200);

    expect(recommendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pdp_product: expect.objectContaining({
          merchant_id: 'external_seed',
          product_id: 'ext_demo_1',
          source: 'external_seed',
        }),
        k: 4,
        options: expect.objectContaining({
          candidate_limit: 16,
        }),
      }),
    );
    expect(res.body.products).toEqual([
      expect.objectContaining({
        product_id: 'sim_1',
      }),
    ]);
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        route: 'find_similar_products_mainline_wrapper',
        direct_base_detail_mode: 'external_seed_minimal',
        card_enrichment_budget_ms: expect.any(Number),
      }),
    );
    expect(upstreamScope.isDone()).toBe(false);
  });

  it('resolves sig external-seed bases before mainline similar recall', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const dbQueryMock = jest.fn().mockResolvedValue({
      rows: [
        {
          merchant_id: 'external_seed',
          platform: 'external_seed',
          source_product_id: 'ext_source_1',
          product_key: 'prod::external_seed::external_seed::ext_source_1',
          pivota_signature_id: 'sig_source1',
          content_key: 'tom-ford:test-content-key',
        },
      ],
    });
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    const recommendMock = jest.fn().mockResolvedValue({
      items: [
        {
          product_id: 'ext_sim_1',
          merchant_id: 'external_seed',
          pivota_signature_id: 'sig_sim1',
          title: 'Similar Product 1',
          image_url: 'https://cdn.example.test/sim-1.jpg',
          card_highlight: 'Same category with a comparable finish.',
        },
      ],
      metadata: {
        low_confidence: false,
        retrieval_mix: { internal: 0, external: 1 },
      },
    });
    jest.doMock('../src/services/RecommendationEngine', () => ({
      ...jest.requireActual('../src/services/RecommendationEngine'),
      recommend: recommendMock,
      getCacheStats: jest.fn(() => ({})),
    }));

    const app = require('../src/server');

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_similar_products',
        payload: {
          product_id: 'sig_source1',
          merchant_id: 'external_seed',
          limit: 4,
          options: { debug: true },
        },
      })
      .expect(200);

    expect(dbQueryMock).toHaveBeenCalledWith(expect.stringContaining('WHERE cp.pivota_signature_id = $1'), ['sig_source1']);
    expect(recommendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pdp_product: expect.objectContaining({
          merchant_id: 'external_seed',
          product_id: 'ext_source_1',
          external_product_id: 'ext_source_1',
          pivota_signature_id: 'sig_source1',
          requested_product_id: 'sig_source1',
          source: 'external_seed',
        }),
      }),
    );
    expect(res.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'sig_sim1',
        source_product_id: 'ext_sim_1',
      }),
    );
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        direct_base_detail_mode: 'external_seed_minimal',
        similar_base_ref_resolution: expect.objectContaining({
          requested_product_id: 'sig_source1',
          resolved_product_id: 'ext_source_1',
          resolved: true,
        }),
      }),
    );
  });

  it('does not spend card detail budget on highlight-only gaps', async () => {
    const app = require('../src/server');

    const items = await app._debug.enrichSimilarProductsForPdpCards({
      items: [
        {
          product_id: 'sim_highlight_gap',
          merchant_id: 'external_seed',
          image_url: 'https://cdn.example.test/sim.jpg',
        },
      ],
      maxItems: 1,
      budgetMs: 100,
      detailBudgetMs: 50,
    });
    const metadata = app._debug.getSimilarCardEnrichmentMetadata(items);

    expect(app._debug.shouldEnrichSimilarCard(items[0])).toBe(false);
    expect(items[0]).toEqual(
      expect.objectContaining({
        card_highlight_status: 'highlight_missing',
        card_image_status: 'ready',
      }),
    );
    expect(metadata).toEqual(
      expect.objectContaining({
        card_enrichment_status: 'ready',
        card_enrichment_attempted_count: 0,
        card_enrichment_budget_ms: 100,
        card_enrichment_detail_budget_ms: 50,
      }),
    );
  });

  it('adds conservative source-backed similar card highlights from rich product titles', async () => {
    const app = require('../src/server');

    const items = await app._debug.enrichSimilarProductsForPdpCards({
      items: [
        {
          product_id: 'sim_title_backed',
          merchant_id: 'ulta',
          title: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
          image_url: 'https://cdn.example.test/dewy-gel-cream.jpg',
          shopping_card: {
            title: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
            subtitle: 'Moisturizer',
          },
          search_card: {
            title_candidate: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
            compact_candidate: 'Moisturizer',
          },
        },
      ],
      maxItems: 1,
      budgetMs: 100,
      detailBudgetMs: 50,
    });
    const metadata = app._debug.getSimilarCardEnrichmentMetadata(items);

    expect(app._debug.shouldEnrichSimilarCard(items[0])).toBe(false);
    expect(items[0]).toEqual(
      expect.objectContaining({
        card_highlight_status: 'ready',
        card_image_status: 'ready',
        card_highlight: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
        card_highlight_source: 'source_backed_title_or_intro',
        shopping_card: expect.objectContaining({
          highlight: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
        }),
        search_card: expect.objectContaining({
          highlight_candidate: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
        }),
      }),
    );
    expect(metadata).toEqual(
      expect.objectContaining({
        card_enrichment_attempted_count: 0,
      }),
    );
  });

  it('adds source-backed similar card highlights for makeup title terms', async () => {
    const app = require('../src/server');

    const items = await app._debug.enrichSimilarProductsForPdpCards({
      items: [
        {
          product_id: 'ulta_lipstick_title',
          merchant_id: 'ulta',
          title: 'Almost Lipstick - Nude Honey',
          category: 'lipstick',
          image_url: 'https://cdn.example.test/almost-lipstick.jpg',
        },
      ],
      maxItems: 1,
      budgetMs: 100,
      detailBudgetMs: 50,
    });

    expect(items[0]).toEqual(
      expect.objectContaining({
        card_highlight_status: 'ready',
        card_image_status: 'ready',
        card_highlight: 'Almost Lipstick - Nude Honey',
        card_highlight_source: 'source_backed_title_or_intro',
      }),
    );
    expect(items[0].shopping_card).toEqual(expect.objectContaining({ highlight: 'Almost Lipstick - Nude Honey' }));
    expect(items[0].search_card).toEqual(
      expect.objectContaining({ highlight_candidate: 'Almost Lipstick - Nude Honey' }),
    );
  });

  it('does not treat category-only similar cards as source-backed highlights', async () => {
    const app = require('../src/server');

    const items = await app._debug.enrichSimilarProductsForPdpCards({
      items: [
        {
          product_id: 'sim_category_only',
          merchant_id: 'external_seed',
          title: 'Category only',
          category: 'Toner',
          image_url: 'https://cdn.example.test/category-only.jpg',
        },
      ],
      maxItems: 1,
      budgetMs: 100,
      detailBudgetMs: 50,
    });

    expect(items[0]).toEqual(
      expect.objectContaining({
        card_highlight_status: 'highlight_missing',
        card_image_status: 'ready',
      }),
    );
    expect(items[0].card_highlight).toBeUndefined();
  });

  it('keeps public similar card detail hydration isolated even when the env flag is enabled', async () => {
    process.env.PDP_SIMILAR_CARD_DETAIL_ENRICH_ENABLED = 'true';
    const app = require('../src/server');

    const items = await app._debug.enrichSimilarProductsForPdpCards({
      items: [
        {
          product_id: 'sim_image_gap',
          merchant_id: 'external_seed',
          title: 'Image Missing Candidate',
          card_highlight: 'Reviewed card copy is already present.',
        },
      ],
      maxItems: 1,
      budgetMs: 100,
      detailBudgetMs: 50,
    });
    const metadata = app._debug.getSimilarCardEnrichmentMetadata(items);

    expect(app._debug.shouldEnrichSimilarCard(items[0])).toBe(false);
    expect(items[0]).toEqual(
      expect.objectContaining({
        card_highlight_status: 'ready',
        card_image_status: 'image_missing',
      }),
    );
    expect(metadata).toEqual(
      expect.objectContaining({
        card_enrichment_detail_hydration_enabled: false,
        card_enrichment_attempted_count: 0,
        card_enrichment_detail_hydration_skipped_count: 1,
      }),
    );
  });

  it('calibrates underfill metadata against final visible similar products', async () => {
    const app = require('../src/server');

    const metadata = app._debug.calibrateSimilarMetadataForVisibleProducts({
      requestedLimit: 6,
      products: [
        { product_id: 'ext_1', merchant_id: 'external_seed', source: 'external' },
        { product_id: 'ext_2', merchant_id: 'external_seed', source: 'external' },
        { product_id: 'ext_3', merchant_id: 'external_seed', source: 'external' },
        { product_id: 'ext_4', merchant_id: 'external_seed', source: 'external' },
        { product_id: 'ext_5', merchant_id: 'external_seed', source: 'external' },
        { product_id: 'ext_6', merchant_id: 'external_seed', source: 'external' },
      ],
      metadata: {
        similar_confidence: 'high',
        low_confidence: true,
        low_confidence_reason_codes: ['UNDERFILL_FOR_QUALITY'],
        underfill: 2,
        retrieval_mix: { internal: 0, external: 8 },
        similar_status: 'ready',
      },
    });

    expect(metadata).toEqual(
      expect.objectContaining({
        requested_count: 6,
        visible_count: 6,
        underfill: 0,
        raw_underfill: 2,
        low_confidence: false,
        low_confidence_reason_codes: [],
        retrieval_mix: { internal: 0, external: 6 },
        raw_retrieval_mix: { internal: 0, external: 8 },
        similar_status: 'ready',
      }),
    );
  });

  it('keeps viable mainline recommendation sets ready while preserving underfill diagnostics', async () => {
    const app = require('../src/server');

    const metadata = app._debug.calibrateSimilarMetadataForVisibleProducts({
      requestedLimit: 12,
      products: [
        { product_id: 'ext_1', merchant_id: 'external_seed', source: 'external' },
        { product_id: 'ext_2', merchant_id: 'external_seed', source: 'external' },
        { product_id: 'ext_3', merchant_id: 'external_seed', source: 'external' },
        { product_id: 'ext_4', merchant_id: 'external_seed', source: 'external' },
        { product_id: 'ext_5', merchant_id: 'external_seed', source: 'external' },
      ],
      metadata: {
        similar_confidence: 'high',
        low_confidence: true,
        low_confidence_reason_codes: ['UNDERFILL_FOR_QUALITY', 'UNDERFILL_MAINLINE_RECALL'],
        underfill: 5,
        similar_status: 'underfilled',
      },
    });

    expect(metadata).toEqual(
      expect.objectContaining({
        requested_count: 12,
        visible_count: 5,
        ready_min_visible_count: 5,
        underfill: 7,
        underfill_nonblocking: true,
        low_confidence: false,
        low_confidence_reason_codes: [],
        similar_status: 'ready',
      }),
    );
  });

  it('keeps very thin mainline recommendation sets underfilled', async () => {
    const app = require('../src/server');

    const metadata = app._debug.calibrateSimilarMetadataForVisibleProducts({
      requestedLimit: 12,
      products: [
        { product_id: 'ext_1', merchant_id: 'external_seed', source: 'external' },
        { product_id: 'ext_2', merchant_id: 'external_seed', source: 'external' },
        { product_id: 'ext_3', merchant_id: 'external_seed', source: 'external' },
        { product_id: 'ext_4', merchant_id: 'external_seed', source: 'external' },
      ],
      metadata: {
        similar_confidence: 'high',
        low_confidence: true,
        low_confidence_reason_codes: ['UNDERFILL_FOR_QUALITY', 'UNDERFILL_MAINLINE_RECALL'],
        underfill: 8,
        similar_status: 'underfilled',
      },
    });

    expect(metadata).toEqual(
      expect.objectContaining({
        requested_count: 12,
        visible_count: 4,
        ready_min_visible_count: 5,
        underfill: 8,
        low_confidence: true,
        low_confidence_reason_codes: ['UNDERFILL_FOR_QUALITY'],
        similar_status: 'underfilled',
      }),
    );
  });

  it('runtime-classifies official hair styling seeds and blocks non-formula fill', () => {
    const { pickLayeredRecommendations } = require('../src/services/RecommendationEngine');

    const baseProduct = {
      merchant_id: 'external_seed',
      product_id: 'ext_90_proof',
      title: '90 Proof Pomade',
      brand: 'Blind Barber',
      category: 'Fragrance',
      product_type: 'Fragrance',
      semantic_vertical: 'fragrance',
      description: 'Leaves your hair with a strong hold and a matte finish.',
    };
    const externalCandidates = [
      {
        merchant_id: 'external_seed',
        product_id: 'ext_101_proof',
        title: '101 Proof Classic Pomade',
        brand: 'Blind Barber',
        description: 'Leaves your hair with maximum hold and a high sheen finish.',
        image_url: 'https://cdn.example.test/101.jpg',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_60_wax',
        title: '60 Proof Wax',
        brand: 'Blind Barber',
        description: 'Leaves your hair with a medium hold and a workable natural finish.',
        image_url: 'https://cdn.example.test/wax.jpg',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_styling_cream',
        title: '30 Proof Styling Cream',
        brand: 'Blind Barber',
        category: 'Moisturizer',
        semantic_vertical: 'skincare',
        description: 'A daily styling product for towel-dried hair.',
        image_url: 'https://cdn.example.test/cream.jpg',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_perfume_sample',
        title: 'Eau De Parfum - Speakeasy 2ML',
        brand: 'Blind Barber',
        description: 'Fine fragrance sample.',
        image_url: 'https://cdn.example.test/perfume.jpg',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_hat',
        title: 'Bad Hair Day - Dad Hat',
        brand: 'Blind Barber',
        description: 'One Size Fits Most Cotton Twill',
        image_url: 'https://cdn.example.test/hat.jpg',
      },
    ];

    const rec = pickLayeredRecommendations({
      baseProduct,
      internalCandidates: [],
      externalCandidates,
      k: 6,
    });

    expect(rec.metadata.base_semantic.vertical).toBe('haircare');
    expect(rec.items.map((item) => item.product_id)).toEqual([
      'ext_101_proof',
      'ext_60_wax',
      'ext_styling_cream',
    ]);
    expect(rec.items.map((item) => item.product_id)).not.toContain('ext_perfume_sample');
    expect(rec.items.map((item) => item.product_id)).not.toContain('ext_hat');
  });

  it('runtime-classifies external bodycare grooming seeds and filters pet deodorizing products', () => {
    const { pickLayeredRecommendations } = require('../src/services/RecommendationEngine');

    const baseProduct = {
      merchant_id: 'external_seed',
      product_id: 'ext_blind_deodorant',
      title: 'Tonka Bean Aluminum-Free Deodorant',
      brand: 'Blind Barber',
      description: 'Aluminum-free deodorant that helps underarm odor while absorbing excess moisture.',
    };
    const externalCandidates = [
      {
        merchant_id: 'external_seed',
        product_id: 'ext_upcircle_deodorant',
        title: 'Refillable Deodorant with Macadamia + Bergamot',
        brand: 'UpCircle Beauty',
        description: 'A deodorant designed to be kind to your skin.',
        image_url: 'https://cdn.example.test/upcircle.jpg',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_nuxe_deodorant',
        title: '24hr Fresh-Feel Deodorant',
        brand: 'NUXE',
        description: 'Deodorant protection with a fresh-feel finish.',
        image_url: 'https://cdn.example.test/nuxe.jpg',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_fab_deodorant',
        title: 'Whole Body Deodorant Cream',
        brand: 'First Aid Beauty',
        description: 'Odor-fighting AHA deodorant cream for unwanted body odor.',
        image_url: 'https://cdn.example.test/fab.jpg',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_tom_ford_deodorant',
        title: 'Oud Wood Deodorant Stick',
        brand: 'Tom Ford Beauty',
        description: 'A scented deodorant stick.',
        image_url: 'https://cdn.example.test/tom-ford.jpg',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_pet_spray',
        title: 'Natural Deodorizing spray for PETS',
        brand: 'Natural Dog Company',
        description: 'A pet deodorizing spray.',
        image_url: 'https://cdn.example.test/pet.jpg',
      },
    ];

    const rec = pickLayeredRecommendations({
      baseProduct,
      internalCandidates: [],
      externalCandidates,
      k: 6,
    });

    expect(rec.metadata.base_semantic.vertical).toBe('bodycare');
    expect(rec.items.map((item) => item.product_id).sort()).toEqual([
      'ext_fab_deodorant',
      'ext_nuxe_deodorant',
      'ext_tom_ford_deodorant',
      'ext_upcircle_deodorant',
    ].sort());
    expect(rec.items.map((item) => item.product_id)).not.toContain('ext_pet_spray');
  });

  it('derives official seed card highlights for bodycare and grooming similar cards', () => {
    const app = require('../src/server');

    expect(app._debug.deriveOfficialSeedSimilarCardHighlight({
      description: 'Our deodorant is designed to be kind to your skin: enriched with macadamia oil and bergamot.',
    })).toBe('Kind-to-skin deodorant');
    expect(app._debug.deriveOfficialSeedSimilarCardHighlight({
      description: 'Lav Kids Foaming Body Wash provides a soft, gentle cleanse that leaves skin feeling clean.',
    })).toBe('Foaming body wash cleanse');
    expect(app._debug.deriveOfficialSeedSimilarCardHighlight({
      description: 'A cleansing bar that gently cleanses skin while leaving the body feeling hydrated.',
    })).toBe('Body cleansing bar');
    expect(app._debug.deriveOfficialSeedSimilarCardHighlight({
      description: 'Our shave cream provides a protective lather and helps soften your facial hair.',
    })).toBe('Protective lather');
  });

  it('uses official seed titles as similar card evidence when official PDP text exists', () => {
    const app = require('../src/server');

    const enriched = app._debug.applyOfficialSeedSimilarCardEnrichment(
      {
        product_id: 'ext_jurlique_hand_cream',
        merchant_id: 'external_seed',
        title: 'Rose Hand Cream',
        evidence_profile: 'seller_only',
        shopping_card: { evidence_profile: 'seller_only' },
        search_card: { evidence_profile: 'seller_only' },
      },
      {
        title: 'Rose Hand Cream',
        description: 'A replenishing hand cream from the official product page with botanical oils for daily hand care.',
      },
    );

    expect(enriched).toEqual(
      expect.objectContaining({
        card_highlight: 'Rose Hand Cream',
        card_highlight_source: 'official_pdp_seed_title',
        evidence_profile: 'official_pdp_seed_title',
      }),
    );
    expect(enriched.shopping_card).toEqual(
      expect.objectContaining({
        highlight: 'Rose Hand Cream',
        evidence_profile: 'official_pdp_seed_title',
      }),
    );
    expect(enriched.search_card).toEqual(
      expect.objectContaining({
        highlight_candidate: 'Rose Hand Cream',
        evidence_profile: 'official_pdp_seed_title',
      }),
    );
  });

  it('does not promote generic official seed titles into similar card evidence', () => {
    const app = require('../src/server');

    expect(app._debug.applyOfficialSeedSimilarCardEnrichment(
      { product_id: 'ext_generic', merchant_id: 'external_seed', evidence_profile: 'seller_only' },
      {
        title: 'Similar Product 1',
        description: 'Official product page text that is present but the title is still generic.',
      },
    )).toEqual(
      expect.objectContaining({
        evidence_profile: 'seller_only',
      }),
    );
  });

  it('skips expensive public PDP similar recall for external sample/sachet products', async () => {
    const app = require('../src/server');

    expect(app._debug.shouldSkipPdpSimilarFetchForAccessory({
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_sachet',
        title: 'Mask Fit Red Cushion Sachet',
      },
      pdpSchemaProfile: 'beauty_formula',
    })).toBe(true);

    expect(app._debug.shouldSkipPdpSimilarFetchForAccessory({
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_cushion',
        title: 'Mask Fit Red Cushion',
      },
      pdpSchemaProfile: 'beauty_formula',
    })).toBe(false);

    expect(app._debug.shouldSkipPdpSimilarFetchForAccessory({
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_towel',
        title: 'Hooded Bath Towel',
      },
      pdpSchemaProfile: 'generic_merch',
    })).toBe(true);

    expect(app._debug.shouldSkipPdpSimilarFetchForAccessory({
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_deluxe_sample',
        title: 'Wisp Lash Mascara Mini Deluxe Sample',
      },
      pdpSchemaProfile: 'beauty_formula',
    })).toBe(true);
  });

  it('returns 503 when mainline recommendations fail instead of falling back upstream', async () => {
    const recommendMock = jest.fn().mockRejectedValue(new Error('engine unavailable'));

    jest.doMock('../src/services/RecommendationEngine', () => ({
      ...jest.requireActual('../src/services/RecommendationEngine'),
      recommend: recommendMock,
      getCacheStats: jest.fn(() => ({})),
    }));

    const upstreamScope = nock(apiBase)
      .post('/agent/shop/v1/invoke')
      .reply(200, { products: [{ product_id: 'upstream_should_not_run' }] });

    const app = require('../src/server');

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_similar_products',
        payload: {
          product_id: 'ext_demo_2',
          limit: 4,
        },
      })
      .expect(503);

    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'SIMILAR_MAINLINE_UNAVAILABLE',
      }),
    );
    expect(upstreamScope.isDone()).toBe(false);
  });
});
