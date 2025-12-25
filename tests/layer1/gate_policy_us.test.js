const { evaluateLayer1Gate } = require('../../src/layer1/policy/usGatePolicy');
const { Layer1BundleV0Schema } = require('../../src/layer1/schemas/layer1BundleV0');
const { runCompatibilityEngineUS } = require('../../src/layer1/compatibility/us/runCompatibilityEngineUS');

function makeFaceProfile(source, overrides = {}) {
  const base = {
    version: 'v0',
    market: 'US',
    source,
    locale: 'en',
    quality: {
      valid: true,
      score: 95,
      faceCount: 1,
      lightingScore: 90,
      sharpnessScore: 90,
      pose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
      occlusionFlags: { eyesOccluded: false, mouthOccluded: false, faceBorderCutoff: false },
      rejectReasons: [],
    },
    geometry: {
      faceAspect: 1.0,
      jawToCheekRatio: 0.8,
      chinLengthRatio: 0.24,
      midfaceRatio: 0.38,
      eyeSpacingRatio: 0.29,
      eyeTiltDeg: 2.5,
      eyeOpennessRatio: 0.26,
      lipFullnessRatio: 0.22,
    },
    categorical: { faceShape: 'oval', eyeType: 'almond', lipType: 'balanced' },
    derived: { geometryVector: [1.0, 0.8, 0.24, 0.38, 0.29, 2.5, 0.26, 0.22], embeddingVersion: 'geom-v0' },
  };

  return {
    ...base,
    ...overrides,
    quality: { ...base.quality, ...(overrides.quality || {}) },
  };
}

describe('Layer1 gate policy (US)', () => {
  test('hard_reject when reference is invalid', () => {
    const ref = makeFaceProfile('reference', { quality: { valid: false, rejectReasons: ['LIGHTING_LOW_CONFIDENCE'], lightingScore: 10 } });
    const user = makeFaceProfile('selfie');
    const report = runCompatibilityEngineUS({ market: 'US', preferenceMode: 'structure', userFaceProfile: user, refFaceProfile: ref, locale: 'en' });
    const bundle = Layer1BundleV0Schema.parse({
      schemaVersion: 'v0',
      market: 'US',
      locale: 'en',
      preferenceMode: 'structure',
      createdAt: '2025-01-01T00:00:00.000Z',
      userFaceProfile: user,
      refFaceProfile: ref,
      similarityReport: report,
    });
    const decision = evaluateLayer1Gate(bundle);
    expect(decision.gate).toBe('hard_reject');
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  test('soft_degrade when selfie is missing', () => {
    const ref = makeFaceProfile('reference');
    const report = runCompatibilityEngineUS({ market: 'US', preferenceMode: 'structure', userFaceProfile: null, refFaceProfile: ref, locale: 'en' });
    const bundle = Layer1BundleV0Schema.parse({
      schemaVersion: 'v0',
      market: 'US',
      locale: 'en',
      preferenceMode: 'structure',
      createdAt: '2025-01-01T00:00:00.000Z',
      userFaceProfile: null,
      refFaceProfile: ref,
      similarityReport: report,
    });
    const decision = evaluateLayer1Gate(bundle);
    expect(decision.gate).toBe('soft_degrade');
    expect(decision.reasons).toContain('MISSING_SELFIE');
  });

  test('ok when reference is valid, selfie present, report high confidence, no warnings', () => {
    const ref = makeFaceProfile('reference');
    const user = makeFaceProfile('selfie');
    const report = runCompatibilityEngineUS({ market: 'US', preferenceMode: 'structure', userFaceProfile: user, refFaceProfile: ref, locale: 'en' });

    // Force high confidence + no warnings for this test.
    report.confidence = 'high';
    delete report.warnings;

    const bundle = Layer1BundleV0Schema.parse({
      schemaVersion: 'v0',
      market: 'US',
      locale: 'en',
      preferenceMode: 'structure',
      createdAt: '2025-01-01T00:00:00.000Z',
      userFaceProfile: user,
      refFaceProfile: ref,
      similarityReport: report,
    });
    const decision = evaluateLayer1Gate(bundle);
    expect(decision.gate).toBe('ok');
    expect(decision.reasons).toEqual([]);
  });
});

