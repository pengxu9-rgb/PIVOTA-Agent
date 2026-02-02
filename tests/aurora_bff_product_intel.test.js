const request = require('supertest');

describe('Aurora BFF product intelligence (structured upstream)', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.AURORA_BFF_USE_MOCK = 'true';
  });

  afterEach(() => {
    delete process.env.AURORA_BFF_USE_MOCK;
  });

  test('/v1/product/parse prefers upstream structured.parse', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/parse')
      .set('X-Aurora-UID', 'uid_test_parse_1')
      .send({ text: 'Mock Parsed Product' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_parse');
    expect(card).toBeTruthy();
    expect(card.payload.product).toBeTruthy();
    expect(card.payload.product.sku_id).toBe('mock_sku_1');
    expect(card.payload.confidence).toBeCloseTo(0.7);
    expect(Array.isArray(card.payload.missing_info)).toBe(true);
  });

  test('/v1/product/analyze maps aurora structured.analyze into normalized evidence', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_analyze_1')
      .send({ name: 'Mock Parsed Product' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(card.payload.assessment).toBeTruthy();
    expect(card.payload.assessment.verdict).toBe('Suitable');

    const ev = card.payload.evidence;
    expect(ev).toBeTruthy();
    expect(Array.isArray(ev.science.key_ingredients)).toBe(true);
    expect(ev.science.key_ingredients).toContain('niacinamide');
    expect(Array.isArray(ev.social_signals.typical_positive)).toBe(true);
    expect(ev.social_signals.typical_positive).toContain('soothing');
    expect(Array.isArray(ev.expert_notes)).toBe(true);
  });

  test('/v1/dupe/compare uses structured.alternatives for tradeoffs/evidence', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/dupe/compare')
      .set('X-Aurora-UID', 'uid_test_dupe_1')
      .send({
        original: { brand: 'MockBrand', name: 'Mock Parsed Product' },
        dupe: { brand: 'MockDupeBrand', name: 'Mock Dupe Product' },
      })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'dupe_compare');
    expect(card).toBeTruthy();
    expect(Array.isArray(card.payload.tradeoffs)).toBe(true);
    expect(card.payload.tradeoffs.some((t) => String(t).includes('Missing actives'))).toBe(true);
    expect(card.payload.confidence).toBeGreaterThan(0);

    const ev = card.payload.evidence;
    expect(ev).toBeTruthy();
    expect(Array.isArray(ev.science.key_ingredients)).toBe(true);
    expect(ev.science.key_ingredients).toContain('niacinamide');
  });

  test('Normalization: evidence is never omitted (even on null input)', async () => {
    const { normalizeProductAnalysis, normalizeDupeCompare, normalizeRecoGenerate } = require('../src/auroraBff/normalize');

    expect(normalizeProductAnalysis(null).payload.evidence).toBeTruthy();
    expect(normalizeDupeCompare(null).payload.evidence).toBeTruthy();
    expect(normalizeRecoGenerate(null).payload.evidence).toBeTruthy();
  });
});

