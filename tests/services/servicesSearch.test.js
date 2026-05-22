jest.mock('../../src/db', () => ({
  query: jest.fn(),
}));

jest.mock('../../src/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/auroraBff/routes', () => ({
  mountAuroraBffRoutes: () => {},
  __internal: {},
}));

const request = require('supertest');
const { query } = require('../../src/db');
const logger = require('../../src/logger');
const {
  searchServices,
  normalizeServicesSearchParams,
  __test,
} = require('../../src/services/servicesSearch');
const app = require('../../src/server');

function listing(overrides = {}) {
  return {
    service_type: 'facial',
    title: 'Hydration Facial',
    price_cents: 30000,
    currency: 'KRW',
    duration_minutes: 60,
    requires_consult: false,
    ...overrides,
  };
}

function providerRow(overrides = {}) {
  return {
    provider_id: 'provider-1',
    display_name: 'Aya Seoul',
    name: 'Aya Seoul Legal',
    address_line1: '15 Seolleung-ro 148-gil',
    city: 'Seoul',
    region: 'Gangnam-gu',
    country_code: 'KR',
    provider_url: 'https://www.ayaseoul.com/about-aya-seoul',
    english_friendly_signal: 'explicit',
    english_friendly_evidence: 'English booking page and consultation notes.',
    tourist_metadata: {
      nearest_station: 'Apgujeong Rodeo',
      walk_in_accepted: 'false',
      accepts_card: 'unknown',
      tipping_norm: 'not-expected',
    },
    rating: null,
    rating_count: null,
    service_types_offered: ['facial'],
    matching_listings_count: 1,
    preview_listings: [listing()],
    ...overrides,
  };
}

function mockSearchRows(rows, total = rows.length) {
  query
    .mockResolvedValueOnce({ rows })
    .mockResolvedValueOnce({ rows: [{ total }] });
}

