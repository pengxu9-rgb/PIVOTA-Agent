const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

function loadRouteInternals({ promptVersion } = {}) {
  if (promptVersion == null) delete process.env.AURORA_PRODUCT_INTEL_PROMPT_VERSION;
  else process.env.AURORA_PRODUCT_INTEL_PROMPT_VERSION = promptVersion;
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

function unloadRouteInternals(moduleId) {
  delete require.cache[moduleId];
  delete process.env.AURORA_PRODUCT_INTEL_PROMPT_VERSION;
}

test('legacy product-intel v4 prompt encodes JSON-only and conservative grounding rules', () => {
  const { moduleId, __internal } = loadRouteInternals({ promptVersion: 'v4' });
  try {
    const prompt = __internal.buildProductDeepScanPromptV4({
      productDescriptor: 'vitamin C serum (user text only)',
      productType: 'spf',
      inciStatus: {
        extraction: 'blocked',
        consensus_tier: 'low',
        verification_required: true,
        total_ingredients: 0,
        sources: [],
      },
      usageOverrides: {
        when: 'AM_only',
        suppress_pm_first: true,
        suppress_2_3x_week: true,
        reapply_guidance: true,
      },
      anchorResolved: false,
    });

    assert.match(prompt, /single valid JSON object/i);
    assert.match(prompt, /Do NOT repeat information across fields/i);
    assert.match(prompt, /how_to_use\.when MUST be "AM only"/i);
    assert.match(prompt, /Do NOT suggest "start 2-3 nights\/week" or "PM first"/i);
    assert.match(prompt, /verdict_level MUST be "needs_verification" or "cautiously_ok"/i);
    assert.match(prompt, /Do NOT guess or assume a specific brand or SKU/i);
    assert.match(prompt, /Do NOT populate anchor_product/i);
    assert.match(prompt, /data_quality_banner/i);
    assert.match(prompt, /key_ingredients_by_function/i);
  } finally {
    unloadRouteInternals(moduleId);
  }
});

test('legacy product-intel deep-scan selector still defaults to v3 when env is unset', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const prompt = __internal.buildProductDeepScanPrompt({
      productDescriptor: 'CeraVe Moisturizing Cream',
      strictFormulaIntent: true,
      strictNarrative: true,
      anchorResolved: true,
    });

    assert.match(prompt, /Task: Deep-scan this product for suitability vs the user's profile/i);
    assert.match(prompt, /\[SYSTEM\]/i);
    assert.match(prompt, /Output MUST be a single valid JSON object/i);
    assert.match(prompt, /Missing-data policy:/i);
    assert.match(prompt, /how_to_use must be an object with keys: timing, frequency, steps \(array\), observation_window, stop_signs \(array\)/i);
    assert.match(prompt, /Narrative quality gate \(must pass\)/i);
    assert.match(prompt, /Do NOT fabricate scientific sources, clinical proof, or precise ingredient percentages/i);
    assert.doesNotMatch(prompt, /data_quality_banner/i);
  } finally {
    unloadRouteInternals(moduleId);
  }
});

test('legacy product-intel deep-scan selector uses v4 builder when env requests v4', () => {
  const { moduleId, __internal } = loadRouteInternals({ promptVersion: 'v4' });
  try {
    const args = {
      productDescriptor: 'Daily SPF 50',
      productType: 'spf',
      inciStatus: null,
      usageOverrides: {
        when: 'AM_only',
        suppress_pm_first: true,
        suppress_2_3x_week: true,
      },
      anchorResolved: true,
    };

    assert.equal(
      __internal.buildProductDeepScanPrompt(args),
      __internal.buildProductDeepScanPromptV4(args),
    );
  } finally {
    unloadRouteInternals(moduleId);
  }
});

test('legacy product-intel quality gate does not materialize empty inci_status when it is absent', () => {
  const { moduleId, __internal } = loadRouteInternals({ promptVersion: 'v4' });
  try {
    const envelope = {
      cards: [
        {
          type: 'product_analysis',
          payload: {
            assessment: {
              verdict: 'Suitable',
              summary: 'Looks compatible for daily use.',
              reasons: ['No obvious irritation markers in returned signals.'],
            },
            evidence: {
              science: {
                key_ingredients: ['Niacinamide'],
                risk_notes: [],
              },
              expert_notes: [],
              missing_info: [],
            },
            confidence: 0.8,
            missing_info: [],
          },
        },
      ],
      session_patch: {},
      events: [],
    };

    const result = __internal.applyUnknownVerdictQualityGateToEnvelope(envelope, { lang: 'EN' });
    const card = result.cards.find((item) => item.type === 'product_analysis');

    assert.equal(card.payload.assessment.verdict_level, 'recommended');
    assert.equal(Object.prototype.hasOwnProperty.call(card.payload, 'inci_status'), false);
  } finally {
    unloadRouteInternals(moduleId);
  }
});
