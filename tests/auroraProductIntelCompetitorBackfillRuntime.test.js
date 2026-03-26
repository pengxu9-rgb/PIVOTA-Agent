const {
  createProductIntelCompetitorBackfillRuntime,
} = require('../src/auroraBff/productIntelCompetitorBackfillRuntime');

describe('aurora product-intel competitor backfill runtime', () => {
  test('does not enqueue async enrich when competitor coverage is already healthy', () => {
    const scheduleDetachedAsyncJob = jest.fn();
    const runtime = createProductIntelCompetitorBackfillRuntime({
      PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED: true,
      PRODUCT_URL_REALTIME_COMPETITOR_ASYNC_ENRICH_ENABLED: true,
      hasCompetitorCandidatesInPayload: jest.fn(() => true),
      hasLowCoverageCompetitorsInPayload: jest.fn(() => false),
      shouldRepairCompetitorCoverage: jest.fn(() => false),
      scheduleDetachedAsyncJob,
    });

    runtime.scheduleProductIntelCompetitorEnrichBackfill({
      productUrl: 'https://brand.example/product-1',
      payload: {
        assessment: {
          anchor_product: {
            product_id: 'anchor_1',
            name: 'Anchor Product',
          },
        },
        competitors: {
          candidates: [{ product_id: 'comp_1', name: 'Comp 1' }],
        },
      },
    });

    expect(scheduleDetachedAsyncJob).not.toHaveBeenCalled();
  });

  test('queues async competitor enrich write with snapshot and KB metadata', async () => {
    const queuedJobs = [];
    const writeCompetitorSnapshot = jest.fn();
    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    const runtime = createProductIntelCompetitorBackfillRuntime({
      PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED: true,
      PRODUCT_URL_REALTIME_COMPETITOR_ASYNC_ENRICH_ENABLED: true,
      PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT: 2,
      AURORA_BFF_RECO_BLOCKS_BUDGET_MS: 4000,
      PRODUCT_URL_REALTIME_COMPETITOR_BACKFILL_TIMEOUT_MS: 6000,
      PRODUCT_URL_REALTIME_COMPETITOR_BACKFILL_MAX_CANDIDATES: 4,
      shouldRepairCompetitorCoverage: jest.fn(() => true),
      buildCompetitorSnapshotKey: jest.fn(() => 'snap:key'),
      canEnqueueCompetitorSnapshotBackfill: jest.fn(() => true),
      markCompetitorSnapshotBackfillCooldown: jest.fn(),
      recordAuroraCompBackfillEnqueued: jest.fn(),
      scheduleDetachedAsyncJob: jest.fn((job) => queuedJobs.push(job)),
      runRecoBlocksForUrl: jest.fn(async () => ({
        competitors: { candidates: [{ product_id: 'comp_1', name: 'Comp 1' }] },
        related_products: { candidates: [{ product_id: 'rel_1', name: 'Rel 1' }] },
        dupes: { candidates: [] },
        internal_reason_codes: ['router_reason'],
        diagnostics: {
          mode: 'async_backfill',
          budget_ms: 6100,
          timed_out_blocks: ['dupes'],
          fallbacks_used: ['catalog'],
        },
        confidence_patch: { competitors: { score: 0.78 } },
        provenance_patch: { pipeline: 'reco_blocks_dag.v2', block_stats: { competitors: 1 } },
        catalog_queries: ['peptide serum'],
      })),
      sanitizeCompetitorCandidates: jest.fn((items, max) => (Array.isArray(items) ? items.slice(0, max) : [])),
      summarizeRouterReasonCodes: jest.fn(() => ['router_reason']),
      uniqCaseInsensitiveStrings: (items = [], max = 32) => Array.from(new Set(items.filter(Boolean))).slice(0, max),
      stripCompetitorMissingTokens: jest.fn((items = []) => items.filter((item) => item !== 'competitors_low_coverage')),
      getProductAnalysisInternalMissingCodes: jest.fn(() => ['competitors_low_coverage']),
      enrichProductAnalysisPayload: jest.fn((payload) => ({ ...payload, enriched: true })),
      writeCompetitorSnapshot,
      buildProductIntelKbKey: jest.fn(() => 'url:https://brand.example/product-2'),
      upsertProductIntelKbEntry,
      buildProfileSkinTags: jest.fn(() => ['oily', 'sensitive']),
      inferRecoPriceBand: jest.fn(() => 'mid'),
      normalizePriceObject: jest.fn(() => ({ amount: 39 })),
    });

    runtime.scheduleProductIntelCompetitorEnrichBackfill({
      productUrl: 'https://brand.example/product-2',
      parsedProduct: {
        product_id: 'anchor_2',
        name: 'Anchor Product 2',
      },
      payload: {
        assessment: {
          anchor_product: {
            product_id: 'anchor_2',
            display_name: 'Anchor Product 2',
            category: 'serum',
            price: { amount: 39 },
          },
        },
        evidence: {
          science: { key_ingredients: ['Peptide'] },
          expert_notes: ['existing note'],
          missing_info: ['competitors_low_coverage'],
        },
        provenance: {
          source: 'url_realtime_product_intel',
        },
      },
      lang: 'EN',
      sourceMeta: {
        original_source: 'unit_test',
      },
    });

    expect(queuedJobs).toHaveLength(1);

    await queuedJobs[0]();

    expect(writeCompetitorSnapshot).toHaveBeenCalledWith(
      'snap:key',
      expect.objectContaining({
        competitors: [{ product_id: 'comp_1', name: 'Comp 1' }],
        related_products: [{ product_id: 'rel_1', name: 'Rel 1' }],
        competitor_queries: ['peptide serum'],
      }),
      expect.objectContaining({
        source: 'reco_async_backfill',
        ranker_version: 'reco_blocks_dag.v2',
      }),
    );
    expect(upsertProductIntelKbEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        kb_key: 'url:https://brand.example/product-2',
        source_meta: expect.objectContaining({
          original_source: 'unit_test',
          competitor_async_enriched: true,
          competitor_async_source: 'reco_blocks_dag',
          competitor_router_reason_codes: ['router_reason'],
          competitor_queries: ['peptide serum'],
          reco_blocks_dag: expect.objectContaining({
            mode: 'async_backfill',
            timed_out_blocks: ['dupes'],
            fallbacks_used: ['catalog'],
          }),
        }),
        analysis: expect.objectContaining({
          enriched: true,
          internal_debug_codes: expect.arrayContaining([
            'router_reason',
            'reco_dag_fallback_catalog',
            'reco_dag_timeout_dupes',
            'competitor_async_backfill_used',
          ]),
        }),
      }),
    );
  });

  test('sync repair uses direct recall fallback to recover competitor coverage', async () => {
    const runtime = createProductIntelCompetitorBackfillRuntime({
      PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT: 2,
      PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_TIMEOUT_MS: 2400,
      PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_MAX_QUERIES: 2,
      PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES: 4,
      getCompetitorCandidatesFromPayload: jest.fn(() => []),
      hasLowCoverageCompetitorToken: jest.fn(() => false),
      runRecoBlocksForUrl: jest.fn(async () => ({
        competitors: { candidates: [] },
        related_products: { candidates: [] },
        dupes: { candidates: [] },
        internal_reason_codes: ['router_reason'],
        diagnostics: {
          fallbacks_used: ['catalog'],
          timed_out_blocks: [],
        },
        provenance_patch: { pipeline: 'reco_blocks_dag.v2' },
        confidence_patch: { competitors: { score: 0.72 } },
      })),
      buildRealtimeCompetitorCandidates: jest.fn(async () => ({
        candidates: [
          { product_id: 'comp_2', name: 'Comp 2' },
          { product_id: 'rel_2', name: 'Rel 2' },
        ],
      })),
      routeCompetitorCandidatePools: jest.fn(() => ({
        compPool: [{ product_id: 'comp_2', name: 'Comp 2' }],
        relPool: [{ product_id: 'rel_2', name: 'Rel 2' }],
        dupePool: [],
      })),
      sanitizeCompetitorCandidates: jest.fn((items, max) => (Array.isArray(items) ? items.slice(0, max) : [])),
      summarizeRouterReasonCodes: jest.fn(() => ['router_reason']),
      uniqCaseInsensitiveStrings: (items = [], max = 32) => Array.from(new Set(items.filter(Boolean))).slice(0, max),
      stripCompetitorMissingTokens: jest.fn((items = []) => items.filter((item) => item !== 'competitors_missing')),
      getProductAnalysisInternalMissingCodes: jest.fn(() => ['competitors_missing']),
    });

    const out = await runtime.maybeSyncRepairLowCoverageCompetitors({
      productUrl: 'https://brand.example/product-3',
      payload: {
        assessment: {
          anchor_product: {
            product_id: 'anchor_3',
            name: 'Anchor Product 3',
          },
        },
        competitors: { candidates: [] },
        evidence: {
          science: { key_ingredients: ['Niacinamide'] },
          expert_notes: [],
          missing_info: ['competitors_missing'],
        },
        provenance: {
          source: 'url_realtime_product_intel',
        },
      },
      parsedProduct: {
        product_id: 'anchor_3',
        name: 'Anchor Product 3',
      },
      lang: 'EN',
    });

    expect(out).toEqual(
      expect.objectContaining({
        enhanced: true,
        reason: null,
        payload: expect.objectContaining({
          competitors: {
            candidates: [{ product_id: 'comp_2', name: 'Comp 2' }],
          },
          related_products: {
            candidates: [{ product_id: 'rel_2', name: 'Rel 2' }],
          },
          internal_debug_codes: expect.arrayContaining([
            'router_reason',
            'reco_dag_fallback_catalog',
            'competitor_sync_direct_recall_used',
            'competitor_sync_enrich_used',
            'competitors_low_coverage',
          ]),
        }),
      }),
    );
  });
});
