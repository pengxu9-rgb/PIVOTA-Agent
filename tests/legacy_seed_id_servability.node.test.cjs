'use strict';

// FIX_PLAN D-06 / review G-1..G-4: search serves legacy `<host-slug>:<16 hex>` seed ids under the shared seed
// seller. get_product sent them to the backend's products_cache read, which cannot resolve them
// (NO_MERCHANT_OFFER). They are now ROUTED to the gateway's seed-DB detail lane, which opens them, and search
// makes every such row advertise an id that opens. Only a row that no lane can open is dropped.
//
// All store, brand and product names here are placeholders.

const test = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_ENV = { ...process.env };
const ISS = 'https://as.pivota.test';
const RESOURCE = 'https://agent.test.example/mcp';
const INTROSPECT_BASE = 'http://auth.legacy-seed-ids.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const AGENT_KEY = `ak_live_${'e'.repeat(64)}`;

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.PIVOTA_API_KEY = 'gateway-service-key';
process.env.PIVOTA_API_BASE = 'http://backend.legacy-seed-ids.test';
// find_products_multi is served over loopback by this gateway's own invoke route; intercept that hop too.
process.env.SELF_INVOKE_BASE = 'http://self.legacy-seed-ids.test';
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.MCP_OAUTH_ENABLED = '1';
process.env.MCP_OAUTH_RESOURCE = RESOURCE;
process.env.MCP_OAUTH_AUTHORIZATION_SERVERS = ISS;
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
process.env.INVOKE_AUTH_BYPASS_IN_TEST = '0';
delete process.env.PUBLIC_READ_MCP_ENABLED;
delete process.env.MCP_OAUTH_ISSUERS_JSON;

