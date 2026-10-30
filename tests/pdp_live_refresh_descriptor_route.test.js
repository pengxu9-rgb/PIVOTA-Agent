// get_pdp_v2 through the real invoke route issues the browser's live-refresh descriptor only on a normally
// served page whose request opted in (options.live_refresh). Network is disabled: the backend is nocked, the
// live readers' UCP client is a fake that throws, and the shadow read is sampled at 0.

const nock = require('nock');
const request = require('supertest');

jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

const ORIGINAL_ENV = process.env;
const SECRET = 'd'.repeat(48);
const VARIANT = '41234567890123';

function loadServer(envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    PIVOTA_API_BASE: 'https://backend.test',
    PIVOTA_API_KEY: 'test-token',
    UCP_LIVE_PDP_READ: 'shadow',
    UCP_LIVE_PDP_READ_SAMPLE: '0',
    UCP_LIVE_PDP_REFRESH: 'on',
    UCP_LIVE_PDP_REFRESH_SECRET: SECRET,
    ...envOverrides,
  };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
  const db = require('../src/db');
  db.query.mockReset();
  const app = require('../src/server');
  app._debug.useUcpLiveClientForTest({
    async discoverEndpoint() { throw new Error('no store may be contacted in this test'); },
    async lookupCatalog() { throw new Error('no store may be contacted in this test'); },
  });
  const statusRow = { id: 'eps_seed_db_1', external_product_id: 'ext_seed_db_1', status: 'active' };
  const detailRow = {
    ...statusRow,
    canonical_url: 'https://www.tomfordbeauty.com/products/noir-ext-seed-db-1',
    destination_url: 'https://www.tomfordbeauty.com/products/noir-ext-seed-db-1',
    title: 'Tom Ford Noir Extreme Parfum',
    image_url: 'https://cdn.example.com/tom-ford-noir.jpg',
    price_amount: '240.00',
    price_currency: 'USD',
    availability: 'In Stock',
    seed_data: {
      brand: 'Tom Ford Beauty',
      description: 'Warm amber fragrance.',
      snapshot: {
        canonical_url: 'https://www.tomfordbeauty.com/products/noir-ext-seed-db-1',
        product_id: 'ext_seed_db_1',
        variants: [{ variant_id: VARIANT, price: '240.00', currency: 'USD', stock: 'In Stock' }],
      },
    },
  };
  db.query.mockImplementation((sql) => {
    const text = String(sql || '');
    if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
      return Promise.resolve({ rows: [{
        content_key: 'ck_ext_seed_db_1', product_key: 'prod::external_seed::external_seed::ext_seed_db_1',
        pivota_signature_id: null, sync_status: 'live', pdp_lifecycle_stage: 'live', serving_eligible: true,
        pipeline_stage: 'serving', blocker_code: null, blocker_detail: null, content_quality_score: 95.2,
        active_external_seed_source_match: true,
      }] });
    }
    if (text.includes('FROM external_product_seeds') && text.includes('destination_url')) return Promise.resolve({ rows: [detailRow] });
    if (text.includes('FROM external_product_seeds') && text.includes('status')) return Promise.resolve({ rows: [statusRow] });
    return Promise.resolve({ rows: [] });
  });
  nock('https://backend.test')
    .persist()
    .get('/agent/v1/product-groups/resolve-by-product-id')
    .query(true)
    .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'No product group' });
  return app;
}

function getPdp(app, options) {
  return request(app)
    .post('/agent/shop/v1/invoke')
    .send({
      operation: 'get_pdp_v2',
      payload: { product_ref: { product_id: 'ext_seed_db_1' }, ...(options ? { options } : {}) },
      metadata: { market: 'US' },
    })
    .expect(200);
}

describe('get_pdp_v2 live_refresh descriptor', () => {
  beforeAll(() => {
    nock.disableNetConnect();
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  });
  afterEach(() => nock.cleanAll());
  afterAll(() => {
    nock.enableNetConnect();
    process.env = ORIGINAL_ENV;
  });

  test('an opted-in served page carries a token binding its card; the token answers pdp_live_read', async () => {
    const app = loadServer();
    const res = await getPdp(app, { live_refresh: true });
    expect(res.body.live_refresh).toEqual({ v: 1, token: expect.stringMatching(/^v1\./), market: 'US' });
    const { verifyRefreshToken } = require('../src/services/pdpLiveRefreshToken');
    const v = verifyRefreshToken(res.body.live_refresh.token, { secrets: [SECRET] });
    expect(v.ok).toBe(true);
    const card = res.body.modules.find((m) => m.type === 'canonical').data.pdp_payload.product;
    expect(v.claims).toMatchObject({
      pid: card.product_id, mid: card.merchant_id, h: 'www.tomfordbeauty.com', hd: 'noir-ext-seed-db-1', m: 'US', c: 'USD',
      ids: [VARIANT],
    });
    // The page as served goes straight back: it matches its token (no read: the client throws, so the
    // read is answered without a merchant answer).
    const live = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({ operation: 'pdp_live_read', payload: { live_refresh_token: res.body.live_refresh.token, page: res.body }, metadata: { market: 'US' } })
      .expect(200);
    expect(live.body.live_refresh.reason).not.toBe('page_mismatch');
    expect(live.body.live_refresh.outcome).toBe('no_answer');
  });

  test('no opt-in, flag off, or no secret: the page has no descriptor', async () => {
    expect((await getPdp(loadServer())).body.live_refresh).toBeUndefined();
    expect((await getPdp(loadServer({ UCP_LIVE_PDP_REFRESH: 'off' }), { live_refresh: true })).body.live_refresh).toBeUndefined();
    expect((await getPdp(loadServer({ UCP_LIVE_PDP_REFRESH_SECRET: '' }), { live_refresh: true })).body.live_refresh).toBeUndefined();
    expect((await getPdp(loadServer({ UCP_LIVE_PDP_READ: 'off' }), { live_refresh: true })).body.live_refresh).toBeUndefined();
  });
});
