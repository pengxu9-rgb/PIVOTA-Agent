'use strict';

const { applyDupeCompareQualityGate } = require('../src/auroraBff/qualityGates/dupeCompareGate');
const { normalizeDupeCompare } = require('../src/auroraBff/normalize');
const { executeDupeCompare } = require('../src/auroraBff/usecases/dupeCompare');
const {
  buildDupeCompareParsePrompt,
  buildDupeCompareMainPrompt,
  buildDupeCompareDeepScanPrompt,
  mergeCompareProductContext,
} = require('../src/auroraBff/dupeCompareContract');

// ---------------------------------------------------------------------------
// P0-A: normalizeDupeCompare original/dupe never null
// ---------------------------------------------------------------------------
describe('normalizeDupeCompare: original and dupe non-null guarantee', () => {
  test('upstream missing → original and dupe are stubs, not null', () => {
    const result = normalizeDupeCompare(null);
    expect(result.payload.original).not.toBeNull();
    expect(result.payload.original._stub).toBe(true);
    expect(result.payload.dupe).not.toBeNull();
    expect(result.payload.dupe._stub).toBe(true);
  });

  test('upstream has no original/dupe fields → stubs are used', () => {
    const result = normalizeDupeCompare({
      tradeoffs: ['lighter texture'],
      confidence: 0.7,
    });
    expect(result.payload.original).not.toBeNull();
    expect(result.payload.original._stub).toBe(true);
    expect(result.payload.original.anchor_resolution_reason).toBe('upstream_missing');
    expect(result.payload.dupe).not.toBeNull();
    expect(result.payload.dupe._stub).toBe(true);
  });

  test('upstream has original but no dupe → dupe is stub', () => {
    const result = normalizeDupeCompare({
      original: { brand: 'La Mer', name: 'Creme de la Mer' },
      tradeoffs: ['more affordable'],
      confidence: 0.8,
    });
    expect(result.payload.original.brand).toBe('La Mer');
    expect(result.payload.original._stub).toBeUndefined();
    expect(result.payload.dupe._stub).toBe(true);
  });

  test('upstream has both original and dupe → no stubs', () => {
    const result = normalizeDupeCompare({
      original: { brand: 'La Mer', name: 'Creme de la Mer' },
      dupe: { brand: 'CeraVe', name: 'Moisturizing Cream' },
      tradeoffs: ['lighter', 'more affordable'],
      confidence: 0.85,
    });
    expect(result.payload.original.brand).toBe('La Mer');
    expect(result.payload.original._stub).toBeUndefined();
    expect(result.payload.dupe.brand).toBe('CeraVe');
    expect(result.payload.dupe._stub).toBeUndefined();
  });

  test('unwraps nested product-like dupe payloads from legacy compare requests', () => {
    const result = normalizeDupeCompare({
      original: { brand: 'La Mer', name: 'Creme de la Mer' },
      dupe: {
        kind: 'dupe',
        product: { brand: 'CeraVe', name: 'Moisturizing Cream', product_id: 'cerave_1' },
      },
      tradeoffs: ['lighter', 'more affordable'],
      confidence: 0.85,
    });
    expect(result.payload.dupe.brand).toBe('CeraVe');
    expect(result.payload.dupe.name).toBe('Moisturizing Cream');
    expect(result.payload.dupe.product_id).toBe('cerave_1');
    expect(result.payload.dupe.product).toBeUndefined();
  });
  test('accepts structured tradeoffs and nested similarity score while preserving legacy tradeoff strings', () => {
    const result = normalizeDupeCompare({
      original: { summary_en: 'Rich barrier cream' },
      dupe: {
        summary_en: 'Lighter barrier cream',
        similarity_score: 78,
        price_comparison: 'unknown',
        similarity_rationale: 'Both appear positioned as barrier-supportive moisturizers.',
      },
      tradeoffs: [
        {
          axis: 'texture',
          difference_en: 'The dupe appears lighter and less occlusive.',
          impact: 'better_for_some',
          who_it_matters_for: 'matters for oily skin users seeking a lighter finish',
        },
      ],
      evidence: {
        science: [
          {
            claim_en: 'Both appear positioned around barrier-supportive hydration.',
            strength: 'limited',
            supports: ['comparison'],
            uncertainties: ['full_ingredient_list_missing'],
          },
        ],
        social_signals: [],
        expert_notes: [
          {
            claim_en: 'Similarity looks role-level rather than formula-level.',
            strength: 'limited',
            supports: ['comparison'],
            uncertainties: ['ingredient_overlap_unclear'],
          },
        ],
      },
      confidence: 0.42,
      missing_info: ['full_ingredient_list_missing'],
    });

    expect(result.payload.similarity).toBe(78);
    expect(result.payload.tradeoffs).toEqual([
      'Texture: The dupe appears lighter and less occlusive. (matters for oily skin users seeking a lighter finish)',
    ]);
    expect(result.payload.tradeoffs_detail.structured_tradeoffs).toEqual([
      expect.objectContaining({
        axis: 'texture',
        impact: 'better_for_some',
      }),
    ]);
    expect(result.payload.evidence.expert_notes).toContain('Similarity looks role-level rather than formula-level.');
    expect(result.payload.evidence.structured_claims.science).toEqual([
      expect.objectContaining({ strength: 'limited' }),
    ]);
  });

  test('classifies legacy string tradeoffs into a structured taxonomy', () => {
    const result = normalizeDupeCompare({
      original: { brand: 'La Mer', name: 'Creme de la Mer' },
      dupe: { brand: 'CeraVe', name: 'Moisturizing Cream' },
      tradeoffs: ['Texture/finish: Dupe is lighter and more affordable for oily skin users.'],
      confidence: 0.6,
    });

    expect(result.payload.tradeoffs_detail.structured_tradeoffs).toEqual([
      expect.objectContaining({
        axis: 'texture',
        impact: 'better_for_some',
      }),
    ]);
  });
});

