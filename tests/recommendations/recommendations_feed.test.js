const express = require('express');
const request = require('supertest');

const { mountRecommendationRoutes } = require('../../src/recommendations/routes');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountRecommendationRoutes(app);
  return app;
}

describe('Recommendations feed API', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.EXTERNAL_OFFER_ALLOWED_DOMAINS_US = 'example.com';
    process.env.EXTERNAL_OFFER_ALLOWED_DOMAINS_JP = 'example.jp';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('POST /v1/recommendations/roles/normalize maps hints to ROLE:<id> with meta versions', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/v1/recommendations/roles/normalize')
      .send({ roleHints: ['thin felt-tip liner', 'unknown role'] });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.normalizedRoles)).toBe(true);
    expect(res.body.normalizedRoles.some((r) => r.normalizedRoleId === 'ROLE:thin_felt_tip_liner')).toBe(true);
    expect(res.body.meta.roleTaxonomyVersion).toBe('v1');
    expect(typeof res.body.meta.roleTaxonomySha).toBe('string');
  });

  test('POST /v1/recommendations/feed returns deterministic url feedItems with offerKey', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/v1/recommendations/feed')
      .send({
        market: 'US',
        locale: 'en',
        roleHints: ['thin felt-tip liner', 'blending brush'],
        maxOffersPerRole: 2,
        maxTotalOffers: 10,
        diversity: { dedupe: 'global', domainCapPerRole: 2, domainCapGlobal: 10 },
        resolve: 'deferred',
        debug: { includeMapping: true },
      });

    expect(res.status).toBe(200);
    expect(res.body.meta.requestId).toBeTruthy();
    expect(res.body.meta.roleTaxonomyVersion).toBe('v1');
    expect(typeof res.body.meta.configVersion).toBe('string');
    expect(Array.isArray(res.body.feedItems)).toBe(true);

    const firstItem = res.body.feedItems[0];
    expect(firstItem.roleId.startsWith('ROLE:')).toBe(true);
    expect(Array.isArray(firstItem.urls)).toBe(true);
    if (firstItem.urls.length) {
      expect(firstItem.urls[0].offerKey).toMatch(/^offer_[a-f0-9]{24}$/);
      expect(firstItem.urls[0].url).toMatch(/^https?:\/\//);
      expect(firstItem.urls[0].domain).toBeTruthy();
    }
  });

  test('POST /v1/recommendations/feed can return filter reasons when requested', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/v1/recommendations/feed')
      .send({
        market: 'US',
        roleIds: ['ROLE:thin_felt_tip_liner'],
        maxOffersPerRole: 5,
        maxTotalOffers: 5,
        diversity: { domainCapPerRole: 1, domainCapGlobal: 1, dedupe: 'global' },
        debug: { includeFilterReasons: true },
      });

    expect(res.status).toBe(200);
    // filtered may be empty depending on pool contents, but should be present when debug enabled
    expect('filtered' in res.body).toBe(true);
    expect(Array.isArray(res.body.filtered)).toBe(true);
  });
});

