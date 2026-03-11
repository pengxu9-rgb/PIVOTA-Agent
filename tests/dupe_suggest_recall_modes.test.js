'use strict';

const { executeDupeSuggest } = require('../src/auroraBff/usecases/dupeSuggest');
const { applyDupeSuggestQualityGate } = require('../src/auroraBff/qualityGates/dupeSuggestGate');

function makeCtx() {
  return {
    lang: 'EN',
    request_id: 'req_dupe_recall_test',
    trace_id: 'trace_dupe_recall_test',
    trigger_source: 'text',
    state: 'idle',
  };
}

function makeBaseServices(overrides = {}) {
  return {
    getDupeKbEntry: jest.fn().mockResolvedValue(null),
    upsertDupeKbEntry: jest.fn().mockResolvedValue(undefined),
    normalizeDupeKbKey: jest.fn((value) => String(value || '').trim()),
    searchPivotaBackendProducts: jest.fn().mockResolvedValue({ ok: true, products: [] }),
    buildRecoAlternativesCandidatePool: jest.fn().mockReturnValue([]),
    fetchRecoAlternativesForProduct: jest.fn().mockResolvedValue({
      alternatives: [],
      field_missing: [],
      source_mode: 'open_world_only',
      template_id: 'reco_alternatives_hybrid_v1',
    }),
    auroraChat: jest.fn().mockResolvedValue(null),
    buildContextPrefix: jest.fn(() => ''),
    getUpstreamStructuredOrJson: jest.fn(() => null),
    extractJsonObjectByKeys: jest.fn(() => null),
    ...overrides,
  };
}

