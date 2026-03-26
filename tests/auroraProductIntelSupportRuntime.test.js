const { createProductIntelSupportRuntime } = require('../src/auroraBff/productIntelSupportRuntime');

function buildRuntime(overrides = {}) {
  return createProductIntelSupportRuntime({
    isPlainObject: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
    pickFirstTrimmed: (...values) => {
      for (const raw of values) {
        const value = String(raw || '').trim();
        if (value) return value;
      }
      return '';
    },
    uniqCaseInsensitiveStrings: (items = [], max = 32) => {
      const seen = new Set();
      const out = [];
      for (const raw of Array.isArray(items) ? items : []) {
        const value = String(raw || '').trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
        if (out.length >= max) break;
      }
      return out;
    },
    normalizeProductIntelFingerprintToken: (value, { maxLen = 120 } = {}) =>
      String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .slice(0, maxLen),
    canonicalizeProductUrlForIntelKb: (value) => String(value || '').trim().toLowerCase().replace(/\/+$/, ''),
    normalizeProductIntelKbKey: (value) => String(value || '').trim(),
    extractWhitelistedSocialChannels: ({ channels = [] } = {}) => {
      const allow = new Set(['reddit', 'tiktok', 'youtube', 'instagram', 'xhs']);
      return Array.from(new Set((Array.isArray(channels) ? channels : [])
        .map((item) => String(item || '').trim().toLowerCase())
        .filter((item) => allow.has(item))));
    },
    asStringArray: (value) =>
      Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [],
    RECO_DOGFOOD_CONFIG: {
      social: { ttl_ms: 72 * 60 * 60 * 1000 },
    },
    AURORA_COMP_SNAPSHOT_SOFT_TTL_MS: 1000,
    AURORA_PRODUCT_INTEL_NARRATIVE_QUALITY_RETRY_ENABLED: true,
    AURORA_PRODUCT_INTEL_NARRATIVE_QUALITY_RETRY_MAX: 1,
    ...overrides,
  });
}

describe('aurora product intel support runtime', () => {
  test('builds kb keys and read candidates from canonical url', () => {
    const runtime = buildRuntime();

    const key = runtime.buildProductIntelKbKey({
      productUrl: 'HTTPS://Example.com/p/serum/',
      parsedProduct: { product_id: 'sku_1', name: 'Demo Serum' },
      lang: 'EN',
      productHint: 'serum',
    });
    const candidates = runtime.buildProductIntelKbReadCandidates({
      productUrl: 'HTTPS://Example.com/p/serum/',
      parsedProduct: { product_id: 'sku_1', name: 'Demo Serum' },
      lang: 'EN',
      productHint: 'serum',
    });

    expect(key).toBe('url:https://example.com/p/serum');
    expect(runtime.resolveProductIntelKbKeyQuality({
      productUrl: 'https://example.com/p/serum',
      parsedProduct: { product_id: 'sku_1' },
      lang: 'EN',
    })).toBe('url');
    expect(candidates).toEqual([
      'url:https://example.com/p/serum',
      'url:https://example.com/p/serum|lang:EN',
      'url:https://example.com/p/serum|lang:CN',
    ]);
  });

  test('resolves fresh social state and normalizes social provenance channels', () => {
    const runtime = buildRuntime();

    const payload = {
      provenance: {
        social_fresh_until: '2099-01-01T00:00:00.000Z',
        social_channels_used: ['TikTok', 'reddit', 'unknown'],
      },
      evidence: {
        social_signals: {
          platform_scores: {
            youtube: 0.7,
          },
        },
      },
      competitors: {
        candidates: [
          {
            social_summary_user_visible: {
              themes: ['hydrating'],
            },
          },
        ],
      },
    };

    expect(runtime.resolveProductAnalysisSocialState(payload)).toEqual(
      expect.objectContaining({
        shouldRefresh: false,
        fetchMode: 'kb_hit',
        socialSummaryCount: 1,
        socialChannels: ['tiktok', 'reddit', 'youtube'],
      }),
    );

    const patched = runtime.applyProductAnalysisSocialProvenance(payload, {
      social_channels_used: ['Instagram', 'reddit', 'nope'],
    });
    expect(patched.provenance.social_channels_used).toEqual(['instagram', 'reddit']);
  });

  test('refreshes competitor snapshot when snapshot metadata is stale', () => {
    const runtime = buildRuntime({
      AURORA_COMP_SNAPSHOT_SOFT_TTL_MS: 5000,
    });

    expect(runtime.shouldRefreshCompetitorSnapshot({
      provenance: {
        competitor_meta: {
          source: 'snapshot',
          snapshot_age_sec: 7,
        },
      },
    })).toBe(true);

    expect(runtime.shouldRefreshCompetitorSnapshot({
      provenance: {
        competitor_meta: {
          source: 'realtime',
          snapshot_age_sec: 999,
        },
      },
    })).toBe(false);
  });

  test('scores evidence coverage from science, social, and source blocks', () => {
    const runtime = buildRuntime();

    const score = runtime.getProductAnalysisEvidenceCoverageScore({
      evidence: {
        science: {
          key_ingredients: ['niacinamide'],
          mechanisms: ['barrier support'],
          risk_notes: ['dryness'],
        },
        expert_notes: ['patch test first'],
        social_signals: {
          typical_positive: ['glow'],
        },
        sources: [{ type: 'official_page' }],
      },
    });

    expect(score).toBe(1);
    expect(runtime.collectProductIntelEvidenceSourceTypes({
      evidence: {
        sources: [{ type: 'Official_Page' }, { type: 'reddit' }, { type: 'official_page' }],
      },
    })).toEqual(['official_page', 'reddit']);
  });

  test('evaluates narrative quality and retry signals', () => {
    const runtime = buildRuntime();
    const beforePayload = {
      assessment: {
        summary: 'Your profile is oily and sensitive.',
        formula_intent: ['Your profile needs hydration.'],
        how_to_use: {
          timing: '',
          frequency: '',
          steps: [],
          observation_window: '',
          stop_signs: [],
        },
      },
    };
    const afterPayload = {
      assessment: {
        summary: 'This niacinamide serum supports barrier repair and helps reduce excess oil.',
        formula_intent: ['Niacinamide helps regulate sebum and support barrier resilience.'],
        how_to_use: {
          timing: 'PM',
          frequency: 'daily',
          steps: ['Apply after cleansing'],
          observation_window: '2 weeks',
          stop_signs: ['Stop if stinging persists'],
        },
      },
    };

    expect(runtime.hasProfileEchoSummary(beforePayload)).toBe(true);
    expect(runtime.hasValidSummary(beforePayload)).toBe(false);
    expect(runtime.hasStructuredHowToUse(beforePayload)).toBe(false);
    expect(runtime.hasValidNarrativeQuality(beforePayload)).toBe(false);
    expect(runtime.shouldRetryForNarrativeQuality(beforePayload)).toBe(true);

    expect(runtime.hasValidFormulaIntentInPayload(afterPayload)).toBe(true);
    expect(runtime.hasValidNarrativeQuality(afterPayload)).toBe(true);
    expect(runtime.collectNarrativeRetryCodes(beforePayload, afterPayload)).toEqual([
      'formula_intent_retry_used',
      'summary_quality_retry_used',
      'how_to_use_retry_used',
    ]);
  });
});