// ---- the database at the process edge -----------------------------------------------------------------
// The seed-DB detail lane reads external_product_seeds. The db module is replaced BEFORE the server loads
// (server.js destructures `query` at load), so the real routing runs over a fake table of one active seed.
const LEGACY_OPEN = 'shop-a:0123456789abcdef';
const SEED_ROW = {
  id: 'eps_legacy_open_1',
  external_product_id: LEGACY_OPEN,
  destination_url: 'https://shop-a.example/products/barrier-cream',
  canonical_url: null,
  domain: 'shop-a.example',
  title: 'Brand A barrier cream 50ml',
  image_url: 'https://shop-a.example/img/cream.jpg',
  price_amount: 24,
  price_currency: 'USD',
  availability: 'in_stock',
  attached_product_key: null,
  seed_data: { brand: 'Brand A', title: 'Brand A barrier cream 50ml', category: 'moisturizer' },
  updated_at: '2026-11-01T00:00:00Z',
  created_at: '2026-10-01T00:00:00Z',
  status: 'active',
};
const seedQueries = [];
process.env.DATABASE_URL = 'postgres://127.0.0.1:1/legacy_seed_stub';
const dbPath = require.resolve('../src/db/index.js');
const realDb = require('../src/db');
const MATCH_BRANCHES = ['external_product_id', 'seed_id', 'seed_data_external_product_id', 'seed_data_product_id', 'seed_snapshot_product_id'];
let probeFails = false;
async function fakeQuery(sql, params) {
  const text = String(sql || '');
  // The search-side probe: signatureSeedNotActive's ACTIVE_SEED_MATCH_SQL, one boolean per match branch.
  if (/EXISTS \(SELECT 1 FROM external_product_seeds WHERE status = 'active'/.test(text)) {
    seedQueries.push({ sql: 'probe', params });
    if (probeFails) throw new Error('connection refused');
    const row = Object.fromEntries(MATCH_BRANCHES.map((name) => [name, false]));
    if (Array.isArray(params) && params[0] === LEGACY_OPEN) row.external_product_id = true;
    return { rows: [row] };
  }
  // The seed-DB detail lane.
  if (/FROM\s+external_product_seeds/i.test(text)) {
    seedQueries.push({ sql: text, params });
    if (Array.isArray(params) && params[0] === LEGACY_OPEN && /external_product_id\s*=\s*\$1/.test(text)) {
      return { rows: [SEED_ROW] };
    }
  }
  return { rows: [] };
}
require.cache[dbPath].exports = {
  ...realDb,
  query: fakeQuery,
  withClient: async (fn) => fn({ query: fakeQuery, release() {} }),
};

const supertest = require('supertest');
const nock = require('nock');
const {
  dropUnopenableLegacySeedRows,
  isLegacySeedIdFilterEnabled,
  isLegacySeedProductId,
  legacyRowDecision,
  projectLegacySeedRows,
  routesToLegacySeedLane,
} = require('../src/services/legacySeedIdServability');
const { finalizeInvokeSearchBody, installInvokeEgress, projectInvokeResponse } = require('../src/invokeEgress');
const app = require('../src/server');

test.after(() => {
  nock.cleanAll();
  process.env = { ...ORIGINAL_ENV };
});

// ---- rows, as search hands them back -----------------------------------------------------------------
const SHARED = 'external_seed';
// A legacy row whose seed is active: opens through the route. Shaped like a backend v2 search row, which
// carries no seed id, so the seed lane itself must be asked.
const ROUTED = {
  id: LEGACY_OPEN, product_id: LEGACY_OPEN, merchant_id: SHARED, title: 'Brand A barrier cream 50ml',
  destination_url: 'https://shop-a.example/products/barrier-cream',
};
// A legacy row that carries a signature: advertises the signature.
const WITH_SIG = {
  id: 'shop-b:00000000000000aa', product_id: 'shop-b:00000000000000aa', merchant_id: SHARED,
  pivota_signature_id: 'sig_00000000000000000000000000000001', external_seed_id: 'eps_2',
};
// A legacy row with no signature and no active seed: no lane can open it.
const DEAD = { product_id: 'shop-c-com:00000000000000bb', merchant_id: SHARED, title: 'Brand C mask' };
// What is never touched.
const SIG_ROW = { id: 'sig_00000000000000000000000000000002', product_id: 'sig_00000000000000000000000000000002', merchant_id: 'merch_obs_0000000000000001' };
const OBSERVED_LEGACY = { product_id: 'shop-d:00000000000000cc', merchant_id: 'merch_obs_0000000000000002' };
const EXT_ID = { product_id: 'ext_00000000000000000000aaaa', merchant_id: SHARED };
const EXT_COLON = { product_id: 'ext:00000000000000dd', merchant_id: SHARED };
const CONNECTED = { product_id: '9000000000001', merchant_id: 'merch_0000000000000003' };

test('the legacy id shape: <slug>:<16 hex>, and nothing else', () => {
  for (const id of [LEGACY_OPEN, 'shop-c-com:00000000000000bb', 'merchant:0123456789abcdef']) {
    assert.equal(isLegacySeedProductId(id), true, id);
  }
  for (const id of [
    'ext:0123456789abcdef', 'ext_0123456789abcdef', 'sig_0123456789abcdef',
    'shop-a:0123456789abcde', 'shop-a:0123456789abcdef0', 'shop-a:0123456789ABCDEF',
    'shop-a:0123456789abcdef::canonical', 'shop--a:0123456789abcdef', '-shop:0123456789abcdef',
    'brand-x', '', null,
  ]) {
    assert.equal(isLegacySeedProductId(id), false, String(id));
  }
});

test('get_product routes a legacy id to the seed lane only with the shared seller or none', () => {
  assert.equal(routesToLegacySeedLane(SHARED, LEGACY_OPEN), true);
  assert.equal(routesToLegacySeedLane('', LEGACY_OPEN), true);
  assert.equal(routesToLegacySeedLane(undefined, LEGACY_OPEN), true);
  assert.equal(routesToLegacySeedLane('merch_obs_0000000000000002', LEGACY_OPEN), false, 'observed sellers keep their lane');
  assert.equal(routesToLegacySeedLane('merch_0000000000000003', LEGACY_OPEN), false, 'a connected merchant keeps its lane');
  assert.equal(routesToLegacySeedLane(SHARED, 'ext_00000000000000000000aaaa'), false);
  assert.equal(routesToLegacySeedLane(SHARED, 'sig_00000000000000000000000000000001'), false);
});

test('each served row gets a decision: rekey (carries a sig), probe (ask the seed lane), or untouched', () => {
  assert.equal(legacyRowDecision(WITH_SIG), 'rekey');
  assert.equal(legacyRowDecision(ROUTED), 'probe');
  assert.equal(legacyRowDecision(DEAD), 'probe');
  assert.equal(legacyRowDecision({ merchantId: SHARED, productId: DEAD.product_id }), 'probe', 'camelCase aliases');
  for (const row of [SIG_ROW, OBSERVED_LEGACY, EXT_ID, EXT_COLON, CONNECTED, null, [ROUTED]]) {
    assert.equal(legacyRowDecision(row), null, JSON.stringify(row));
  }
});

test('sync projection: the sig is advertised, a kept legacy row gains a link, nothing is dropped', () => {
  const body = { status: 'success', total: 9, products: [SIG_ROW, ROUTED, WITH_SIG, DEAD, OBSERVED_LEGACY, EXT_ID, CONNECTED] };
  const before = JSON.stringify(body);
  const r = projectLegacySeedRows(body);
  assert.equal(JSON.stringify(body), before, 'the input is not mutated');
  assert.equal(r.rekeyedCount, 1);
  assert.equal(r.linkedCount, 1);
  assert.deepEqual(r.probeIds, [LEGACY_OPEN, DEAD.product_id]);
  const ids = r.body.products.map((p) => p.product_id);
  assert.deepEqual(ids, [SIG_ROW.product_id, LEGACY_OPEN, WITH_SIG.pivota_signature_id, DEAD.product_id, OBSERVED_LEGACY.product_id, EXT_ID.product_id, CONNECTED.product_id]);
  const rekeyed = r.body.products[2];
  assert.equal(rekeyed.id, WITH_SIG.pivota_signature_id, 'G-2: the id an agent echoes is the one that opens');
  assert.equal(rekeyed.external_product_id, WITH_SIG.product_id, 'the legacy id is kept beside it');
  assert.equal(r.body.products[1].url, ROUTED.destination_url, 'a kept legacy row with no link gets its page');
  assert.equal(r.body.total, 9, 'the sync half drops nothing');
});

test('a kept row that already has a link keeps it; nothing to do returns the same object', () => {
  const linked = { ...ROUTED, canonical_url: 'https://shop-a.example/p/1' };
  const body = { products: [linked, SIG_ROW] };
  assert.equal(projectLegacySeedRows(body).body, body);
  assert.equal(projectLegacySeedRows({ status: 'success' }).body.status, 'success');
  assert.equal(projectLegacySeedRows(null).body, null);
});

const answers = (dead) => async (pid) => dead.includes(pid);

test('async drop: only a row the database says has no active seed is dropped; total follows', async () => {
  const body = { total: 4, products: [ROUTED, DEAD, EXT_ID] };
  const r = await dropUnopenableLegacySeedRows(body, { noActiveSeed: answers([DEAD.product_id]), env: {} });
  assert.deepEqual(r.droppedIds, [DEAD.product_id]);
  assert.deepEqual(r.body.products.map((p) => p.product_id), [LEGACY_OPEN, EXT_ID.product_id]);
  assert.equal(r.body.total, 3);
  assert.equal(body.products.length, 3, 'the input is not mutated');
});

test('async drop fails OPEN: a probe that throws, times out or is missing keeps the row', async () => {
  const body = { products: [DEAD] };
  const thrown = await dropUnopenableLegacySeedRows(body, { noActiveSeed: async () => { throw new Error('db down'); }, env: {} });
  assert.equal(thrown.body, body);
  assert.equal(thrown.failedOpenCount, 1);
  const slow = await dropUnopenableLegacySeedRows(body, { noActiveSeed: () => new Promise((ok) => setTimeout(() => ok(true), 200)), env: {}, timeoutMs: 20 });
  assert.equal(slow.body, body, 'a slow answer is not an answer');
  assert.equal((await dropUnopenableLegacySeedRows(body, { env: {} })).body, body);
  assert.equal((await dropUnopenableLegacySeedRows(body, { noActiveSeed: async () => 'true', env: {} })).body, body, 'only a literal true drops');
});

test('the flag governs the drop ONLY; the sig rekey and the link always apply', async () => {
  const body = { products: [DEAD, WITH_SIG] };
  for (const off of ['0', 'false', 'off', 'no', 'FALSE']) {
    const r = await dropUnopenableLegacySeedRows(body, { noActiveSeed: answers([DEAD.product_id]), env: { SEARCH_DROP_LEGACY_SEED_IDS: off } });
    assert.equal(r.droppedIds.length, 0, off);
  }
  assert.equal(isLegacySeedIdFilterEnabled({}), true, 'default ON');
  assert.deepEqual(projectLegacySeedRows(body).body.products.map((p) => p.product_id), [DEAD.product_id, WITH_SIG.pivota_signature_id]);
});

test('the ok/data envelope is projected and dropped in place', async () => {
  const r = await dropUnopenableLegacySeedRows({ ok: true, data: { products: [DEAD, EXT_ID] } }, { noActiveSeed: answers([DEAD.product_id]), env: {} });
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.data.products.map((p) => p.product_id), [EXT_ID.product_id]);
});

