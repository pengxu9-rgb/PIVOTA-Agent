const { FaceProfileV0Schema } = require('../../src/layer1/schemas/faceProfileV0');
const { runCompatibilityEngineUS } = require('../../src/layer1/compatibility/us/runCompatibilityEngineUS');

function makeFaceProfile({ source, overrides = {} }) {
  const base = {
    version: 'v0',
    market: 'US',
    source,
    locale: 'en',
    quality: {
      valid: true,
      score: 90,
      faceCount: 1,
      lightingScore: 80,
      sharpnessScore: 80,
      pose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
      occlusionFlags: { eyesOccluded: false, mouthOccluded: false, faceBorderCutoff: false },
      rejectReasons: [],
    },
    geometry: {
      faceAspect: 1.4,
      jawToCheekRatio: 0.85,
      chinLengthRatio: 0.28,
      midfaceRatio: 0.22,
      eyeSpacingRatio: 0.35,
      eyeTiltDeg: 5,
      eyeOpennessRatio: 0.22,
      lipFullnessRatio: 0.14,
    },
    categorical: {
      faceShape: 'oval',
      eyeType: 'almond',
      lipType: 'balanced',
    },
    derived: {
      geometryVector: [],
      embeddingVersion: 'geom-v0',
    },
  };

  const merged = {
    ...base,
    ...overrides,
    quality: { ...base.quality, ...(overrides.quality || {}) },
    geometry: { ...base.geometry, ...(overrides.geometry || {}) },
    categorical: { ...base.categorical, ...(overrides.categorical || {}) },
  };
  merged.derived.geometryVector = [
    merged.geometry.faceAspect,
    merged.geometry.jawToCheekRatio,
    merged.geometry.chinLengthRatio,
    merged.geometry.midfaceRatio,
    merged.geometry.eyeSpacingRatio,
    merged.geometry.eyeTiltDeg,
    merged.geometry.eyeOpennessRatio,
    merged.geometry.lipFullnessRatio,
  ];

  return FaceProfileV0Schema.parse(merged);
}

describe('Layer1 CompatibilityEngine US', () => {
  test('always returns exactly 3 reasons and 3 adjustments', () => {
    const ref = makeFaceProfile({ source: 'reference' });
    const user = makeFaceProfile({ source: 'selfie', overrides: { geometry: { eyeTiltDeg: 0 } } });

    const report = runCompatibilityEngineUS({
      market: 'US',
      preferenceMode: 'structure',
      userFaceProfile: user,
      refFaceProfile: ref,
      locale: 'en',
    });

    expect(report.reasons).toHaveLength(3);
    expect(report.adjustments).toHaveLength(3);
    expect(new Set(report.adjustments.map((a) => a.impactArea)).size).toBe(3);
    expect(report.engineVersion).toMatch(/^compat-us-\d+\.\d+\.\d+$/);
    expect(report.schemaVersion).toBe('v0');
  });

  test('missing selfie still returns 3 safe adjustments', () => {
    const ref = makeFaceProfile({ source: 'reference' });
    const report = runCompatibilityEngineUS({
      market: 'US',
      preferenceMode: 'ease',
      userFaceProfile: null,
      refFaceProfile: ref,
      locale: 'en',
    });
    expect(report.adjustments).toHaveLength(3);
    expect(report.adjustments.every((a) => a.confidence === 'low' || a.confidence === 'medium')).toBe(true);
  });

  test('preferenceMode structure penalizes geometry mismatch more than vibe', () => {
    const ref = makeFaceProfile({ source: 'reference', overrides: { geometry: { eyeTiltDeg: 15 } } });
    const user = makeFaceProfile({ source: 'selfie', overrides: { geometry: { eyeTiltDeg: 0 } } });

    const structure = runCompatibilityEngineUS({
      market: 'US',
      preferenceMode: 'structure',
      userFaceProfile: user,
      refFaceProfile: ref,
      locale: 'en',
    });
    const vibe = runCompatibilityEngineUS({
      market: 'US',
      preferenceMode: 'vibe',
      userFaceProfile: user,
      refFaceProfile: ref,
      locale: 'en',
    });

    expect(structure.fitScore).toBeLessThanOrEqual(vibe.fitScore);
  });
});