describe('dupeCompareContract prompt builders', () => {
  test('main compare prompt encodes the strong contract and keeps Task markers for runtime mocks', () => {
    const prompt = buildDupeCompareMainPrompt({
      prefix: 'CTX\n',
      originalText: 'Original Example',
      dupeText: 'Dupe Example',
    });

    expect(prompt).toContain('[ROLE]');
    expect(prompt).toContain('[OUTPUT_CONTRACT]');
    expect(prompt).toContain('Task: Compare the ORIGINAL product against the DUPE/ALTERNATIVE product');
    expect(prompt).toContain('"similarity_rationale"');
    expect(prompt).toContain('"similarity_score"');
    expect(prompt).toContain('"price_comparison"');
    expect(prompt).toContain('"axis": "actives"');
    expect(prompt).toContain('same formula');
    expect(prompt).toContain('exact dupe');
    expect(prompt).toContain('full_ingredient_list_missing');
  });

  test('parse and deepscan prompts stay conservative and axis-aligned', () => {
    const parsePrompt = buildDupeCompareParsePrompt({ prefix: '', input: 'Example Product' });
    const deepScanPrompt = buildDupeCompareDeepScanPrompt({
      prefix: '',
      productText: 'Example Product',
      strict: true,
    });

    expect(parsePrompt).toContain('Task: Parse the supplied product input');
    expect(parsePrompt).toContain('Do not invent INCI decks, concentrations, hidden actives, prices, or formula relationships.');
    expect(deepScanPrompt).toContain('Task: Deep-scan this product');
    expect(deepScanPrompt).toContain('"texture"');
    expect(deepScanPrompt).toContain('"hydration_profile"');
    expect(deepScanPrompt).toContain('"key_ingredients_missing"');
  });
});

