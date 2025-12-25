const request = require('supertest');

const app = require('../../src/server');

function makeFaceProfile({ source }) {
  return {
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
      geometryVector: [1.4, 0.85, 0.28, 0.22, 0.35, 5, 0.22, 0.14],
      embeddingVersion: 'geom-v0',
    },
  };
}

describe('POST /api/layer1/compatibility', () => {
  test('rejects missing refFaceProfile', async () => {
    const res = await request(app)
      .post('/api/layer1/compatibility')
      .send({ market: 'US', locale: 'en', preferenceMode: 'structure' });
    expect(res.status).toBe(400);
  });

  test('returns a SimilarityReportV0', async () => {
    const res = await request(app)
      .post('/api/layer1/compatibility')
      .send({
        market: 'US',
        locale: 'en',
        preferenceMode: 'structure',
        userFaceProfile: makeFaceProfile({ source: 'selfie' }),
        refFaceProfile: makeFaceProfile({ source: 'reference' }),
      });

    expect(res.status).toBe(200);
    expect(res.body.market).toBe('US');
    expect(res.body.reasons).toHaveLength(3);
    expect(res.body.adjustments).toHaveLength(3);
  });

  test('optInTraining requires sessionId', async () => {
    const res = await request(app)
      .post('/api/layer1/compatibility')
      .send({
        market: 'US',
        locale: 'en',
        preferenceMode: 'structure',
        optInTraining: true,
        refFaceProfile: makeFaceProfile({ source: 'reference' }),
      });
    expect(res.status).toBe(400);
  });
});

