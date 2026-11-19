const request = require('supertest');

// Flag CATALOG_SERVING_INDEX_NO_DEFAULT_MARKET_ENABLED on: the admin backfill route passes an absent market through,
// so the backfill refuses it by name instead of silently scoping the run to 'US'. Off: 'US', as today.
const FLAG = 'CATALOG_SERVING_INDEX_NO_DEFAULT_MARKET_ENABLED';

describe('POST /api/admin/catalog-serving/backfill market', () => {
  let prevEnv;
  let backfill;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../src/auroraBff/routes', () => ({ mountAuroraBffRoutes: () => {}, __internal: {} }));
    const actual = jest.requireActual('../src/services/catalogServingIndex');
    // The real backfill (and so the real refusal), never allowed to read rows.
    backfill = jest.fn((options) => {
      if (options.market === undefined && String(process.env[FLAG] || '').trim().toLowerCase() === 'true') {
        return actual.backfillCatalogServingIndex(options, {
          fetchBackfillProductsFn: async () => {
            throw new Error('must not read rows');
          },
        });
      }
      return Promise.resolve({ dry_run: true, docs_built: 0 });
    });
    jest.doMock('../src/services/catalogServingIndex', () => ({ ...actual, backfillCatalogServingIndex: backfill }));
    prevEnv = {
      ADMIN_API_KEY: process.env.ADMIN_API_KEY,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
      [FLAG]: process.env[FLAG],
    };
    process.env.ADMIN_API_KEY = 'admin_test_key';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.dontMock('../src/auroraBff/routes');
    jest.dontMock('../src/services/catalogServingIndex');
    jest.resetModules();
    for (const [key, value] of Object.entries(prevEnv || {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const post = (body) =>
    request(require('../src/server'))
      .post('/api/admin/catalog-serving/backfill')
      .set('X-ADMIN-KEY', 'admin_test_key')
      .send(body);

  test('flag on, no market: refused by name, no rows read', async () => {
    process.env[FLAG] = 'true';
    const resp = await post({ dry_run: true });
    expect(resp.status).toBe(500);
    expect(resp.body).toMatchObject({
      ok: false,
      error: 'CATALOG_SERVING_BACKFILL_FAILED',
      message: 'catalog serving backfill needs an explicit market',
    });
    expect(backfill.mock.calls[0][0].market).toBeUndefined();
  });

  test.each([
    [undefined, {}, 'US'],
    [undefined, { market: 'SG' }, 'SG'],
    ['true', { market: 'SG' }, 'SG'],
    ['true', { market: '*' }, '*'],
  ])('flag %s, body %j -> market %s', async (flag, body, market) => {
    if (flag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = flag;
    const resp = await post({ dry_run: true, ...body });
    expect(resp.status).toBe(200);
    expect(backfill.mock.calls[0][0].market).toBe(market);
  });
});
