const request = require('supertest');

describe('aurora reco label queue route', () => {
  afterEach(() => {
    delete process.env.AURORA_BFF_RECO_DOGFOOD_MODE;
    delete process.env.AURORA_BFF_RECO_PRELABEL_ENABLED;
    delete process.env.AURORA_BFF_RECO_PRELABEL_ADMIN_KEY;
    delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('returns prioritized queue entries', async () => {
    process.env.AURORA_BFF_RECO_DOGFOOD_MODE = 'true';
    process.env.AURORA_BFF_RECO_PRELABEL_ENABLED = 'true';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    process.env.AURORA_BFF_RECO_PRELABEL_ADMIN_KEY = 'admin_test_key';

    jest.doMock('../src/auroraBff/recoLabelSuggestionStore', () => ({
      listQueueCandidatesWithSuggestions: jest.fn(async () => [
        {
          id: 's1',
          anchor_product_id: 'anchor_1',
          block: 'dupes',
          candidate_product_id: 'cand_1',
          suggested_label: 'wrong_block',
          wrong_block_target: 'related_products',
          confidence: 0.2,
          rationale_user_visible: 'Need review.',
          flags: ['needs_price_check'],
          snapshot: { candidate: { price: null, score_breakdown: { score_total: 0.5 } } },
          updated_at: '2026-02-18T00:00:01.000Z',
        },
        {
          id: 's2',
          anchor_product_id: 'anchor_1',
          block: 'dupes',
          candidate_product_id: 'cand_2',
          suggested_label: 'relevant',
          wrong_block_target: null,
          confidence: 0.9,
          rationale_user_visible: 'Looks fine.',
          flags: [],
          snapshot: { candidate: { price: 30, score_breakdown: { score_total: 0.9 } } },
          updated_at: '2026-02-18T00:00:02.000Z',
        },
      ]),
      upsertSuggestion: jest.fn(),
      getSuggestionsByAnchor: jest.fn(),
      getSuggestionByInputHash: jest.fn(),
      __internal: { state: { dbUnavailable: true } },
    }));

    const app = require('../src/server');
    const res = await request(app)
      .get('/internal/label-queue')
      .set('X-Aurora-UID', 'uid_queue_1')
      .set('X-Aurora-Admin-Key', 'admin_test_key')
      .query({ block: 'dupes', limit: 10 })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items[0].priority_score).toBeGreaterThanOrEqual(res.body.items[1].priority_score);
  });
});
