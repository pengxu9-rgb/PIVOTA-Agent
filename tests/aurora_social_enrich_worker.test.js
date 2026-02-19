const {
  runSocialEnrichWorker,
  getSocialEnrichCacheStats,
  __internal,
} = require('../src/auroraBff/socialEnrichWorker');

function makePayload() {
  return {
    assessment: {
      verdict: 'Likely Suitable',
      anchor_product: {
        product_id: 'anchor_1',
        brand: 'Anchor Brand',
        name: 'Anchor Serum',
        category: 'serum',
      },
    },
    evidence: {
      science: {
        key_ingredients: ['niacinamide', 'panthenol'],
      },
      social_signals: {
        typical_positive: [],
        typical_negative: [],
        risk_for_groups: [],
      },
      expert_notes: [],
      missing_info: [],
    },
    competitors: {
      candidates: [
        {
          product_id: 'cand_1',
          name: 'Candidate One',
          brand_id: 'other_brand',
          source: { type: 'catalog_search' },
          evidence_refs: [],
          why_candidate: {
            summary: 'placeholder',
            reasons_user_visible: ['placeholder'],
          },
        },
      ],
    },
    related_products: {
      candidates: [],
    },
    dupes: {
      candidates: [],
    },
    provenance: {
      pipeline: 'reco_blocks_dag.v1',
    },
  };
}

describe('aurora social enrich worker', () => {
  beforeEach(() => {
    __internal.socialFetchCache.clear();
    __internal.socialFetchStats.hit = 0;
    __internal.socialFetchStats.miss = 0;
  });

  test('applies social signals into candidates and produces payload patch', async () => {
    const applyAsyncPatch = jest.fn(() => ({ applied: true, changedCount: 1 }));
    const onAsyncUpdate = jest.fn();
    const out = await runSocialEnrichWorker({
      payload: makePayload(),
      lang: 'EN',
      mode: 'main_path',
      skip_kb_write: true,
      fetch_fn: async () => ({
        ok: true,
        reason: null,
        signals_by_key: {
          cand_1: {
            channels: ['reddit', 'youtube'],
            topic_keywords: ['barrier repair', 'hydration'],
            co_mention_strength: 0.82,
            sentiment_proxy: 0.73,
            context_match: 0.65,
          },
        },
        channels_used: ['reddit', 'youtube'],
        source_version: 'social_v1',
      }),
      apply_async_patch: applyAsyncPatch,
      on_async_update: onAsyncUpdate,
    });

    expect(out.ok).toBe(true);
    expect(out.changed_blocks).toContain('competitors');
    expect(out.kb_backfilled).toBe(false);
    expect(out.payload_patch?.provenance?.social_fetch_mode).toBe('async_refresh');
    expect(out.payload_patch?.provenance?.social_source_version).toBe('social_v1');
    expect(out.payload_patch?.provenance?.social_channels_used).toEqual(['reddit', 'youtube']);

    const competitorRows = out.payload_patch?.competitors?.candidates || [];
    expect(competitorRows.length).toBe(1);
    expect(competitorRows[0].social_summary_user_visible).toBeTruthy();
    expect(Array.isArray(competitorRows[0].evidence_refs)).toBe(true);

    expect(applyAsyncPatch).toHaveBeenCalledTimes(1);
    expect(onAsyncUpdate).toHaveBeenCalledTimes(1);
    expect(onAsyncUpdate.mock.calls[0][0].block).toBe('competitors');
  });

  test('returns soft-fail for empty social signals', async () => {
    const out = await runSocialEnrichWorker({
      payload: makePayload(),
      lang: 'EN',
      mode: 'main_path',
      skip_kb_write: true,
      fetch_fn: async () => ({
        ok: true,
        reason: null,
        signals_by_key: {},
        channels_used: [],
      }),
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('empty_social_signals');
  });

  test('deduplicates identical requests via in-memory cache', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      reason: null,
      signals_by_key: {
        cand_1: {
          channels: ['reddit'],
          topic_keywords: ['hydration'],
          co_mention_strength: 0.7,
          sentiment_proxy: 0.7,
          context_match: 0.6,
        },
      },
      channels_used: ['reddit'],
      source_version: 'social_v1',
    }));

    const first = await runSocialEnrichWorker({
      payload: makePayload(),
      lang: 'EN',
      mode: 'main_path',
      skip_kb_write: true,
      fetch_fn: fetchFn,
    });
    const second = await runSocialEnrichWorker({
      payload: makePayload(),
      lang: 'EN',
      mode: 'main_path',
      skip_kb_write: true,
      fetch_fn: fetchFn,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second.from_cache).toBe(true);

    const cacheStats = getSocialEnrichCacheStats();
    expect(cacheStats.hit).toBeGreaterThanOrEqual(1);
  });
});
