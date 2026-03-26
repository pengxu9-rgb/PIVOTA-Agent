const {
  createProductIntelRecoContractRuntime,
} = require('../src/auroraBff/productIntelRecoContractRuntime');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (value) return value;
  }
  return '';
}

function uniqCaseInsensitiveStrings(items = [], max = 32) {
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
}

function normalizeMaybePercentScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 1) return Math.max(0, Math.min(1, numeric / 100));
  return Math.max(0, Math.min(1, numeric));
}

function normalizeRecoConfidenceEntry(raw, fallbackReason = 'contract_default') {
  const obj = isPlainObject(raw) ? raw : {};
  const scoreRaw = normalizeMaybePercentScore(obj.score);
  const score = scoreRaw == null ? 0 : scoreRaw;
  const reasons = uniqCaseInsensitiveStrings(Array.isArray(obj.reasons) ? obj.reasons : []);
  if (!reasons.length) reasons.push(fallbackReason);
  return {
    score,
    level: typeof obj.level === 'string' && obj.level.trim() ? obj.level.trim() : 'low',
    reasons,
  };
}

function normalizeRecoConfidenceByBlock(raw) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    competitors: normalizeRecoConfidenceEntry(src.competitors, 'competitors_default'),
    related_products: normalizeRecoConfidenceEntry(src.related_products, 'related_products_default'),
    dupes: normalizeRecoConfidenceEntry(src.dupes, 'dupes_default'),
  };
}

function normalizeRecoProvenance(raw) {
  return isPlainObject(raw) ? { ...raw } : {};
}

function getProductAnalysisInternalMissingCodes(payload) {
  const p = isPlainObject(payload) ? payload : {};
  return uniqCaseInsensitiveStrings([
    ...(Array.isArray(p.missing_info_internal) ? p.missing_info_internal : []),
    ...(Array.isArray(p.internal_debug_codes) ? p.internal_debug_codes : []),
  ]);
}

function buildRuntime(overrides = {}) {
  const deps = {
    isPlainObject,
    pickFirstTrimmed,
    uniqCaseInsensitiveStrings,
    normalizeMaybePercentScore,
    getRecoCandidateSourceTypeToken: jest.fn((candidate) =>
      String(candidate?.source?.type || candidate?.source_type || candidate?.sourceType || '').trim().toLowerCase()),
    getProductAnalysisInternalMissingCodes: jest.fn(getProductAnalysisInternalMissingCodes),
    normalizeRecoBlockForContract: jest.fn((block) => {
      const next = isPlainObject(block) ? { ...block } : {};
      return {
        ...next,
        candidates: Array.isArray(next.candidates) ? next.candidates : [],
      };
    }),
    normalizeRecoConfidenceEntry: jest.fn(normalizeRecoConfidenceEntry),
    normalizeRecoConfidenceByBlock: jest.fn(normalizeRecoConfidenceByBlock),
    normalizeRecoProvenance: jest.fn(normalizeRecoProvenance),
    validateRecoBlocksResponse: jest.fn(() => ({ ok: true, errors: [] })),
    applyProductAnalysisGapContract: jest.fn((payload) => payload),
    getRecoGuardrailCircuitSnapshot: jest.fn(() => ({ open: false, open_until_ms: 0 })),
    markRecoGuardrailCircuitViolation: jest.fn(() => ({ opened: false, snapshot: { open: false, open_until_ms: 0 } })),
    markRecoGuardrailCircuitSuccess: jest.fn(),
    recordRecoGuardrailCircuitOpen: jest.fn(),
    recordRecoGuardrailViolation: jest.fn(),
    recordRecoCandidate: jest.fn(),
    recordRecoExplanationAlignment: jest.fn(),
    setRecoGuardrailRates: jest.fn(),
    AURORA_BFF_RECO_GUARD_ENABLED: true,
    AURORA_PRODUCT_GUARDRAIL_TELEMETRY_ONLY: false,
    AURORA_BFF_RECO_GUARD_CIRCUIT_ENABLED: false,
    AURORA_BFF_RECO_GUARD_STRICT_DEFAULT_MODE: true,
    ...overrides,
  };

  return {
    deps,
    runtime: createProductIntelRecoContractRuntime(deps),
  };
}

