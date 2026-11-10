const fs = require('fs');
const path = require('path');
const request = require('supertest');

jest.setTimeout(60000);

// PARTNER_DOOR_ONE_PRODUCT_ID: what the REAL get_pdp_v2 says when it refuses a signature, and what the partner
// door makes of each refusal.
//
// The chained /mcp door test (tests/partner_door_one_product_id_chain.node.test.cjs) cannot run get_pdp_v2
// against a database, so it replays these bodies from tests/fixtures/partner_door_pdp_v2_refusals.json. This
// suite is what keeps that file honest: each body is produced here by the real route (the database is the only
// stand-in, as in get_pdp_v2_minted_canonical_seed_route.test.js) and must equal the recorded one, per-request
// ids and timings aside. Re-record with PARTNER_DOOR_RECORD_FIXTURE=1.
//
//   not_servable   the signature resolves to a catalog row the serving gate withholds
//   not_found      the signature resolves, the gate passes, and no content answers the resolved route
//   unresolved     no row carries the signature

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn() })),
}));

const { IDS, rows } = require('../_support/partnerDoorFixture.cjs');
const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'partner_door_pdp_v2_refusals.json');
const ORIGINAL_ENV = process.env;
const minted = rows.catalog_products.find((p) => p.pivota_signature_id === IDS.SIG_MINTED);

const normalizeSql = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();

function loadServerWithDb() {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    PIVOTA_API_BASE: 'http://localhost:8080',
    PIVOTA_API_KEY: 'test-token',
  };
  const db = require('../../src/db');
  db.query.mockReset();
  return { app: require('../../src/server'), db };
}

// The row the signature resolver's statement returns for the fixture's minted product (lane 1: the seed came
// through attached_product_key, so the route id is the seed's own id, not the row's slug).
const signatureRow = (signature, over = {}) => ({
  merchant_id: minted.merchant_id,
  platform: minted.platform,
  source_product_id: minted.source_product_id,
  product_key: minted.product_key,
  source_system: minted.source_system,
  pivota_signature_id: signature,
  content_key: 'ck_00000000000000000000000000000001',
  catalog_title: 'Calm Serum',
  catalog_brand: 'Brand X',
  signature_serving_eligible: true,
  external_seed_id: 1,
  external_seed_external_product_id: IDS.SEED_MINTED,
  external_seed_status: 'active',
  external_seed_route_lane: 1,
  ...over,
});

const CASES = {
  not_servable: { signature: IDS.SIG_NOT_SERVABLE, row: signatureRow(IDS.SIG_NOT_SERVABLE, { signature_serving_eligible: false }) },
  not_found: { signature: IDS.SIG_NOT_SERVABLE, row: signatureRow(IDS.SIG_NOT_SERVABLE) },
  unresolved: { signature: IDS.SIG_NOT_SERVABLE, row: null },
};

// Per-request values out; every other byte is the route's.
function masked(status, body) {
  const out = JSON.parse(JSON.stringify(body));
  if (out.gateway_request_id) out.gateway_request_id = '<id>';
  if (out.metadata && out.metadata.route_health) out.metadata.route_health = '<timings>';
  return { status, body: out };
}

async function refuse({ signature, row }) {
  const { app, db } = loadServerWithDb();
  db.query.mockImplementation(async (sql) =>
    (row && normalizeSql(sql).includes('cp.pivota_signature_id = $1') ? { rows: [row] } : { rows: [] }));
  const res = await request(app).post('/agent/shop/v1/invoke').send({
    operation: 'get_pdp_v2',
    payload: { product_ref: { product_id: signature }, include: ['product_overview'], market: 'US' },
  });
  return masked(res.status, res.body);
}

describe('partner door: the real get_pdp_v2 refusals and their partner codes', () => {
  const produced = {};
  beforeAll(async () => {
    for (const [name, c] of Object.entries(CASES)) produced[name] = await refuse(c);
    if (process.env.PARTNER_DOOR_RECORD_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(produced, null, 2)}\n`);
    }
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('the recorded bodies are what the route emits today', () => {
    expect(produced).toEqual(JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')));
  });

  test('the three refusals are the three shapes the door tells apart', () => {
    expect(produced.not_servable.status).toBe(404);
    expect(produced.not_servable.body.error).toBe('PRODUCT_NOT_SERVABLE');
    expect(produced.not_servable.body.details.reason).toBe('not_serving_eligible');
    expect(produced.not_found.status).toBe(404);
    expect(produced.not_found.body.error).toBe('PRODUCT_NOT_FOUND');
    expect(produced.not_found.body.metadata.identity_resolution.resolution_source).toBe('catalog_products_signature_exact');
    expect(produced.unresolved.status).toBe(400);
    expect(produced.unresolved.body.error).toBe('MISSING_MERCHANT_CONTEXT');
  });

  // The door's own reading of each body, through the same two functions throwCommerceKernelUpstreamError calls.
  const { mapUpstreamErrorToKernelCode } = require('../../src/services/commerceKernelErrorMapping');
  const partnerDoor = require('../../src/services/partnerDoorOneProductId');
  const read = ({ status, body }, { flag }) => {
    // extractUpstreamErrorCode's answer for a legacy gateway error body: the code is `error`, the detail the body.
    const extracted = { code: body.error, data: body, detail: body };
    const failure = flag ? partnerDoor.describePartnerDoorReadFailure({ extracted, pdpV2Detail: true }) : null;
    const code = mapUpstreamErrorToKernelCode({
      operation: 'get_product_detail', upstreamCode: body.error, status,
      ...(failure ? { partnerDoorRead: failure.partnerDoorRead } : {}),
    });
    return { code, reason: failure ? partnerDoor.partnerDoorReadFailureReason(code, failure.reason) : null };
  };

  test('flag off: both 404s read NO_MERCHANT_OFFER, as before', () => {
    expect(read(produced.not_servable, { flag: false }).code).toBe('NO_MERCHANT_OFFER');
    expect(read(produced.not_found, { flag: false }).code).toBe('NO_MERCHANT_OFFER');
    expect(read(produced.unresolved, { flag: false }).code).toBe('UNKNOWN_PRODUCT_ID');
  });

  test('flag on: a withheld product is PRODUCT_NOT_SERVABLE with the gate\'s reason; an unresolved id stays unknown', () => {
    expect(read(produced.not_servable, { flag: true })).toEqual({ code: 'PRODUCT_NOT_SERVABLE', reason: 'not_serving_eligible' });
    expect(read(produced.not_found, { flag: true })).toEqual({ code: 'PRODUCT_NOT_SERVABLE', reason: 'product_detail_not_found' });
    expect(read(produced.unresolved, { flag: true })).toEqual({ code: 'UNKNOWN_PRODUCT_ID', reason: 'product_id_not_found' });
  });
});
