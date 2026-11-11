const fs = require('fs');
const path = require('path');
const request = require('supertest');

jest.setTimeout(60000);

// PARTNER_DOOR_ONE_PRODUCT_ID: what the REAL get_pdp_v2 says when it refuses a signature, and what the `/mcp`
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

  // The `/mcp` door's reading of each refusal. The kernel hop maps the body to its code with the UNCHANGED
  // mapping and throws it with the body as `upstream_detail` (src/server.js throwCommerceKernelUpstreamError:
  // for a gateway error body, extractUpstreamErrorCode's code is `error` and its detail is the body). The door
  // re-reads that error (remapReadFailure). The chained door test drives the same two steps through the real
  // route; this pins them against the bodies the real get_pdp_v2 just produced.
  const { mapUpstreamErrorToKernelCode } = require('../../src/services/commerceKernelErrorMapping');
  const partnerDoor = require('../../src/services/partnerDoorOneProductId');
  const kernelError = ({ status, body }) => ({
    code: mapUpstreamErrorToKernelCode({ operation: 'get_product_detail', upstreamCode: body.error, status }),
    detail: { operation: 'get_product_detail', upstream_status: status, upstream_code: body.error, upstream_detail: body },
  });
  const atDoor = (refusal) => {
    const error = kernelError(refusal);
    return partnerDoor.remapReadFailure({ ...error, merchantId: undefined, productId: IDS.SIG_NOT_SERVABLE }) || { code: error.code };
  };

  test('the kernel\'s own codes are what they were: both 404s read NO_MERCHANT_OFFER', () => {
    expect(kernelError(produced.not_servable).code).toBe('NO_MERCHANT_OFFER');
    expect(kernelError(produced.not_found).code).toBe('NO_MERCHANT_OFFER');
    expect(kernelError(produced.unresolved).code).toBe('UNKNOWN_PRODUCT_ID');
  });

  test('at the /mcp door: a withheld product is PRODUCT_NOT_SERVABLE with the gate\'s reason; an unresolved id stays unknown', () => {
    expect(atDoor(produced.not_servable)).toEqual({ code: 'PRODUCT_NOT_SERVABLE', reason: 'not_serving_eligible' });
    expect(atDoor(produced.not_found)).toEqual({ code: 'PRODUCT_NOT_SERVABLE', reason: 'product_detail_not_found' });
    expect(atDoor(produced.unresolved)).toEqual({ code: 'UNKNOWN_PRODUCT_ID' });
  });

  test('the same bodies named with the shared seed seller or an observed seller are read the same way; a connected seller\'s are not', () => {
    const error = kernelError(produced.not_servable);
    for (const merchantId of ['external_seed', IDS.SELLER_MINTED]) {
      expect(partnerDoor.remapReadFailure({ ...error, merchantId, productId: IDS.SIG_NOT_SERVABLE }).code).toBe('PRODUCT_NOT_SERVABLE');
    }
    // A connected seller's read goes to the per-merchant backend, never to this lane: its not-found is "that
    // merchant has no such product", whatever body it carries.
    expect(partnerDoor.remapReadFailure({ ...error, merchantId: IDS.SELLER_CONNECTED, productId: IDS.SIG_NOT_SERVABLE }))
      .toEqual({ code: 'UNKNOWN_PRODUCT_ID', reason: 'product_id_not_found' });
  });
});