describe('executeDupeSuggest recall modes', () => {
  test('supplements placeholder-only pool results with open-world results instead of returning empty', async () => {
    const fetchRecoAlternativesForProduct = jest
      .fn()
      .mockResolvedValueOnce({
        alternatives: [
          {
            kind: 'similar',
            candidate_origin: 'catalog',
            grounding_status: 'catalog_verified',
            ranking_mode: 'anchor_only',
            product: { brand: 'Weak Catalog', name: 'Weak Catalog Lotion', product_id: 'weak_1' },
            similarity: 0,
            confidence: 0,
            reasons: ['Grounded alternatives derived from resolved candidate pool.'],
            tradeoffs: ['Category: moisturizer'],
            missing_info: ['tradeoffs_detail_missing'],
          },
        ],
        field_missing: [],
        source_mode: 'pool_only',
        template_id: 'reco_alternatives_v1_0',
      })
      .mockResolvedValueOnce({
        alternatives: [
          {
            kind: 'dupe',
            candidate_origin: 'open_world',
            grounding_status: 'name_only',
            ranking_mode: 'anchor_only',
            product: { brand: 'Open Brand', name: 'Real Lightweight Moisturizer' },
            similarity: 73,
            confidence: 0.46,
            reasons: ['Similar lightweight daily moisturizer role'],
            tradeoffs: ['Exact formula overlap remains uncertain'],
            missing_info: ['formula_overlap_uncertain'],
          },
        ],
        field_missing: [],
        source_mode: 'open_world_only',
        template_id: 'reco_alternatives_hybrid_v1',
      });

    const services = makeBaseServices({
      searchPivotaBackendProducts: jest.fn().mockResolvedValue({
        ok: true,
        products: [
          { product_id: 'cand_1', sku_id: 'cand_1', brand: 'Catalog', display_name: 'Catalog Lotion 1', category: 'moisturizer' },
          { product_id: 'cand_2', sku_id: 'cand_2', brand: 'Catalog', display_name: 'Catalog Lotion 2', category: 'moisturizer' },
          { product_id: 'cand_3', sku_id: 'cand_3', brand: 'Catalog', display_name: 'Catalog Lotion 3', category: 'moisturizer' },
        ],
      }),
      fetchRecoAlternativesForProduct,
    });

    const result = await executeDupeSuggest({
      ctx: makeCtx(),
      input: {
        original: {
          brand: 'Anchor Brand',
          name: 'Anchor Lightweight Lotion',
          category: 'moisturizer',
        },
      },
      profileSummary: null,
      recentLogs: [],
      services,
      logger: null,
      flags: {
        AURORA_DECISION_BASE_URL: '',
        DUPE_KB_ASYNC_BACKFILL_ENABLED: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.payload.dupes).toHaveLength(1);
    expect(result.payload.comparables).toHaveLength(0);
    expect(result.payload.meta.recommendation_mode_initial).toBe('pool_only');
    expect(result.payload.meta.recommendation_mode_final).toBe('open_world_only');
    expect(result.payload.meta.open_world_supplement_used).toBe(true);
    expect(result.payload.meta.escalated_to_open_world).toBe(true);
    expect(result.payload.meta.final_source_mix).toEqual(['open_world']);
    expect(result.payload.meta.viability_failure_reasons).toEqual(expect.arrayContaining(['placeholder_candidates_removed']));
    expect(fetchRecoAlternativesForProduct).toHaveBeenCalledTimes(2);
    expect(fetchRecoAlternativesForProduct).toHaveBeenNthCalledWith(1, expect.objectContaining({
      options: expect.objectContaining({
        recommendation_mode: 'pool_only',
        disable_fallback: true,
        disable_synthetic_local_fallback: true,
      }),
    }));
    expect(fetchRecoAlternativesForProduct).toHaveBeenNthCalledWith(2, expect.objectContaining({
      candidatePool: [],
      options: expect.objectContaining({
        recommendation_mode: 'open_world_only',
        disable_fallback: true,
        ignore_selector_candidates: true,
        disable_synthetic_local_fallback: true,
      }),
    }));
    expect(fetchRecoAlternativesForProduct.mock.calls.some(([args]) => args.options.recommendation_mode === 'hybrid_fallback')).toBe(false);
  });

  test('uses anchor-only open-world fallback when profile is absent and pool is empty', async () => {
    const services = makeBaseServices({
      fetchRecoAlternativesForProduct: jest.fn().mockResolvedValue({
        alternatives: [
          {
            kind: 'dupe',
            candidate_origin: 'open_world',
            grounding_status: 'name_only',
            ranking_mode: 'anchor_only',
            product: { brand: 'Alt Brand', name: 'Anchor Only Lotion' },
            similarity: 74,
            reasons: ['Similar daily lightweight moisturizer role'],
            tradeoffs: ['Formula overlap is uncertain'],
            confidence: 0.42,
            missing_info: ['profile_not_provided'],
          },
        ],
        field_missing: [],
        source_mode: 'open_world_only',
        template_id: 'reco_alternatives_hybrid_v1',
      }),
    });

    const result = await executeDupeSuggest({
      ctx: makeCtx(),
      input: {
        original: {
          brand: 'Lab Series',
          name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
        },
      },
      profileSummary: null,
      recentLogs: [],
      services,
      logger: null,
      flags: {
        AURORA_DECISION_BASE_URL: '',
        DUPE_KB_ASYNC_BACKFILL_ENABLED: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.payload.dupes).toHaveLength(1);
    expect(result.payload.meta.open_world_supplement_used).toBe(true);
    expect(result.payload.meta.recommendation_mode).toBe('open_world_only');
    expect(result.payload.meta.profile_mode).toBe('anchor_only');
    expect(result.payload.meta.profile_context_present).toBe(false);
    expect(result.payload.meta.has_anchor_identity).toBe(true);
    expect(result.payload.meta.final_source_mix).toContain('open_world');
    expect(result.payload.meta.source_hit_counts.open_world_fallback).toBe(1);
    expect(services.fetchRecoAlternativesForProduct).toHaveBeenCalledTimes(1);
    expect(services.fetchRecoAlternativesForProduct).toHaveBeenCalledWith(expect.objectContaining({
      profileSummary: null,
      recentLogs: [],
      candidatePool: [],
      options: expect.objectContaining({
        recommendation_mode: 'open_world_only',
        disable_fallback: true,
        profile_mode: 'anchor_only',
        disable_synthetic_local_fallback: true,
        ignore_selector_candidates: true,
      }),
    }));
  });

  test('supplements personalized pool-only results with open-world results when capacity is not filled', async () => {
    const services = makeBaseServices({
      searchPivotaBackendProducts: jest.fn().mockResolvedValue({
        ok: true,
        products: [
          {
            product_id: 'cand_1',
            sku_id: 'cand_1',
            brand: 'Catalog Brand',
            display_name: 'Catalog Barrier Serum',
            category: 'serum',
            price_usd: 24,
          },
        ],
      }),
      fetchRecoAlternativesForProduct: jest.fn()
        .mockResolvedValueOnce({
          alternatives: [
            {
              kind: 'dupe',
              candidate_origin: 'catalog',
              grounding_status: 'catalog_verified',
              ranking_mode: 'personalized',
              product: { brand: 'Catalog Brand', name: 'Catalog Barrier Serum', product_id: 'cand_1', sku_id: 'cand_1' },
              similarity: 79,
              reasons: ['Close hydrating serum role with milder positioning'],
              tradeoffs: ['Lower active certainty than the anchor'],
              confidence: 0.58,
              profile_fit_reason: ['Better match for high sensitivity'],
              missing_info: [],
            },
          ],
          field_missing: [],
          source_mode: 'pool_only',
          template_id: 'reco_alternatives_v1_0',
        })
        .mockResolvedValueOnce({
          alternatives: [
            {
              kind: 'similar',
              candidate_origin: 'open_world',
              grounding_status: 'name_only',
              ranking_mode: 'personalized',
              product: { brand: 'Open Brand', name: 'Open World Sensitive Serum' },
              similarity: 66,
              reasons: ['Looks gentler for compromised barrier routines'],
              tradeoffs: ['Exact ingredient overlap is unclear'],
              confidence: 0.39,
              profile_fit_reason: ['Safer fallback for barrier-impaired skin'],
              missing_info: ['formula_overlap_uncertain'],
            },
          ],
          field_missing: [],
          source_mode: 'open_world_only',
          template_id: 'reco_alternatives_hybrid_v1',
        }),
    });

    const result = await executeDupeSuggest({
      ctx: makeCtx(),
      input: {
        original: {
          brand: 'Anchor Brand',
          name: 'Barrier Support Serum',
          category: 'serum',
        },
      },
      profileSummary: {
        skinType: 'Dry',
        sensitivity: 'High',
        barrierStatus: 'Impaired',
        goals: ['Redness/Barrier repair'],
      },
      recentLogs: [{ day: '2026-03-09', redness: 'high' }],
      services,
      logger: null,
      flags: {
        AURORA_DECISION_BASE_URL: '',
        DUPE_KB_ASYNC_BACKFILL_ENABLED: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.payload.dupes).toHaveLength(1);
    expect(result.payload.comparables).toHaveLength(1);
    expect(result.payload.dupes[0].product.product_id).toBe('cand_1');
    expect(result.payload.meta.recommendation_mode).toBe('open_world_only');
    expect(result.payload.meta.profile_mode).toBe('personalized');
    expect(result.payload.meta.profile_context_present).toBe(true);
    expect(result.payload.meta.has_anchor_identity).toBe(true);
    expect(result.payload.meta.open_world_supplement_used).toBe(true);
    expect(result.payload.meta.source_hit_counts.catalog_search).toBeGreaterThanOrEqual(1);
    expect(result.payload.meta.source_hit_counts.open_world_fallback).toBe(1);
    expect(result.payload.meta.final_source_mix).toEqual(expect.arrayContaining(['catalog', 'open_world']));
    expect(services.fetchRecoAlternativesForProduct).toHaveBeenCalledTimes(2);
    expect(services.fetchRecoAlternativesForProduct).toHaveBeenNthCalledWith(1, expect.objectContaining({
      profileSummary: expect.objectContaining({ sensitivity: 'High' }),
      recentLogs: expect.any(Array),
      options: expect.objectContaining({
        recommendation_mode: 'pool_only',
        disable_fallback: true,
        profile_mode: 'personalized',
        disable_synthetic_local_fallback: true,
      }),
    }));
    expect(services.fetchRecoAlternativesForProduct).toHaveBeenNthCalledWith(2, expect.objectContaining({
      candidatePool: [],
      options: expect.objectContaining({
        recommendation_mode: 'open_world_only',
        disable_fallback: true,
        profile_mode: 'personalized',
        disable_synthetic_local_fallback: true,
        ignore_selector_candidates: true,
      }),
    }));
  });

  test('invalidates legacy verified KB entries and regenerates fresh results', async () => {
    const services = makeBaseServices({
      getDupeKbEntry: jest.fn().mockResolvedValue({
        kb_key: 'text:the ordinary niacinamide',
        original: {
          brand: 'The Ordinary',
          name: 'Niacinamide 10% + Zinc 1%',
        },
        dupes: [
          {
            kind: 'dupe',
            product: { brand: null, name: 'The Ordinary Niacinamide 10% + Zinc 1% (budget dupe)' },
            similarity: 78,
            confidence: 0.78,
            tradeoffs: ['fallback_reason: upstream_missing_or_empty'],
            missing_info: ['local_fallback_seed'],
          },
        ],
        comparables: [],
        verified: true,
        source: 'llm_generate',
        source_meta: {},
      }),
      fetchRecoAlternativesForProduct: jest.fn().mockResolvedValue({
        alternatives: [
          {
            kind: 'dupe',
            candidate_origin: 'open_world',
            grounding_status: 'name_only',
            ranking_mode: 'anchor_only',
            product: { brand: 'Good Molecules', name: 'Niacinamide Serum' },
            similarity: 68,
            confidence: 0.41,
            reasons: ['Similar niacinamide-focused serum role'],
            tradeoffs: ['Texture and exact concentration overlap remain uncertain'],
            missing_info: ['active_concentrations_missing'],
          },
        ],
        field_missing: [],
        source_mode: 'open_world_only',
        template_id: 'reco_alternatives_hybrid_v1',
      }),
    });

    const result = await executeDupeSuggest({
      ctx: makeCtx(),
      input: {
        original: {
          brand: 'The Ordinary',
          name: 'Niacinamide 10% + Zinc 1%',
          category: 'serum',
        },
      },
      profileSummary: null,
      recentLogs: [],
      services,
      logger: null,
      flags: {
        AURORA_DECISION_BASE_URL: '',
        DUPE_KB_ASYNC_BACKFILL_ENABLED: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.event_source).toBe('llm');
    expect(result.payload.meta.served_from_kb).toBe(false);
    expect(result.payload.dupes).toHaveLength(1);
    expect(services.fetchRecoAlternativesForProduct).toHaveBeenCalled();
    expect(services.upsertDupeKbEntry).toHaveBeenCalledWith(expect.objectContaining({
      source_meta: expect.objectContaining({
        contract_version: 'dupe_suggest_v4',
      }),
    }));
  });

  test('keeps live results but blocks KB persistence when items are not KB-worthy', async () => {
    const services = makeBaseServices({
      searchPivotaBackendProducts: jest.fn().mockResolvedValue({
        ok: true,
        products: [
          {
            product_id: 'cand_1',
            sku_id: 'cand_1',
            brand: 'Catalog Brand',
            display_name: 'Catalog Brightening Serum',
            category: 'serum',
          },
        ],
      }),
      fetchRecoAlternativesForProduct: jest.fn().mockResolvedValue({
        alternatives: [
          {
            kind: 'dupe',
            candidate_origin: 'catalog',
            grounding_status: 'catalog_verified',
            ranking_mode: 'anchor_only',
            product: { brand: 'Catalog Brand', name: 'Catalog Brightening Serum', product_id: 'cand_1', sku_id: 'cand_1' },
            similarity: 0,
            confidence: 0,
            reasons: ['Niacinamide-led brightening overlap with a similar serum use case.'],
            tradeoffs: [],
            missing_info: ['formula_overlap_uncertain'],
          },
        ],
        field_missing: [],
        source_mode: 'pool_only',
        template_id: 'reco_alternatives_v1_0',
      }),
    });

    const result = await executeDupeSuggest({
      ctx: makeCtx(),
      input: {
        original: {
          brand: 'The Ordinary',
          name: 'Niacinamide 10% + Zinc 1%',
          category: 'serum',
        },
      },
      profileSummary: null,
      recentLogs: [],
      services,
      logger: null,
      flags: {
        AURORA_DECISION_BASE_URL: '',
        DUPE_KB_ASYNC_BACKFILL_ENABLED: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.payload.dupes).toHaveLength(1);
    expect(result.payload.meta.kb_backfill_blocked_reason).toBe('all_items_hollow');
    expect(services.upsertDupeKbEntry).not.toHaveBeenCalled();
  });

  test('returns envelope-safe field_missing entries as objects, not strings', async () => {
    const services = makeBaseServices({
      fetchRecoAlternativesForProduct: jest.fn().mockResolvedValue({
        alternatives: [
          {
            kind: 'dupe',
            candidate_origin: 'open_world',
            grounding_status: 'name_only',
            ranking_mode: 'anchor_only',
            product: { brand: 'Good Molecules', name: 'Niacinamide Serum' },
            similarity: 68,
            confidence: 0.41,
            reasons: ['Similar niacinamide-focused serum role'],
            tradeoffs: ['Exact concentration overlap remains uncertain'],
            missing_info: ['active_concentrations_missing'],
          },
        ],
        field_missing: [{ field: 'alternatives', reason: 'upstream_missing_or_empty' }],
        source_mode: 'open_world_only',
        template_id: 'reco_alternatives_hybrid_v1',
      }),
    });

    const result = await executeDupeSuggest({
      ctx: makeCtx(),
      input: {
        original: {
          brand: 'The Ordinary',
          name: 'Niacinamide 10% + Zinc 1%',
          category: 'serum',
        },
      },
      profileSummary: null,
      recentLogs: [],
      services,
      logger: null,
      flags: {
        AURORA_DECISION_BASE_URL: '',
        DUPE_KB_ASYNC_BACKFILL_ENABLED: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.field_missing).toEqual([
      { field: 'alternatives', reason: 'upstream_missing_or_empty' },
    ]);
    expect(result.payload.field_missing).toEqual([
      { field: 'alternatives', reason: 'upstream_missing_or_empty' },
    ]);
  });
});

describe('applyDupeSuggestQualityGate', () => {
  test('does not gate open-world results only because candidate pool is empty', () => {
    const payload = {
      original: { brand: 'Anchor', name: 'Anchor Product' },
      dupes: [
        {
          kind: 'dupe',
          candidate_origin: 'open_world',
          product: { brand: 'Open Brand', name: 'Open World Alternative' },
          similarity: 72,
          confidence: 0.41,
          tradeoffs: ['Exact formula overlap is unknown'],
        },
      ],
      comparables: [],
      verified: true,
      candidate_pool_meta: { count: 0, sources_used: [], degraded: true },
      quality: { quality_ok: true, quality_issues: [] },
      meta: { final_empty_reason: null },
    };

    const result = applyDupeSuggestQualityGate(payload, { lang: 'EN' });
    expect(result.gated).toBe(false);
  });
});
