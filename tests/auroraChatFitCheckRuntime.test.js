const { createChatFitCheckRuntime } = require('../src/auroraBff/chatFitCheckRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    logger: {
      warn: jest.fn(),
    },
    isPlainObject: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    coerceNumber: (value) => {
      const next = Number(value);
      return Number.isFinite(next) ? next : null;
    },
    looksLikeSuitabilityRequest: jest.fn(() => true),
    normalizeProductAnalysis: jest.fn((payload) => ({
      payload,
      field_missing: [],
    })),
    enrichProductAnalysisPayload: jest.fn((payload) => payload),
    finalizeProductAnalysisRecoContract: jest.fn((payload) => payload),
    reconcileProductAnalysisConsistency: jest.fn((payload) => payload),
    stripInternalRefsDeep: jest.fn((payload) => ({ ...payload, stripped: true })),
    extractProductInputFromFitCheckText: jest.fn(() => ''),
    resolveProductIntelLlmRoute: jest.fn(() => ({
      llm_provider: 'gemini',
      llm_model: 'gemini-2.5-flash',
    })),
    evaluateAnchorTrustForProductIntel: jest.fn(() => ({
      trusted_anchor: null,
      display_anchor: null,
      usable_for_anchor_id: false,
      trust_level: 'none',
      reason_codes: [],
      candidate_quality: 'none',
      url_consistency: null,
    })),
    AURORA_PRODUCT_STRICT_SKINCARE_FILTER: true,
    AURORA_RULE_RELAX_AGGRESSIVE: false,
    extractJsonObjectByKeys: jest.fn(() => null),
    mapAuroraProductParse: jest.fn((payload) => payload),
    normalizeProductParse: jest.fn(() => ({
      payload: {},
      field_missing: [],
    })),
    canonicalizeIngredientCandidates: jest.fn((items) => items),
    classifyProductType: jest.fn(() => ({
      product_type: 'serum',
      usage_overrides: null,
    })),
    buildProductDeepScanPrompt: jest.fn(({ productDescriptor }) => `scan:${productDescriptor}`),
    auroraChat: jest.fn(async () => null),
    AURORA_DECISION_BASE_URL: 'http://aurora.local',
    AURORA_CHAT_UPSTREAM_TIMEOUT_MS: 16000,
    mapAuroraProductAnalysis: jest.fn((payload) => payload),
    getProductAnalysisInternalMissingCodes: jest.fn(() => []),
    applyProductAnalysisGapContract: jest.fn((payload) => payload),
    shouldRetryForNarrativeQuality: jest.fn(() => false),
    normalizeProductAnalysisFromUpstream: jest.fn(() => ({
      payload: {},
      field_missing: [],
    })),
    collectNarrativeRetryCodes: jest.fn(() => []),
    hasValidNarrativeQuality: jest.fn(() => false),
    isProductIntelPayloadCandidateBetter: jest.fn(() => false),
    resolveProductIntelEscalationRoute: jest.fn(() => null),
    shouldTriggerProductIntelEscalation: jest.fn(() => false),
    appendProductIntelSourceChain: jest.fn((payload) => payload),
    attachProductIntelLlmRouteProvenance: jest.fn((payload) => payload),
    mergeFieldMissing: jest.fn((left, right) => [
      ...(Array.isArray(left) ? left : []),
      ...(Array.isArray(right) ? right : []),
    ]),
    uniqCaseInsensitiveStrings: jest.fn((items) => {
      const out = [];
      const seen = new Set();
      for (const raw of Array.isArray(items) ? items : []) {
        const value = String(raw || '').trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
      }
      return out;
    }),
    PRODUCT_URL_INGREDIENT_ANALYSIS_ENABLED: false,
    buildProductAnalysisFromUrlIngredients: jest.fn(async () => null),
    pickFirstTrimmed: (...values) => {
      for (const raw of values) {
        const value = String(raw || '').trim();
        if (value) return value;
      }
      return '';
    },
    buildContextPrefix: jest.fn(() => ''),
    ...overrides,
  };

  return {
    deps,
    runtime: createChatFitCheckRuntime(deps),
  };
}

function buildArgs(overrides = {}) {
  return {
    ctx: {
      request_id: 'req_fit_check_1',
      lang: 'EN',
      state: 'idle',
      trigger_source: 'text',
    },
    req: {},
    cards: [],
    derivedCards: [],
    anchorFromContext: null,
    responseIntentMessage: 'Is this suitable for me?',
    profileSummary: { skinType: 'oily', goals: ['acne'] },
    profile: { skinType: 'oily' },
    recentLogs: [{ id: 'log_1' }],
    anchorProductUrl: '',
    anchorProductId: '',
    llmProvider: 'gemini',
    llmModel: 'gemini-2.5-flash',
    debugUpstream: false,
    ...overrides,
  };
}

describe('aurora chat fit-check runtime', () => {
  test('maps upstream anchor context into a derived product_analysis card', async () => {
    const { runtime, deps } = buildRuntime({
      normalizeProductAnalysis: jest.fn((payload) => ({
        payload,
        field_missing: [{ field: 'assessment', reason: 'partial' }],
      })),
    });

    const cards = await runtime.buildFitCheckCards(
      buildArgs({
        anchorFromContext: {
          brand: 'Brand',
          name: 'Serum',
          score: { total: 82, science: 79 },
          kb_profile: {
            keyActives: ['Niacinamide'],
          },
        },
      }),
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual(
      expect.objectContaining({
        type: 'product_analysis',
        field_missing: [{ field: 'assessment', reason: 'partial' }],
      }),
    );
    expect(cards[0].payload.assessment).toEqual(
      expect.objectContaining({
        verdict: expect.any(String),
      }),
    );
    expect(deps.auroraChat).not.toHaveBeenCalled();
  });

  test('runs fit-check deep scan fallback when no product_analysis card exists', async () => {
    const { runtime, deps } = buildRuntime({
      extractProductInputFromFitCheckText: jest.fn(() => 'The Ordinary Niacinamide 10% + Zinc 1%'),
      auroraChat: jest.fn(async () => ({
        structured: {
          assessment: { verdict: 'Suitable' },
          evidence: { science: { key_ingredients: ['Niacinamide'] } },
          confidence: 0.86,
          missing_info: [],
        },
      })),
    });

    const cards = await runtime.buildFitCheckCards(
      buildArgs({
        anchorProductId: 'sku_fit_1',
      }),
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual(
      expect.objectContaining({
        type: 'product_analysis',
      }),
    );
    expect(deps.auroraChat).toHaveBeenCalledWith(
      expect.objectContaining({
        anchor_product_id: 'sku_fit_1',
      }),
    );
    expect(deps.appendProductIntelSourceChain).toHaveBeenCalled();
    expect(deps.attachProductIntelLlmRouteProvenance).toHaveBeenCalled();
  });

  test('skips fit-check work when a product_analysis card already exists', async () => {
    const { runtime, deps } = buildRuntime();

    const cards = await runtime.buildFitCheckCards(
      buildArgs({
        cards: [{ type: 'product_analysis', payload: { assessment: { verdict: 'Suitable' } } }],
        anchorFromContext: {
          brand: 'Brand',
          name: 'Serum',
        },
      }),
    );

    expect(cards).toEqual([]);
    expect(deps.extractProductInputFromFitCheckText).not.toHaveBeenCalled();
    expect(deps.auroraChat).not.toHaveBeenCalled();
  });
});
