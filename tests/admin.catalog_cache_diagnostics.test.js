const request = require('supertest');

describe('GET /api/admin/catalog-cache-diagnostics', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
    prevEnv = {
      ADMIN_API_KEY: process.env.ADMIN_API_KEY,
      DATABASE_URL: process.env.DATABASE_URL,
    };
    process.env.ADMIN_API_KEY = 'admin_test_key';
    process.env.DATABASE_URL = 'postgres://test';
  });

  afterEach(() => {
    jest.dontMock('../src/db');
    jest.resetModules();
    if (prevEnv.ADMIN_API_KEY === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevEnv.ADMIN_API_KEY;
    if (prevEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevEnv.DATABASE_URL;
  });

  test('requires admin key', async () => {
    const app = require('../src/server');
    const resp = await request(app)
      .get('/api/admin/catalog-cache-diagnostics')
      .query({ q: 'ipsa' });

    expect(resp.status).toBe(401);
    expect(resp.body).toEqual(expect.objectContaining({ error: 'UNAUTHORIZED' }));
  });

  test('returns db/cache diagnostics with query probe', async () => {
    jest.doMock('../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('current_database() AS database_name')) {
          return {
            rows: [
              {
                database_name: 'pivota_main',
                schema_name: 'public',
                user_name: 'gateway_user',
                server_addr: '10.0.0.7',
                server_port: '5432',
              },
            ],
          };
        }
        if (text.includes('COUNT(*)::bigint AS total_rows') && !text.includes('GROUP BY merchant_id')) {
          return {
            rows: [
              {
                total_rows: '120',
                not_expired_rows: '88',
                sellable_rows: '70',
                latest_cached_at: '2026-02-18T07:00:00.000Z',
                latest_expires_at: '2026-02-19T07:00:00.000Z',
              },
            ],
          };
        }
        if (text.includes('FROM products_cache') && text.includes('GROUP BY merchant_id') && text.includes('LIMIT $1')) {
          return {
            rows: [
              {
                merchant_id: 'merch_efbc46b4619cfbdf',
                total_rows: '50',
                not_expired_rows: '40',
                sellable_rows: '35',
                latest_cached_at: '2026-02-18T06:00:00.000Z',
                latest_expires_at: '2026-02-19T06:00:00.000Z',
              },
            ],
          };
        }
        if (text.includes('WHERE merchant_id = ANY($1)') && text.includes('GROUP BY merchant_id')) {
          return {
            rows: [
              {
                merchant_id: 'merch_efbc46b4619cfbdf',
                total_rows: '50',
                not_expired_rows: '40',
                sellable_rows: '35',
                latest_cached_at: '2026-02-18T06:00:00.000Z',
              },
            ],
          };
        }
        if (text.includes('FROM merchant_onboarding')) {
          return {
            rows: [
              {
                merchant_id: 'merch_efbc46b4619cfbdf',
                status: 'approved',
                psp_connected: true,
              },
            ],
          };
        }
        if (text.includes('field_like_rows')) {
          return { rows: [{ field_like_rows: '0' }] };
        }
        if (text.includes('json_like_rows')) {
          return { rows: [{ json_like_rows: '2' }] };
        }
        if (text.includes("product_data->>'title' AS title")) {
          return {
            rows: [
              {
                merchant_id: 'merch_efbc46b4619cfbdf',
                product_id: '9886500127048',
                title: 'IPSA Time Reset Aqua',
                status: 'published',
                cached_at: '2026-02-18T06:00:00.000Z',
                expires_at: '2026-02-19T06:00:00.000Z',
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const app = require('../src/server');
    const resp = await request(app)
      .get('/api/admin/catalog-cache-diagnostics')
      .set('X-ADMIN-KEY', 'admin_test_key')
      .query({ q: 'ipsa', source: 'shopping_agent' });

    expect(resp.status).toBe(200);
    expect(resp.body.ok).toBe(true);
    expect(resp.body.db).toEqual(
      expect.objectContaining({
        database_name: 'pivota_main',
        schema_name: 'public',
        user_name: 'gateway_user',
      }),
    );
    expect(typeof resp.body.db.fingerprint).toBe('string');
    expect(resp.body.totals).toEqual(
      expect.objectContaining({
        total_rows: 120,
        not_expired_rows: 88,
        sellable_rows: 70,
      }),
    );
    expect(resp.body.query_probe).toEqual(
      expect.objectContaining({
        query: 'ipsa',
        field_like_rows: 0,
        json_like_rows: 2,
      }),
    );
    expect(resp.body.query_probe.sample_rows?.[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'merch_efbc46b4619cfbdf',
        product_id: '9886500127048',
        title: 'IPSA Time Reset Aqua',
      }),
    );
    expect(Array.isArray(resp.body.creator_merchants?.configured)).toBe(true);
  });
});