describe('mergeCompareProductContext', () => {
  test('keeps trusted anchor identity while attaching compare annotations', () => {
    const merged = mergeCompareProductContext(
      { brand: 'Lab Series', name: 'Daily Rescue', url: 'https://example.com/daily-rescue' },
      {
        summary_en: 'Lightweight daily moisturizer',
        hero_ingredients: ['glycerin', 'niacinamide'],
        similarity_rationale: 'Both appear positioned as lightweight daily moisturizers.',
        similarity_score: 81,
        price_comparison: 'unknown',
      },
    );

    expect(merged.brand).toBe('Lab Series');
    expect(merged.name).toBe('Daily Rescue');
    expect(merged.summary_en).toBe('Lightweight daily moisturizer');
    expect(merged.hero_ingredients).toEqual(['glycerin', 'niacinamide']);
    expect(merged.similarity_score).toBe(81);
  });
});

// ---------------------------------------------------------------------------
// P0-C: dupe_compare quality gate — limited mode enrichment
// ---------------------------------------------------------------------------
describe('applyDupeCompareQualityGate: limited mode enrichment', () => {
  test('limited mode with empty basic_compare gets fallback bullets', () => {
    const payload = {
      original: { brand: 'La Mer', name: 'Creme de la Mer' },
      dupe: { brand: 'CeraVe', name: 'Moisturizing Cream' },
      compare_quality: 'limited',
      limited_reason: 'tradeoffs_detail_missing',
      tradeoffs: [],
      basic_compare: [],
      meta: {},
    };
    const result = applyDupeCompareQualityGate(payload, { lang: 'EN' });
    expect(result.gated).toBe(true);
    expect(result.payload.basic_compare.length).toBeGreaterThanOrEqual(2);
    expect(result.payload.limited_action_hint).toBeTruthy();
    expect(result.payload.meta.quality_gate_enforced).toBe(true);
  });

  test('limited mode with existing basic_compare does not replace them', () => {
    const payload = {
      original: { brand: 'La Mer', name: 'Creme de la Mer' },
      dupe: { brand: 'CeraVe', name: 'Moisturizing Cream' },
      compare_quality: 'limited',
      limited_reason: 'tradeoffs_detail_missing',
      tradeoffs: ['No tradeoff details were returned'],
      basic_compare: ['Category: Both are "moisturizer"', 'Price delta: -$300'],
      meta: {},
    };
    const result = applyDupeCompareQualityGate(payload, { lang: 'EN' });
    expect(result.payload.basic_compare).toEqual(['Category: Both are "moisturizer"', 'Price delta: -$300']);
    expect(result.payload.limited_action_hint).toBeTruthy();
  });

  test('full compare mode is not gated', () => {
    const payload = {
      original: { brand: 'La Mer', name: 'Creme de la Mer' },
      dupe: { brand: 'CeraVe', name: 'Moisturizing Cream' },
      compare_quality: 'full',
      tradeoffs: ['CeraVe is more affordable', 'La Mer has richer texture'],
      evidence: { science: { key_ingredients: ['ceramides'] } },
      confidence: 0.85,
      meta: {},
    };
    const result = applyDupeCompareQualityGate(payload, { lang: 'EN' });
    expect(result.gated).toBe(false);
  });
});

