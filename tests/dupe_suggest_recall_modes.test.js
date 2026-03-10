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
    expect(result.payload.meta.recommendation_mode).toBe('open_world_only');
    expect(result.payload.meta.profile_mode).toBe('anchor_only');
    expect(result.payload.meta.profile_context_present).toBe(false);
    expect(result.payload.meta.final_source_mix).toContain('open_world');
    expect(result.payload.meta.source_hit_counts.open_world_fallback).toBe(1);
    expect(services.fetchRecoAlternativesForProduct).toHaveBeenCalledWith(expect.objectContaining({
      profileSummary: null,
      recentLogs: [],
      options: expect.objectContaining({
        recommendation_mode: 'open_world_only',
        profile_mode: 'anchor_only',
      }),
    }));
  });

  test('uses personalized hybrid fallback when profile exists and pool is small', async () => {
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
      fetchRecoAlternativesForProduct: jest.fn().mockResolvedValue({
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
        source_mode: 'hybrid_fallback',
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
    expect(result.payload.meta.recommendation_mode).toBe('hybrid_fallback');
    expect(result.payload.meta.profile_mode).toBe('personalized');
    expect(result.payload.meta.profile_context_present).toBe(true);
    expect(result.payload.meta.source_hit_counts.catalog_search).toBeGreaterThanOrEqual(1);
    expect(result.payload.meta.source_hit_counts.open_world_fallback).toBe(1);
    expect(result.payload.meta.final_source_mix).toEqual(expect.arrayContaining(['catalog', 'open_world']));
    expect(services.fetchRecoAlternativesForProduct).toHaveBeenCalledWith(expect.objectContaining({
      profileSummary: expect.objectContaining({ sensitivity: 'High' }),
      recentLogs: expect.any(Array),
      options: expect.objectContaining({
        recommendation_mode: 'hybrid_fallback',
        profile_mode: 'personalized',
      }),
    }));
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