test('G-1: the invoke egress projects search ops only, and finalize is null unless there is a row to ask about', () => {
  for (const operation of ['find_products_multi', 'find_products']) {
    const out = projectInvokeResponse({ products: [WITH_SIG] }, { operation });
    assert.deepEqual(out.products.map((p) => p.product_id), [WITH_SIG.pivota_signature_id], operation);
  }
  const body = { products: [DEAD], product: DEAD };
  for (const operation of ['get_product_detail', 'offers.resolve', 'find_similar_products', undefined]) {
    assert.equal(projectInvokeResponse(body, { operation }), body, String(operation));
    assert.equal(finalizeInvokeSearchBody(body, { operation }, { noActiveSeed: answers([DEAD.product_id]) }), null, String(operation));
  }
  assert.equal(finalizeInvokeSearchBody({ products: [EXT_ID, WITH_SIG] }, { operation: 'find_products_multi' }, { noActiveSeed: answers([]) }), null, 'no legacy row to ask about: sent synchronously');
});

function fakeRes() {
  const sent = [];
  return { sent, json(body) { sent.push(body); return this; }, status() { return this; }, setHeader() {} };
}

test('G-1: through installInvokeEgress, a search response is sent once the drop settles, and a failed finalize sends the projection', async () => {
  const res = fakeRes();
  installInvokeEgress(res, { operation: 'find_products_multi' }, {
    finalize: (b, c) => finalizeInvokeSearchBody(b, c, { noActiveSeed: answers([DEAD.product_id]), env: {} }),
  });
  assert.equal(res.json({ products: [ROUTED, DEAD, WITH_SIG] }), res, 'res.json still returns res');
  assert.equal(res.sent.length, 0, 'not sent before the probe answers');
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(res.sent.length, 1);
  assert.deepEqual(res.sent[0].products.map((p) => p.product_id), [LEGACY_OPEN, WITH_SIG.pivota_signature_id]);

  const res2 = fakeRes();
  installInvokeEgress(res2, { operation: 'find_products_multi' }, { finalize: () => Promise.reject(new Error('boom')) });
  res2.json({ products: [WITH_SIG] });
  await new Promise((ok) => setTimeout(ok, 10));
  assert.deepEqual(res2.sent[0].products.map((p) => p.product_id), [WITH_SIG.pivota_signature_id], 'the projected body, not nothing');

  const res3 = fakeRes();
  installInvokeEgress(res3, { operation: 'get_product_detail' }, { finalize: () => null });
  res3.json({ product: DEAD });
  assert.equal(res3.sent.length, 1, 'every other response is sent synchronously, as before');
});

