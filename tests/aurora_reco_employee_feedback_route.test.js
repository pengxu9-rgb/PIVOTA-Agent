const request = require('supertest');

const ENV_PREFIXES_TO_RESTORE = [
  'AURORA_BFF_',
  'PROXY_SEARCH_',
  'SEARCH_',
];

const EXPLICIT_ENV_KEYS_TO_RESTORE = [
  'API_MODE',
  'DATABASE_URL',
  'PIVOTA_API_BASE',
  'PIVOTA_API_KEY',
  'PIVOTA_BACKEND_BASE_URL',
  'PROMOTIONS_BACKEND_BASE_URL',
];

function loadServerRuntime() {
  let app;
  let auroraRoutes;
  jest.isolateModules(() => {
    app = require('../src/server');
    auroraRoutes = require('../src/auroraBff/routes');
  });
  return { app, auroraRoutes };
}

function captureRelevantEnv() {
  const snapshot = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      EXPLICIT_ENV_KEYS_TO_RESTORE.includes(key) ||
      ENV_PREFIXES_TO_RESTORE.some((prefix) => key.startsWith(prefix))
    ) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function restoreRelevantEnv(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (
      EXPLICIT_ENV_KEYS_TO_RESTORE.includes(key) ||
      ENV_PREFIXES_TO_RESTORE.some((prefix) => key.startsWith(prefix))
    ) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function clearRelevantEnv() {
  for (const key of Object.keys(process.env)) {
    if (
      EXPLICIT_ENV_KEYS_TO_RESTORE.includes(key) ||
      ENV_PREFIXES_TO_RESTORE.some((prefix) => key.startsWith(prefix))
    ) {
      delete process.env[key];
    }
  }
}

describe('aurora reco dogfood feedback/interleave/async routes', () => {
  jest.setTimeout(15000);
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.dontMock('../src/auroraBff/routes');
    jest.dontMock('../src/server');
    jest.dontMock('axios');

    prevEnv = captureRelevantEnv();
    clearRelevantEnv();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.dontMock('../src/auroraBff/routes');
    jest.dontMock('../src/server');
    jest.dontMock('axios');
    delete process.env.AURORA_BFF_RECO_DOGFOOD_MODE;
    delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    delete global.__auroraPrelabelFeedbackStats;
    jest.resetModules();

    if (!prevEnv) return;
    restoreRelevantEnv(prevEnv);
  });

  test('dogfood disabled returns 404 for employee endpoints', async () => {
    process.env.AURORA_BFF_RECO_DOGFOOD_MODE = 'false';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    const { app } = loadServerRuntime();
    await request(app)
      .post('/v1/reco/employee-feedback')
      .send({})
      .expect(404);
    await request(app)
      .post('/v1/reco/interleave/click')
      .send({})
      .expect(404);
    await request(app)
      .get('/v1/reco/async-updates')
      .query({ ticket_id: 'x', since_version: 0 })
      .expect(404);
  });

  test('dogfood enabled accepts employee feedback payload', async () => {
    process.env.AURORA_BFF_RECO_DOGFOOD_MODE = 'true';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    const { app } = loadServerRuntime();
    const res = await request(app)
      .post('/v1/reco/employee-feedback')
      .set('X-Aurora-UID', 'uid_reco_feedback')
      .send({
        anchor_product_id: 'anchor_1',
        block: 'competitors',
        candidate_product_id: 'cand_1',
        feedback_type: 'relevant',
        reason_tags: ['ingredient_mismatch'],
        suggestion_id: 'sg_1',
        llm_suggested_label: 'not_relevant',
        llm_confidence: 0.22,
        request_id: 'req_1',
        session_id: 'sess_1',
      })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.event).toBeTruthy();
    expect(res.body.event.block).toBe('competitors');
    expect(res.body.event.feedback_type).toBe('relevant');
    expect(res.body.event.suggestion_id).toBe('sg_1');
    expect(res.body.event.llm_suggested_label).toBe('not_relevant');
    expect(res.body.event.llm_confidence).toBeCloseTo(0.22);
    expect(res.body.event.request_id).toBe('req_1');
    expect(res.body.event.session_id).toBe('sess_1');
  });

  test('interleave click resolves attribution from tracking snapshot', async () => {
    process.env.AURORA_BFF_RECO_DOGFOOD_MODE = 'true';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    const { app, auroraRoutes } = loadServerRuntime();
    const { __internal } = auroraRoutes;
    __internal.registerRecoTrackingSnapshot({
      requestId: 'req_i1',
      sessionId: 'sess_i1',
      anchorProductId: 'anchor_i1',
      blocks: {
        competitors: [{ product_id: 'cand_i1' }],
        related_products: [],
        dupes: [],
      },
      trackingByBlock: {
        competitors: {
          cand_i1: {
            rank_position: 1,
            attribution: 'A',
            was_exploration_slot: true,
          },
        },
      },
      ttlMs: 60000,
    });

    const res = await request(app)
      .post('/v1/reco/interleave/click')
      .set('X-Aurora-UID', 'uid_reco_interleave')
      .send({
        anchor_product_id: 'anchor_i1',
        block: 'competitors',
        candidate_product_id: 'cand_i1',
        request_id: 'req_i1',
        session_id: 'sess_i1',
      })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.attribution).toBe('A');
    expect(res.body.was_exploration_slot).toBe(true);
    expect(res.body.rank_position).toBe(1);
  });

  test('async updates returns ticket patch when version advances', async () => {
    process.env.AURORA_BFF_RECO_DOGFOOD_MODE = 'true';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    const { app, auroraRoutes } = loadServerRuntime();
    const { __internal } = auroraRoutes;
    const ticket = __internal.createAsyncTicket({
      requestId: 'req_async_1',
      cardId: 'card_async_1',
      lockTopN: 2,
      initialPayload: {
        competitors: { candidates: [{ product_id: 'a1' }] },
        related_products: { candidates: [] },
        dupes: { candidates: [] },
        provenance: {},
      },
      ttlMs: 60000,
    });
    __internal.applyAsyncBlockPatch({
      ticketId: ticket.ticketId,
      block: 'competitors',
      nextCandidates: [{ product_id: 'a1', evidence_refs: [{ id: 'stub' }] }],
    });
    const res = await request(app)
      .get('/v1/reco/async-updates')
      .set('X-Aurora-UID', 'uid_reco_async')
      .query({
        ticket_id: ticket.ticketId,
        since_version: 1,
      })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.has_update).toBe(true);
    expect(Array.isArray(res.body.payload_patch?.competitors?.candidates)).toBe(true);
  });
});