describe('createProductIntelRecoContractRuntime', () => {
  test('filters same-brand, on-page, and legacy alternatives from competitors block', () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const { runtime, deps } = buildRuntime();
    const payload = {
      assessment: {
        anchor_product: {
          brand_id: 'AnchorBrand',
        },
      },
      competitors: {
        candidates: [
          {
            product_id: 'keep_1',
            brand_id: 'OtherBrand',
            source: { type: 'catalog_search' },
            score_breakdown: {
              category_use_case_match: 0.92,
              ingredient_functional_similarity: 0.86,
              skin_fit_similarity: 0.8,
            },
            why_candidate: 'Category and ingredient match with skin profile support.',
          },
          {
            product_id: 'drop_same_brand',
            brand_id: 'AnchorBrand',
            source: { type: 'catalog_search' },
          },
          {
            product_id: 'drop_on_page',
            brand_id: 'OtherBrand',
            source: { type: 'on_page_related' },
          },
          {
            product_id: 'drop_legacy_alt',
            brand_id: 'OtherBrand',
            source: { type: 'aurora_alternatives' },
          },
        ],
      },
      related_products: { candidates: [] },
      dupes: { candidates: [] },
      confidence_by_block: {
        competitors: { score: 0.88, level: 'high', reasons: ['seed_reason'] },
      },
      provenance: {
        guardrail_violations: ['existing_violation'],
      },
      internal_debug_codes: ['seed_code'],
      missing_info_internal: ['seed_code'],
    };

    const out = runtime.applyRecoGuardrailToProductAnalysisPayload(payload, {
      logger,
      requestId: 'req_guardrail_contract_1',
    });

    expect(out.competitors.candidates).toHaveLength(1);
    expect(out.competitors.candidates[0].product_id).toBe('keep_1');
    expect(out.internal_debug_codes).toEqual(expect.arrayContaining([
      'seed_code',
      'reco_guardrail_applied',
      'reco_guardrail_same_brand_filtered',
      'reco_guardrail_on_page_filtered',
    ]));
    expect(out.provenance.guardrail_applied).toBe(true);
    expect(out.provenance.guardrail_violations).toEqual(expect.arrayContaining([
      'existing_violation',
      'same_brand',
      'on_page_source',
      'legacy_alternatives_source',
    ]));
    expect(out.confidence_by_block.competitors).toEqual(expect.objectContaining({
      level: 'low',
      reasons: expect.arrayContaining([
        'seed_reason',
        'guardrail_same_brand_filtered',
        'guardrail_on_page_filtered',
        'guardrail_legacy_alternatives_source_filtered',
      ]),
    }));
    expect(deps.recordRecoGuardrailViolation).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('telemetry-only mode preserves candidates but annotates low relevance flags', () => {
    const { runtime } = buildRuntime({
      AURORA_PRODUCT_GUARDRAIL_TELEMETRY_ONLY: true,
    });
    const payload = {
      assessment: {
        anchor_product: {
          brand_id: 'AnchorBrand',
        },
      },
      competitors: {
        candidates: [
          {
            product_id: 'same_brand_1',
            brand_id: 'AnchorBrand',
            source: { type: 'catalog_search' },
          },
          {
            product_id: 'on_page_1',
            brand_id: 'OtherBrand',
            source: { type: 'on_page_related' },
          },
        ],
      },
      related_products: { candidates: [] },
      dupes: { candidates: [] },
      provenance: {},
    };

    const out = runtime.applyRecoGuardrailToProductAnalysisPayload(payload, {
      logger: { info: jest.fn(), warn: jest.fn() },
      requestId: 'req_guardrail_contract_telemetry',
    });

    expect(out.competitors.candidates).toHaveLength(2);
    expect(out.competitors.candidates[0]).toEqual(expect.objectContaining({
      low_relevance: true,
      guardrail_flags: expect.arrayContaining(['same_brand']),
    }));
    expect(out.competitors.candidates[1]).toEqual(expect.objectContaining({
      low_relevance: true,
      guardrail_flags: expect.arrayContaining(['on_page_source']),
    }));
    expect(out.internal_debug_codes).toEqual(expect.arrayContaining(['reco_guardrail_telemetry_only']));
    expect(out.provenance.guardrail_mode).toBe('telemetry_only');
  });

  test('soft-fails invalid reco schema into empty blocks with schema-invalid code', () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const { runtime, deps } = buildRuntime({
      AURORA_BFF_RECO_GUARD_ENABLED: false,
      validateRecoBlocksResponse: jest.fn(() => ({
        ok: false,
        errors: ['competitors invalid'],
      })),
    });
    const payload = {
      competitors: { candidates: [{ product_id: 'bad_comp' }] },
      related_products: { candidates: [{ product_id: 'bad_rel' }] },
      dupes: { candidates: [{ product_id: 'bad_dupe' }] },
      provenance: { source: 'test' },
      internal_debug_codes: ['seed_code'],
    };

    const out = runtime.finalizeProductAnalysisRecoContract(payload, {
      logger,
      requestId: 'req_guardrail_contract_invalid',
    });

    expect(deps.normalizeRecoBlockForContract).toHaveBeenCalledTimes(3);
    expect(out.competitors.candidates).toEqual([]);
    expect(out.related_products.candidates).toEqual([]);
    expect(out.dupes.candidates).toEqual([]);
    expect(out.internal_debug_codes).toEqual(expect.arrayContaining([
      'seed_code',
      'reco_blocks_schema_invalid',
    ]));
    expect(out.missing_info_internal).toEqual(expect.arrayContaining([
      'seed_code',
      'reco_blocks_schema_invalid',
    ]));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errors: ['competitors invalid'],
      }),
      'aurora bff: reco blocks schema invalid; soft-fail fallback applied',
    );
  });
});