describe('servicesSearch', () => {
  beforeEach(() => {
    query.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
    __test._invalidateCache();
  });

  afterAll(() => {
    __test._invalidateCache();
  });

  test('GET /api/services with no params returns default scope, query, and total', async () => {
    mockSearchRows(
      [
        providerRow({
          service_types_offered: ['eyebrow-tattoo', 'lashes'],
          matching_listings_count: 4,
          preview_listings: [
            listing({ title: 'Null price', price_cents: null }),
            listing({ title: 'Mid', price_cents: 70000 }),
            listing({ title: 'Low', price_cents: 50000 }),
            listing({ title: 'Hidden', price_cents: 10000 }),
          ],
        }),
      ],
      16,
    );

    const res = await request(app).get('/api/services');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'success',
      scope: { city: 'Seoul', region: 'Gangnam-gu', country_code: 'KR' },
      query: {
        q: null,
        service_type: null,
        english_friendly: false,
        priced_only: false,
        max_price_won: null,
      },
      pagination: { limit: 20, offset: 0, total: 16, has_more: true },
    });
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toEqual(
      expect.objectContaining({
        provider_id: 'provider-1',
        name: 'Aya Seoul Legal',
        display_name: 'Aya Seoul',
        address: '15 Seolleung-ro 148-gil, Seoul, Gangnam-gu, KR',
        url: 'https://www.ayaseoul.com/about-aya-seoul',
        english_friendly_signal: 'explicit',
        service_types_offered: ['eyebrow-tattoo', 'lashes'],
        matching_listings_count: 4,
      }),
    );
    expect(res.body.results[0].preview_listings.map((item) => item.price_cents)).toEqual([
      10000,
      50000,
      70000,
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual(['Seoul', 'Gangnam-gu', 'KR', 20, 0]);
    expect(query.mock.calls[1][1]).toEqual(['Seoul', 'Gangnam-gu', 'KR']);
  });

  test('q="facial" uses parameterized ILIKE and match-strength ranking', async () => {
    mockSearchRows(
      [
        providerRow({
          provider_id: 'facial-top',
          display_name: 'Facial House',
          matching_listings_count: 5,
        }),
      ],
      3,
    );

    const out = await searchServices({ q: 'facial', limit: '10' });

    expect(out.results[0].provider_id).toBe('facial-top');
    expect(out.total).toBe(3);
    expect(query).toHaveBeenCalledTimes(2);
    const [sql, values] = query.mock.calls[0];
    expect(values).toEqual(['Seoul', 'Gangnam-gu', 'KR', '%facial%', 10, 0]);
    expect(sql).toContain('COALESCE(sl.title');
    expect(sql).toContain('COALESCE(sl.description');
    expect(sql).toContain('CASE WHEN COALESCE(title');
    expect(sql).toContain('provider_agg.match_score DESC');
    expect(sql).toContain('provider_agg.matching_listings_count DESC');
  });

  test('service_type="chemical-peel" adds an allow-listed listing filter', async () => {
    mockSearchRows([providerRow({ service_types_offered: ['chemical-peel'] })], 1);

    await searchServices({ service_type: 'chemical-peel' });

    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('sl.service_type = $4');
    expect(values).toEqual(['Seoul', 'Gangnam-gu', 'KR', 'chemical-peel', 20, 0]);
  });

  test('english_friendly="true" filters provider metadata JSONB signal', async () => {
    mockSearchRows([providerRow({ english_friendly_signal: 'inferred' })], 1);

    await searchServices({ english_friendly: 'true' });

    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("(sp.metadata->>'english_friendly_signal') IN ('explicit', 'inferred')");
    expect(sql).not.toContain('sp.english_friendly_signal');
    expect(values).toEqual(['Seoul', 'Gangnam-gu', 'KR', 20, 0]);
  });

  test('priced_only="true" filters listings without prices', async () => {
    mockSearchRows([providerRow()], 1);

    await searchServices({ priced_only: 'true' });

    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('sl.price_cents IS NOT NULL');
    expect(values).toEqual(['Seoul', 'Gangnam-gu', 'KR', 20, 0]);
  });

  test('max_price_won=100000 applies an inclusive price cap', async () => {
    mockSearchRows([providerRow()], 1);

    await searchServices({ max_price_won: '100000' });

    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('sl.price_cents <= $4');
    expect(values).toEqual(['Seoul', 'Gangnam-gu', 'KR', 100000, 20, 0]);
  });

  test('invalid service_type returns 400 with allowed values named', async () => {
    const res = await request(app).get('/api/services').query({ service_type: 'botox' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('service_type must be one of:');
    expect(res.body.error).toContain('nails');
    expect(res.body.error).toContain('eyebrow-tattoo');
    expect(query).not.toHaveBeenCalled();
  });

  test.each([
    ['0'],
    ['51'],
    ['abc'],
  ])('invalid limit=%s returns 400', async (limit) => {
    const res = await request(app).get('/api/services').query({ limit });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('limit');
    expect(query).not.toHaveBeenCalled();
  });

  test('empty result returns 200 with empty results and total=0', async () => {
    mockSearchRows([], 0);

    const res = await request(app).get('/api/services').query({ service_type: 'waxing' });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(res.body.pagination).toEqual({
      limit: 20,
      offset: 0,
      total: 0,
      has_more: false,
    });
  });

  test('cache hit avoids re-querying the DB for the same params', async () => {
    mockSearchRows([providerRow()], 1);

    const first = await searchServices({ service_type: 'facial' });
    const second = await searchServices({ service_type: 'facial' });

    expect(query).toHaveBeenCalledTimes(2);
    expect(second).toBe(first);
  });

  test('DB error returns 500 with INTERNAL_ERROR and does not propagate', async () => {
    query.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).get('/api/services').query({ q: 'facial' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL_ERROR' });
    // PII-safety: catch-all log records error_name + error_code (no message
    // — PG errors can echo conflicting field values).
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error_name: 'Error', query_keys: ['q'] }),
      'Failed to search services',
    );
    // Defense-in-depth: ensure raw `err` field with the message isn't present.
    const logCall = logger.warn.mock.calls.find((c) => c[1] === 'Failed to search services');
    expect(logCall[0]).not.toHaveProperty('err');
  });

  test('parameter normalization rejects duplicate query params', () => {
    expect(() => normalizeServicesSearchParams({ offset: ['0', '1'] })).toThrow(
      'offset must be provided at most once',
    );
  });
});
