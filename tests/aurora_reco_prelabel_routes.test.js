const request = require('supertest');

describe('aurora reco prelabel internal routes', () => {
  afterEach(() => {
    delete process.env.AURORA_BFF_RECO_DOGFOOD_MODE;
    delete process.env.AURORA_BFF_RECO_PRELABEL_ENABLED;
    delete process.env.AURORA_BFF_RECO_PRELABEL_ADMIN_KEY;
    delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('prelabel route requires dogfood+admin key', async () => {
    process.env.AURORA_BFF_RECO_DOGFOOD_MODE = 'true';
    process.env.AURORA_BFF_RECO_PRELABEL_ENABLED = 'true';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    process.env.AURORA_BFF_RECO_PRELABEL_ADMIN_KEY = 'admin_test_key';

    jest.doMock('../src/auroraBff/recoPrelabelService', () => ({
      generatePrelabelsForAnchor: jest.fn(async () => ({
        ok: true,
        candidates_total: 1,
        cache_hit_count: 0,
        requested_by_block: { competitors: 1, dupes: 0, related_products: 0 },
        generated_by_block: { competitors: 1, dupes: 0, related_products: 0 },
        invalid_json_by_block: { competitors: 0, dupes: 0, related_products: 0 },
        cache_hit_by_block: { competitors: 0, dupes: 0, related_products: 0 },
        suggestions_by_block: { competitors: [], dupes: [], related_products: [] },
        gemini_latency_ms: [88],
      })),
      loadSuggestionsForAnchor: jest.fn(async () => []),
    }));

    const app = require('../src/server');

    await request(app)
      .post('/internal/prelabel')
      .set('X-Aurora-UID', 'uid_prelabel_1')
      .send({ anchor_product_id: 'anchor_1' })
      .expect(403);

    const ok = await request(app)
      .post('/internal/prelabel')
      .set('X-Aurora-UID', 'uid_prelabel_2')
      .set('X-Aurora-Admin-Key', 'admin_test_key')
      .send({ anchor_product_id: 'anchor_2', blocks: ['competitors'] })
      .expect(200);

    expect(ok.body.ok).toBe(true);
    expect(ok.body.data).toBeTruthy();
  });

  test('prelabel suggestions route returns suggestion list', async () => {
    process.env.AURORA_BFF_RECO_DOGFOOD_MODE = 'true';
    process.env.AURORA_BFF_RECO_PRELABEL_ENABLED = 'true';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    process.env.AURORA_BFF_RECO_PRELABEL_ADMIN_KEY = 'admin_test_key';

    jest.doMock('../src/auroraBff/recoPrelabelService', () => ({
      generatePrelabelsForAnchor: jest.fn(async () => ({})),
      loadSuggestionsForAnchor: jest.fn(async () => [
        {
          id: 'sg_1',
          anchor_product_id: 'anchor_1',
          block: 'competitors',
          candidate_product_id: 'cand_1',
          suggested_label: 'relevant',
          wrong_block_target: null,
          confidence: 0.81,
          rationale_user_visible: 'Aligned.',
          flags: ['needs_price_check'],
          model_name: 'gemini-2.0-flash',
          prompt_version: 'prelabel_v1',
          updated_at: new Date().toISOString(),
        },
      ]),
    }));

    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      normalizeKey: (x) => x,
      getProductIntelKbEntry: jest.fn(async () => ({
        analysis: {
          competitors: {
            candidates: [{ product_id: 'cand_1', name: 'Candidate 1' }],
          },
        },
      })),
      upsertProductIntelKbEntry: jest.fn(async () => null),
    }));

    const app = require('../src/server');
    const res = await request(app)
      .get('/internal/prelabel/suggestions')
      .set('X-Aurora-UID', 'uid_prelabel_suggestions')
      .set('X-Aurora-Admin-Key', 'admin_test_key')
      .query({ anchor_product_id: 'anchor_1', block: 'competitors' })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.suggestions)).toBe(true);
    expect(res.body.suggestions[0].suggested_label).toBe('relevant');
  });
});
