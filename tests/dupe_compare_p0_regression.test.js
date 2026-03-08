'use strict';

const { applyDupeCompareQualityGate } = require('../src/auroraBff/qualityGates/dupeCompareGate');
const { normalizeDupeCompare } = require('../src/auroraBff/normalize');

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
