const request = require('supertest');
const nock = require('nock');

function buildPublishedIntelProduct(productId = 'ext_real_intel_1') {
  return {
    merchant_id: 'external_seed',
    product_id: productId,
    title: 'Vitamin C + Retinol Eye Cream',
    brand: 'Pivota Test',
    category: 'Eye cream',
    currency: 'USD',
    price: { amount: 24, currency: 'USD' },
    product_intel: {
      contract_version: 'pivota.product_intel.v1',
      display_name: 'Pivota Insights',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: productId,
      },
      product_intel_core: {
        what_it_is: {
          headline: 'Vitamin C + Retinol Eye Cream',
          body: 'An eye cream combining vitamin C, encapsulated retinol, and hyaluronic acid for the eye area.',
        },
        best_for: [
          {
            tag: 'eye_area_brightness',
            label: 'Eye-area brightness and texture',
            confidence: 'moderate',
          },
        ],
        why_it_stands_out: [
          {
            headline: 'Multi-active eye cream',
            body: 'Combines brightening, smoothing, and hydrating actives in one eye-area cream.',
            evidence_strength: 'formula_supported',
          },
        ],
        routine_fit: {
          step: 'eye cream',
          am_pm: ['pm'],
          pairing_notes: ['Use after serum and before moisturizer.'],
        },
        watchouts: [],
        confidence: { overall: 'moderate' },
        freshness: {
          generated_at: '2026-04-10T00:00:00.000Z',
          source_version: 'manual_review_curated',
        },
        quality_state: 'eligible',
        evidence_profile: 'seller_plus_formula',
        source_coverage: {
          seller: { available: true },
          formula: { available: true },
          reviews: { available: false, count: 0 },
          creator: { available: false, count: 0 },
          editorial: { available: false, count: 0 },
        },
      },
      community_signals: {
        status: 'unavailable',
        unavailable_reason: 'insufficient_feedback',
        confidence: 'low',
        evidence_profile: 'seller_plus_formula',
      },
      quality_state: 'eligible',
      evidence_profile: 'seller_plus_formula',
      source_coverage: {
        seller: { available: true },
        formula: { available: true },
        reviews: { available: false, count: 0 },
        creator: { available: false, count: 0 },
        editorial: { available: false, count: 0 },
      },
      confidence: { overall: 'moderate' },
      freshness: {
        generated_at: '2026-04-10T00:00:00.000Z',
        source_version: 'manual_review_curated',
      },
      provenance: {
        source: 'product_intel_pilot_compare',
        generator: 'manual_review_curated',
      },
    },
  };
}

describe('get_product_intel_v1 real-mode invoke contract', () => {
  const apiBase = 'http://localhost:8080';
  let previousEnv;

  beforeEach(() => {
    nock.cleanAll();
    jest.resetModules();
    previousEnv = {
      API_MODE: process.env.API_MODE,
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      DATABASE_URL: process.env.DATABASE_URL,
      AGENT_AUTH_INTROSPECT_URL: process.env.AGENT_AUTH_INTROSPECT_URL,
      AGENT_AUTH_INTROSPECT_INTERNAL_KEY: process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY,
    };
    process.env.API_MODE = 'REAL';
    process.env.PIVOTA_API_BASE = apiBase;
    process.env.PIVOTA_API_KEY = 'ak_live_0000000000000000000000000000000000000000000000000000000000000000';
    delete process.env.DATABASE_URL;
    delete process.env.AGENT_AUTH_INTROSPECT_URL;
    delete process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY;
  });

  afterEach(() => {
    nock.cleanAll();
    jest.resetModules();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('serves published Pivota Insights instead of falling through to ROUTE_MAP', async () => {
    nock(apiBase)
      .get('/agent/v1/products/external_seed/ext_real_intel_1')
      .reply(200, { product: buildPublishedIntelProduct() });

    const app = require('../../src/server');
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_product_intel_v1',
        payload: {
          product_ref: {
            merchant_id: 'external_seed',
            product_id: 'ext_real_intel_1',
          },
        },
      })
      .expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        status: 'success',
        contract_version: 'pivota.product_intel.v1',
        display_name: 'Pivota Insights',
        canonical_product_ref: {
          merchant_id: 'external_seed',
          product_id: 'ext_real_intel_1',
        },
        evidence_profile: 'seller_plus_formula',
      }),
    );
    expect(res.body.product_intel_core.what_it_is.body).toContain('encapsulated retinol');
    expect(res.body.product_intel_core.why_it_stands_out[0].body).toContain('brightening');
  });
});
