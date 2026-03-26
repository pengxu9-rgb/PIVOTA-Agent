const {
  createProductIntelPolicyRuntime,
} = require('../src/auroraBff/productIntelPolicyRuntime');

describe('createProductIntelPolicyRuntime', () => {
  function buildRuntime(overrides = {}) {
    return createProductIntelPolicyRuntime({
      isPlainObject: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
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
      normalizeInciIngredientName: (value) => String(value || '').trim().toLowerCase(),
      pickFirstTrimmed: (...values) => {
        for (const raw of values) {
          const value = String(raw || '').trim();
          if (value) return value;
        }
        return '';
      },
      collectProductIntelEvidenceSourceTypes: (payload) => {
        const sources = Array.isArray(payload?.evidence?.sources) ? payload.evidence.sources : [];
        return sources
          .map((item) => String(item?.type || '').trim().toLowerCase())
          .filter(Boolean);
      },
      getProductAnalysisEvidenceCoverageScore: jest.fn(() => 0.2),
      hasValidFormulaIntentInPayload: jest.fn((payload) =>
        Array.isArray(payload?.assessment?.formula_intent) && payload.assessment.formula_intent.length > 0),
      getProductAnalysisInternalMissingCodes: (payload) => {
        const out = [];
        for (const list of [
          payload?.internal_debug_codes,
          payload?.missing_info_internal,
          payload?.missing_info,
        ]) {
          for (const raw of Array.isArray(list) ? list : []) {
            const value = String(raw || '').trim();
            if (value) out.push(value);
          }
        }
        return Array.from(new Set(out));
      },
      AURORA_RULE_RELAX_MODE: 'aggressive',
      AURORA_KB_WRITE_POLICY: 'strict',
      AURORA_KB_SERVE_POLICY: 'strict',
      ...overrides,
    });
  }

  test('blocks KB write when inci decoder is the only evidence source', () => {
    const runtime = buildRuntime();

    const decision = runtime.shouldPersistProductIntelKb({
      assessment: { verdict: 'Likely Suitable' },
      evidence: {
        science: {
          key_ingredients: ['Niacinamide', 'Glycerin', 'Panthenol'],
        },
        sources: [
          { type: 'inci_decoder', url: 'https://incidecoder.com/products/demo-product' },
        ],
      },
      ingredient_intel: {
        inci_normalized: ['Niacinamide', 'Glycerin', 'Panthenol'],
      },
    });

    expect(decision).toEqual(
      expect.objectContaining({
        attempted: true,
        persisted: false,
        blocked_reason: 'incidecoder_unverified_not_persisted',
      }),
    );
  });

  test('allow_all policy keeps KB write enabled and records audit blocked reason', () => {
    const runtime = buildRuntime({
      AURORA_KB_WRITE_POLICY: 'allow_all',
    });

    const decision = runtime.shouldPersistProductIntelKb({
      assessment: { verdict: 'Likely Suitable' },
      evidence: {
        science: {
          key_ingredients: ['Niacinamide', 'Glycerin', 'Panthenol'],
        },
        sources: [
          { type: 'inci_decoder', url: 'https://incidecoder.com/products/demo-product' },
        ],
      },
      ingredient_intel: {
        inci_normalized: ['Niacinamide', 'Glycerin', 'Panthenol'],
      },
    });

    expect(decision).toEqual(
      expect.objectContaining({
        attempted: true,
        persisted: true,
        blocked_reason: 'incidecoder_unverified_not_persisted',
        audit_blocked_reason: 'incidecoder_unverified_not_persisted',
        policy: 'allow_all',
      }),
    );
  });

  test('annotates KB write decision with provenance bands and guardrail flags', () => {
    const runtime = buildRuntime({
      getProductAnalysisEvidenceCoverageScore: jest.fn(() => 0.8),
    });
    const payload = {
      confidence_score: 0.91,
      assessment: { verdict: 'Likely Suitable' },
      provenance: {
        guardrail_violations: ['guardrail_source_missing'],
      },
      internal_debug_codes: ['guardrail_formula_unclear'],
    };

    const result = runtime.annotateProductIntelKbWriteDecision(payload, {
      attempted: true,
      persisted: false,
      blocked_reason: 'incidecoder_unverified_not_persisted',
      audit_blocked_reason: 'incidecoder_unverified_not_persisted',
    });

    expect(result.provenance).toEqual(
      expect.objectContaining({
        gate_relax_mode: 'aggressive',
        kb_write_policy: 'strict',
        kb_serve_policy: 'strict',
        confidence_band: 'high',
        quality_band: 'high',
      }),
    );
    expect(result.provenance.kb_write).toEqual(
      expect.objectContaining({
        attempted: true,
        persisted: false,
        blocked_reason: 'incidecoder_unverified_not_persisted',
      }),
    );
    expect(result.provenance.guardrail_flags).toEqual(
      expect.arrayContaining(['guardrail_source_missing', 'guardrail_formula_unclear']),
    );
    expect(result.missing_info).toContain('incidecoder_unverified_not_persisted');
    expect(result.internal_debug_codes).toContain('incidecoder_unverified_not_persisted');
  });

  test('adds relaxed provenance labels and quarantine reasons', () => {
    const runtime = buildRuntime({
      getProductAnalysisEvidenceCoverageScore: jest.fn(() => 0.55),
    });
    const payload = {
      confidence: { score: 0.6 },
      assessment: { verdict: 'Likely Suitable' },
      provenance: { source_chain: ['kb_hit'] },
    };

    const result = runtime.annotateProductIntelRelaxedProvenance(payload, {
      quarantineReasons: ['low_evidence'],
    });

    expect(result.provenance).toEqual(
      expect.objectContaining({
        confidence_band: 'medium',
        quality_band: 'medium',
        kb_write_policy: 'strict',
        kb_serve_policy: 'strict',
        gate_relax_mode: 'aggressive',
      }),
    );
    expect(result.provenance.source_chain).toEqual(expect.arrayContaining(['kb_hit', 'llm_extraction']));
    expect(result.provenance.kb_quarantine_reasons).toEqual(['low_evidence']);
  });

  test('drives escalation, candidate comparison, and llm route provenance', () => {
    const runtime = buildRuntime({
      getProductAnalysisEvidenceCoverageScore: jest.fn((payload) => Number(payload?.coverage_score || 0)),
      hasValidFormulaIntentInPayload: jest.fn((payload) => Boolean(payload?.has_formula_intent)),
    });

    expect(runtime.shouldTriggerProductIntelEscalation({
      assessment: { verdict: 'Unknown' },
      has_formula_intent: true,
      coverage_score: 0.2,
    })).toBe(true);
    expect(runtime.shouldTriggerProductIntelEscalation({
      assessment: { verdict: 'Likely Suitable' },
      has_formula_intent: true,
      coverage_score: 0.2,
    })).toBe(false);

    expect(runtime.isProductIntelPayloadCandidateBetter(
      {
        assessment: { verdict: 'Likely Suitable' },
        coverage_score: 0.7,
      },
      {
        assessment: { verdict: 'Unknown' },
        coverage_score: 0.3,
      },
    )).toBe(true);

    const chained = runtime.appendProductIntelSourceChain(
      { provenance: { source_chain: ['stage_1'] } },
      ['llm_extraction', 'stage_1'],
    );
    expect(chained.provenance.source_chain).toEqual(['stage_1', 'llm_extraction']);

    const routed = runtime.attachProductIntelLlmRouteProvenance(
      { provenance: {} },
      {
        llm_provider: 'gemini',
        llm_model: 'gemini-3-flash-preview',
        stage: 'stage_2',
        trigger_reason: 'unknown_low_evidence',
      },
    );
    expect(routed.provenance.llm_route).toEqual({
      stage: 'stage_2',
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      trigger_reason: 'unknown_low_evidence',
    });
  });
});
