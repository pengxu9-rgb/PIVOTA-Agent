const express = require('express');
const request = require('supertest');

function makeHeaders() {
  return {
    'X-Aurora-UID': 'uid_test_dupe_regression',
    'X-Trace-ID': 'trace_test_dupe_regression',
    'X-Brief-ID': 'brief_test_dupe_regression',
    'X-Lang': 'EN',
  };
}

function getCard(body, type) {
  return (Array.isArray(body?.cards) ? body.cards : []).find((card) => card && card.type === type) || null;
}

describe('legacy /v1/dupe suggest sanitization', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.AURORA_BFF_USE_MOCK = 'true';
  });

  afterEach(() => {
    delete process.env.AURORA_BFF_USE_MOCK;
  });

  test('sanitizeDupeSuggestPayload removes self-references from legacy nested product rows', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const result = __internal.sanitizeDupeSuggestPayload(
      {
        original: {
          brand: 'Lab Series',
          name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
          url: 'https://www.labseries.com/product/daily-rescue',
          product_id: 'prod_123',
        },
        dupes: [
          {
            kind: 'dupe',
            product: {
              brand: 'Lab Series',
              name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
              url: 'https://www.labseries.com/product/daily-rescue',
              product_id: 'prod_123',
            },
            similarity: 92,
            tradeoffs: ['none'],
            confidence: 0.8,
          },
          {
            kind: 'dupe',
            product: {
              brand: 'Clinique',
              name: 'Moisture Surge 100H Auto-Replenishing Hydrator',
              url: 'https://www.clinique.com/product/moisture-surge',
            },
            similarity: 82,
            tradeoffs: ['lighter finish'],
            confidence: 0.81,
          },
        ],
        comparables: [],
        meta: {},
      },
      { lang: 'EN' },
    );

    expect(result.payload.dupes).toHaveLength(1);
    expect(result.payload.dupes[0].product.brand).toBe('Clinique');
    expect(result.payload.meta.self_ref_dropped_count).toBe(1);
    expect(result.field_missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'dupe_suggest_self_reference_filtered' }),
      ]),
    );
  });

  test('sanitizeDupeSuggestPayload sanitizes URL-as-name and then filters it as self-reference', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const result = __internal.sanitizeDupeSuggestPayload(
      {
        original: {
          brand: 'Lab Series',
          name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
          url: 'https://www.labseries.com/product/32020/123634/skincare/moisturizerspf/daily-rescue-energizing-lightweight-lotion-moisturizer/daily-rescue',
        },
        dupes: [
          {
            kind: 'dupe',
            product: {
              brand: 'Lab Series',
              name: 'https://www.labseries.com/product/32020/123634/skincare/moisturizerspf/daily-rescue-energizing-lightweight-lotion-moisturizer/daily-rescue (budget dupe)',
            },
            confidence: 0.78,
          },
        ],
        comparables: [],
        meta: {},
      },
      { lang: 'EN' },
    );

    expect(result.payload.dupes).toHaveLength(0);
    expect(result.field_missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'dupe_suggest_name_is_url_sanitized' }),
        expect.objectContaining({ reason: 'dupe_suggest_self_reference_filtered' }),
      ]),
    );
    expect(result.payload.empty_state_reason).toBeTruthy();
  });

  test('sanitizeDupeSuggestPayload removes self-references when original only has legacy product_name', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const { resolveOriginalForPayload } = require('../src/auroraBff/mappers/dupeSuggestMapper');
    const resolvedOriginal = resolveOriginalForPayload(
      {
        brand: 'The Ordinary',
        product_name: 'Niacinamide 10% + Zinc 1%',
      },
      'https://www.sephora.com/product/the-ordinary-niacinamide-10-zinc-1-P427417',
      '',
    );

    expect(resolvedOriginal.original.name).toContain('Niacinamide 10% + Zinc 1%');
    expect(resolvedOriginal.original.url).toBe('https://www.sephora.com/product/the-ordinary-niacinamide-10-zinc-1-P427417');

    const result = __internal.sanitizeDupeSuggestPayload(
      {
        original: resolvedOriginal.original,
        dupes: [
          {
            kind: 'dupe',
            product: {
              brand: 'The Ordinary',
              name: 'The Ordinary Niacinamide 10 Zinc 1 P427417',
              url: 'https://www.sephora.com/product/the-ordinary-niacinamide-10-zinc-1-P427417',
            },
            confidence: 0.78,
          },
        ],
        comparables: [],
        meta: {},
      },
      { lang: 'EN' },
    );

    expect(result.payload.dupes).toHaveLength(0);
    expect(result.payload.meta.self_ref_dropped_count).toBe(1);
    expect(result.field_missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'dupe_suggest_self_reference_filtered' }),
      ]),
    );
  });

  test('sanitizeDupeSuggestPayload keeps same-brand different-line candidate and auto-adds justification', () => {
    const { __internal } = require('../src/auroraBff/routes');
    const result = __internal.sanitizeDupeSuggestPayload(
      {
        original: {
          brand: 'Lab Series',
          name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
          url: 'https://www.labseries.com/product/daily-rescue',
        },
        dupes: [
          {
            kind: 'premium',
            product: {
              brand: 'Lab Series',
              name: 'MAX LS Age-Less Power V Lifting Cream',
              url: 'https://www.labseries.com/product/max-ls-power-v',
            },
            similarity: 63,
            tradeoffs: ['richer texture'],
            confidence: 0.64,
          },
        ],
        comparables: [],
        meta: {},
      },
      { lang: 'EN' },
    );

    expect(result.payload.dupes).toHaveLength(1);
    expect(result.payload.dupes[0].why_not_the_same_product).toBeTruthy();
  });
});