describe('applyDupeCompareQualityGate: both products missing', () => {
  test('detects both_products_missing when both are stubs', () => {
    const payload = {
      original: { _stub: true, anchor_resolution_status: 'failed' },
      dupe: { _stub: true, anchor_resolution_status: 'failed' },
      compare_quality: 'limited',
      tradeoffs: [],
      basic_compare: [],
      meta: {},
    };
    const result = applyDupeCompareQualityGate(payload, { lang: 'EN' });
    expect(result.gated).toBe(true);
    expect(result.reason).toBe('both_products_missing');
    expect(result.payload.meta.quality_gate_reasons).toContain('both_products_missing');
  });

  test('does not flag when only one product is a stub', () => {
    const payload = {
      original: { brand: 'La Mer', name: 'Creme de la Mer' },
      dupe: { _stub: true, anchor_resolution_status: 'failed' },
      compare_quality: 'limited',
      tradeoffs: [],
      basic_compare: ['Category: moisturizer', 'Price: unknown'],
      meta: {},
    };
    const result = applyDupeCompareQualityGate(payload, { lang: 'EN' });
    expect(result.payload.meta.quality_gate_reasons).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P0-C: Chinese language support for quality gate
// ---------------------------------------------------------------------------
describe('applyDupeCompareQualityGate: Chinese language', () => {
  test('limited mode fallback in CN', () => {
    const payload = {
      original: { brand: 'La Mer' },
      dupe: { brand: 'CeraVe' },
      compare_quality: 'limited',
      tradeoffs: [],
      basic_compare: [],
      meta: {},
    };
    const result = applyDupeCompareQualityGate(payload, { lang: 'CN' });
    expect(result.payload.basic_compare.length).toBeGreaterThanOrEqual(2);
    expect(result.payload.basic_compare[0]).toMatch(/上游|建议/);
    expect(result.payload.limited_action_hint).toMatch(/有限对比/);
  });
});

describe('executeDupeCompare: request validation', () => {
  const baseServices = {
    resolveIdentity: async () => ({ auroraUid: 'uid_test', userId: 'user_test' }),
    getProfileForIdentity: async () => null,
    getRecentSkinLogsForIdentity: async () => [],
    summarizeProfileForContext: () => null,
    executeCompareInner: async () => ({
      payload: {
        original: { brand: 'Original', name: 'Original Product' },
        dupe: { brand: 'Dupe', name: 'Dupe Product' },
        tradeoffs: ['lighter'],
        basic_compare: ['Texture: lighter'],
        compare_quality: 'full',
        meta: {},
      },
      field_missing: [],
    }),
  };

  test('returns original is required when original cannot be resolved', async () => {
    const result = await executeDupeCompare({
      ctx: { lang: 'EN' },
      input: {
        original: {},
        dupe: { brand: 'Dupe', name: 'Dupe Product' },
      },
      services: baseServices,
      logger: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error_details).toBe('original is required');
  });

  test('returns dupe is required when dupe cannot be resolved', async () => {
    const result = await executeDupeCompare({
      ctx: { lang: 'EN' },
      input: {
        original: { brand: 'Original', name: 'Original Product' },
        dupe: {},
      },
      services: baseServices,
      logger: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error_details).toBe('dupe is required');
  });
});

// ---------------------------------------------------------------------------
// P0-A / golden fixture: SPF product_analysis usage rules
// ---------------------------------------------------------------------------
describe('product_analysis: SPF usage rules (cross-cutting)', () => {
  const INVALID_SPF_USAGE_PATTERNS = [
    /PM[- ]?first/i,
    /2-3x\/week/i,
    /twice\s+a\s+week/i,
    /every\s+other\s+day/i,
  ];

  function validateSPFUsage(howToUse) {
    if (!howToUse || typeof howToUse !== 'string') return { valid: true, violations: [] };
    const violations = [];
    for (const pattern of INVALID_SPF_USAGE_PATTERNS) {
      if (pattern.test(howToUse)) violations.push(pattern.source);
    }
    return { valid: violations.length === 0, violations };
  }

  test('PM-first is invalid for SPF products', () => {
    expect(validateSPFUsage('Apply PM-first for best results').valid).toBe(false);
  });

  test('2-3x/week is invalid for SPF products', () => {
    expect(validateSPFUsage('Use 2-3x/week on cleansed skin').valid).toBe(false);
  });

  test('every morning is valid for SPF products', () => {
    expect(validateSPFUsage('Apply every morning as the last step of skincare').valid).toBe(true);
  });

  test('empty usage is valid (no assertion to fail)', () => {
    expect(validateSPFUsage('').valid).toBe(true);
    expect(validateSPFUsage(null).valid).toBe(true);
  });
});
