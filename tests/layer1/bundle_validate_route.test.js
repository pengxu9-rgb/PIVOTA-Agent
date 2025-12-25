const request = require('supertest');

const app = require('../../src/server');

function makeFaceProfile({ source, valid = true }) {
  return {
    version: 'v0',
    market: 'US',
    source,
    locale: 'en',
    quality: {
      valid,
      score: valid ? 95 : 40,
      faceCount: 1,
      lightingScore: valid ? 85 : 10,
      sharpnessScore: valid ? 90 : 20,
      pose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
      occlusionFlags: { eyesOccluded: false, mouthOccluded: false, faceBorderCutoff: false },
      rejectReasons: valid ? [] : ['LIGHTING_LOW_CONFIDENCE'],
    },
    geometry: {
      faceAspect: 1.05,
      jawToCheekRatio: 0.8,
      chinLengthRatio: 0.24,
      midfaceRatio: 0.38,
      eyeSpacingRatio: 0.29,
      eyeTiltDeg: 2.5,
      eyeOpennessRatio: 0.26,
      lipFullnessRatio: 0.22,
    },
    categorical: {
      faceShape: 'oval',
      eyeType: 'almond',
      lipType: 'balanced',
    },
    derived: {
      geometryVector: [1.05, 0.8, 0.24, 0.38, 0.29, 2.5, 0.26, 0.22],
      embeddingVersion: 'geom-v0',
    },
  };
}

describe('POST /api/layer1/bundle/validate', () => {
  test('returns ok/soft_degrade/hard_reject gate', async () => {
    const ref = makeFaceProfile({ source: 'reference', valid: true });
    const user = makeFaceProfile({ source: 'selfie', valid: true });

    // Get a real report to embed into the bundle.
    const reportRes = await request(app).post('/api/layer1/compatibility').send({
      market: 'US',
      locale: 'en',
      preferenceMode: 'structure',
      userFaceProfile: user,
      refFaceProfile: ref,
    });
    expect(reportRes.status).toBe(200);

    const bundle = {
      schemaVersion: 'v0',
      market: 'US',
      locale: 'en',
      preferenceMode: 'structure',
      createdAt: '2025-01-01T00:00:00.000Z',
      userFaceProfile: user,
      refFaceProfile: ref,
      similarityReport: reportRes.body,
    };

    const res = await request(app).post('/api/layer1/bundle/validate').send({ bundle });
    expect(res.status).toBe(200);
    expect(['ok', 'soft_degrade', 'hard_reject']).toContain(res.body.gate);
    expect(Array.isArray(res.body.reasons)).toBe(true);
  });
});