describe('legacy /v1/dupe/compare request compatibility', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.AURORA_BFF_USE_MOCK = 'true';
  });

  afterEach(() => {
    delete process.env.AURORA_BFF_USE_MOCK;
  });

  function makeApp() {
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });
    return app;
  }

  test('accepts DupeSuggestCard nested item.product shape without BAD_REQUEST', async () => {
    const app = makeApp();
    const response = await request(app)
      .post('/v1/dupe/compare')
      .set(makeHeaders())
      .send({
        original: { brand: 'MockBrand', name: 'Mock Parsed Product' },
        dupe: {
          kind: 'dupe',
          product: {
            brand: 'MockDupeBrand',
            name: 'mock_dupe',
            url: 'https://example.com/mock-dupe',
          },
          tradeoffs: ['lighter texture'],
        },
      })
      .expect(200);

    const card = getCard(response.body, 'dupe_compare');
    expect(card).toBeTruthy();
    expect(card.payload.original).toEqual(expect.objectContaining({ brand: 'MockBrand' }));
    expect(card.payload.dupe.brand).toBeTruthy();
    expect(card.payload.dupe.name || card.payload.dupe.display_name).toBeTruthy();
  });

  test('accepts flat product_analysis compare-chip candidate shape without BAD_REQUEST', async () => {
    const app = makeApp();
    const response = await request(app)
      .post('/v1/dupe/compare')
      .set(makeHeaders())
      .send({
        original: { brand: 'MockBrand', name: 'Mock Parsed Product' },
        dupe: {
          brand: 'FlatBrand',
          display_name: 'Flat Candidate Cream',
          url: 'https://example.com/flat-candidate-cream',
          confidence: 0.72,
        },
      })
      .expect(200);

    const card = getCard(response.body, 'dupe_compare');
    expect(card).toBeTruthy();
    expect(card.payload.original).toBeTruthy();
    expect(card.payload.dupe).toBeTruthy();
    expect(card.payload.dupe.name || card.payload.dupe.display_name).toBeTruthy();
  });

  test('accepts legacy dupe_suggest original payloads that only expose product_name', async () => {
    const app = makeApp();
    const response = await request(app)
      .post('/v1/dupe/compare')
      .set(makeHeaders())
      .send({
        original: {
          brand: 'The Ordinary',
          product_name: 'Niacinamide 10% + Zinc 1%',
          url: 'https://www.sephora.com/product/the-ordinary-niacinamide-10-zinc-1-P427417',
        },
        dupe: {
          brand: 'MockDupeBrand',
          name: 'Mock Dupe Serum',
          url: 'https://example.com/mock-dupe-serum',
        },
      })
      .expect(200);

    const card = getCard(response.body, 'dupe_compare');
    expect(card).toBeTruthy();
    expect(card.payload.original).toBeTruthy();
    expect(card.payload.dupe).toBeTruthy();
  });

  test('returns explicit BAD_REQUEST detail when original is missing', async () => {
    const app = makeApp();
    const response = await request(app)
      .post('/v1/dupe/compare')
      .set(makeHeaders())
      .send({
        dupe: { brand: 'FlatBrand', name: 'Flat Candidate Cream' },
      })
      .expect(400);

    const card = getCard(response.body, 'error');
    expect(card.payload.error).toBe('BAD_REQUEST');
    expect(card.payload.details).toBe('original is required');
  });

  test('returns explicit BAD_REQUEST detail when dupe is missing', async () => {
    const app = makeApp();
    const response = await request(app)
      .post('/v1/dupe/compare')
      .set(makeHeaders())
      .send({
        original: { brand: 'MockBrand', name: 'Mock Parsed Product' },
      })
      .expect(400);

    const card = getCard(response.body, 'error');
    expect(card.payload.error).toBe('BAD_REQUEST');
    expect(card.payload.details).toBe('dupe is required');
  });

  test('legacy compare route stays compatible after extracted-route switch', async () => {
    const app = makeApp();
    const response = await request(app)
      .post('/v1/dupe/compare')
      .set(makeHeaders())
      .send({
        original: {
          brand: 'The Ordinary',
          product_name: 'Niacinamide 10% + Zinc 1%',
          url: 'https://www.sephora.com/product/the-ordinary-niacinamide-10-zinc-1-P427417',
        },
        dupe: {
          kind: 'dupe',
          product: {
            brand: 'MockDupeBrand',
            product_name: 'Mock Dupe Serum',
            url: 'https://example.com/mock-dupe-serum',
          },
        },
      })
      .expect(200);

    const card = getCard(response.body, 'dupe_compare');
    expect(card).toBeTruthy();
    expect(card.payload.original).toBeTruthy();
    expect(card.payload.dupe).toBeTruthy();
  });
});