// ---- end to end, through the real routing --------------------------------------------------------------

async function tokenFor() {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const pub = await exportJWK(publicKey);
  pub.kid = 'as-1';
  pub.alg = 'RS256';
  process.env.MCP_OAUTH_ISSUERS_JSON = JSON.stringify([{ iss: ISS, jwks: { keys: [pub] }, algs: ['RS256'] }]);
  require('../src/commerceMcpOAuth.js').__resetVerifierCache();
  return new SignJWT({ scope: 'pivota.checkout', token_type: 'access', client_id: 'mcpc_test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'as-1' })
    .setIssuer(ISS).setAudience(RESOURCE).setSubject('buyer-1').setIssuedAt().setExpirationTime('10m')
    .sign(privateKey);
}

// Any backend call for product detail is the OLD route (products_cache), which cannot open the id.
function backendDetailTrap() {
  const hits = [];
  nock(process.env.PIVOTA_API_BASE)
    .persist()
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'get_product_detail')
    .reply(function reply(_uri, body) {
      hits.push(body);
      return [404, { detail: 'PRODUCT_NOT_FOUND' }];
    });
  return hits;
}

async function mcpCall(token, name, args) {
  const res = await supertest(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  return res.body;
}

test('E2E /mcp: search serves the legacy row, and get_product on the echoed pair opens it', async () => {
  nock.cleanAll();
  const hits = backendDetailTrap();
  nock(process.env.SELF_INVOKE_BASE)
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
    .reply(200, { status: 'success', products: [ROUTED, WITH_SIG, DEAD] });
  const token = await tokenFor();

  const search = JSON.stringify(await mcpCall(token, 'search_catalog', { query: 'barrier cream placeholder e2e' }));
  assert.ok(search.includes(LEGACY_OPEN), `the routed legacy row is still served: ${search.slice(0, 600)}`);
  assert.ok(search.includes(WITH_SIG.pivota_signature_id), 'the signature row advertises its signature');
  assert.ok(!search.includes(DEAD.product_id), 'the row no lane can open is not served');

  seedQueries.length = 0;
  const detail = await mcpCall(token, 'get_product', { merchant_id: SHARED, product_id: LEGACY_OPEN });
  const text = JSON.stringify(detail);
  nock.cleanAll();
  assert.ok(!detail.result?.isError, `get_product must open the legacy id: ${text.slice(0, 600)}`);
  assert.ok(text.includes('Brand A barrier cream 50ml'), `the seed's product comes back: ${text.slice(0, 600)}`);
  assert.equal(hits.length, 0, 'the backend products_cache read is never asked');
  assert.ok(seedQueries.some((q) => q.params && q.params[0] === LEGACY_OPEN), 'the seed-DB lane answered it');
});

test('E2E /mcp: when the probe cannot reach the database, the row is served (fail open)', async () => {
  nock.cleanAll();
  nock(process.env.SELF_INVOKE_BASE)
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
    .reply(200, { status: 'success', products: [DEAD] });
  const token = await tokenFor();
  probeFails = true;
  try {
    const search = JSON.stringify(await mcpCall(token, 'search_catalog', { query: 'probe fails placeholder e2e' }));
    assert.ok(search.includes(DEAD.product_id), search.slice(0, 400));
  } finally {
    probeFails = false;
    nock.cleanAll();
  }
});

test('E2E /mcp: a legacy id the seed lane does not hold keeps the old route and its honest error', async () => {
  nock.cleanAll();
  const hits = backendDetailTrap();
  const token = await tokenFor();
  const detail = await mcpCall(token, 'get_product', { merchant_id: SHARED, product_id: DEAD.product_id });
  nock.cleanAll();
  assert.equal(detail.result?.isError, true, JSON.stringify(detail).slice(0, 400));
  assert.equal(hits.length, 1, 'no seed: the request falls through to the route it had before');
});

test('E2E direct invoke door: get_product_detail on a legacy id opens on the seed lane', async () => {
  nock.cleanAll();
  const hits = backendDetailTrap();
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH, (body) => body && body.api_key === AGENT_KEY)
    .reply(200, { valid: true, agent_id: 'agent_legacy_seed_test', is_active: true, auth_source: 'api_keys' });
  const res = await supertest(app)
    .post('/agent/shop/v1/invoke')
    .set('X-Agent-API-Key', AGENT_KEY)
    .send({ operation: 'get_product_detail', payload: { product: { merchant_id: SHARED, product_id: LEGACY_OPEN } } });
  nock.cleanAll();
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  assert.equal(res.body.product?.title, 'Brand A barrier cream 50ml');
  assert.equal(res.body.metadata?.legacy_seed_route, true);
  assert.equal(hits.length, 0, 'the backend products_cache read is never asked');
});
