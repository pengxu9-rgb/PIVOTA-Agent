describe('Aurora BFF: product analysis reason enrichment', () => {
  test('replaces generic reasons with evidence-derived reasons', () => {
    const { enrichProductAnalysisPayload } = require('../src/auroraBff/normalize');

    const payload = {
      assessment: {
        verdict: 'Suitable',
        reasons: ['Overall fit looks reasonable for your profile.'],
      },
      evidence: {
        science: {
          key_ingredients: ['Water', 'Mineral Oil', 'Petrolatum', 'Glycerin', 'Panthenol'],
          mechanisms: ['Barrier-supporting ingredients can reduce dryness and improve tolerance (consensus).'],
          fit_notes: ['Targets: Barrier repair, Soothing'],
          risk_notes: [],
        },
        social_signals: {
          typical_positive: ['moisturizing', 'thick', 'occlusive'],
          typical_negative: [],
          risk_for_groups: [],
        },
        expert_notes: [],
        confidence: 0.8,
        missing_info: [],
      },
      confidence: 0.8,
      missing_info: [],
    };

    const out = enrichProductAnalysisPayload(payload, { lang: 'EN' });
    expect(out.assessment).toBeTruthy();
    expect(Array.isArray(out.assessment.reasons)).toBe(true);
    expect(out.assessment.reasons.length).toBeGreaterThanOrEqual(2);
    expect(out.assessment.reasons.join(' ')).not.toMatch(/overall fit/i);
    expect(out.assessment.reasons.some((r) => String(r).includes('Targets'))).toBe(true);
  });

  test('adds explicit reason when evidence is missing', () => {
    const { enrichProductAnalysisPayload } = require('../src/auroraBff/normalize');

    const payload = {
      assessment: {
        verdict: 'Suitable',
        reasons: [],
      },
      evidence: {
        science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
        social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
        expert_notes: [],
        confidence: null,
        missing_info: ['evidence_missing'],
      },
      confidence: null,
      missing_info: [],
    };

    const out = enrichProductAnalysisPayload(payload, { lang: 'EN' });
    expect(out.assessment.reasons[0]).toMatch(/evidence details/i);
  });
});

