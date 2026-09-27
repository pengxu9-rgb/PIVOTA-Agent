// pdp_route_id_exists through the real invoke route: the status codes are the contract the storefront
// reads — 200 with a boolean only when the probe answered, 503 on ANY failure (never exists:false), 400 on a
// malformed id. The DB layer is replaced so the statement's answer (or failure) is chosen per test.

process.env.NODE_ENV = 'test';
process.env.INVOKE_AUTH_BYPASS_IN_TEST = '1';
process.env.PIVOTA_API_BASE = 'https://backend.test';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://probe-test/unused';

const EXISTENCE_MARKER = 'AS catalog_signature';
let existenceAnswer = null;

jest.mock('../src/db', () => {
  const actual = jest.requireActual('../src/db');
  return {
    ...actual,
    query: jest.fn(async (sql, params) => {
      if (String(sql).includes(EXISTENCE_MARKER)) {
        if (existenceAnswer instanceof Error) throw existenceAnswer;
        return { rows: existenceAnswer ? [existenceAnswer(params)] : [] };
      }
      return { rows: [] };
    }),
  };
});

const request = require('supertest');
const app = require('../src/server');
const {
  __internal: { ROUTE_ID_LOOKUPS },
} = require('../src/services/pdpRouteIdExistence');

const NAMES = ROUTE_ID_LOOKUPS.map(([name]) => name);
const rowWith = (trueNames) => Object.fromEntries(NAMES.map((n) => [n, trueNames.includes(n)]));

function invoke(payload) {
  return request(app)
    .post('/agent/shop/v1/invoke')
    .set('content-type', 'application/json')
    .send({ operation: 'pdp_route_id_exists', payload });
}

afterEach(() => {
  existenceAnswer = null;
});

test('an id no table holds answers 200 exists:false', async () => {
  existenceAnswer = () => rowWith([]);
  const res = await invoke({ product_ref: { product_id: 'foo' } });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ status: 'success', contract: 'pdp_route_id_existence.v1', product_id: 'foo', exists: false });
});

test('a stored id answers 200 exists:true with the matching store', async () => {
  existenceAnswer = () => rowWith(['catalog_signature']);
  const res = await invoke({ product_id: 'sig_abc' });
  expect(res.status).toBe(200);
  expect(res.body.exists).toBe(true);
  expect(res.body.matched).toEqual(['catalog_signature']);
});

test('a failing statement answers 503 — never exists:false', async () => {
  existenceAnswer = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  const res = await invoke({ product_ref: { product_id: 'sig_abc' } });
  expect(res.status).toBe(503);
  expect(res.body.error).toBe('PDP_ROUTE_ID_EXISTENCE_UNAVAILABLE');
  expect(res.body.exists).toBeUndefined();
});

test('a statement that returns no row answers 503', async () => {
  existenceAnswer = null;
  const res = await invoke({ product_ref: { product_id: 'sig_abc' } });
  expect(res.status).toBe(503);
  expect(res.body.exists).toBeUndefined();
});

test('a synthesized pg: id answers exists:null', async () => {
  const res = await invoke({ product_ref: { product_id: 'pg:pid:123' } });
  expect(res.status).toBe(200);
  expect(res.body.exists).toBeNull();
  expect(res.body.reason).toBe('synthesized_id_family');
});

test('a missing id is a 400, not a probe', async () => {
  const res = await invoke({ product_ref: {} });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('INVALID_REQUEST');
});
