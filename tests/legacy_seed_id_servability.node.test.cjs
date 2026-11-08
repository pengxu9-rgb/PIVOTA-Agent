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
// More seeds for the GD-3 gates: a quarantined source, an attached seed, and an SGD seed.
const LEGACY_QUARANTINED = 'shop-q:00000000000000e1';
const LEGACY_ATTACHED = 'shop-t:00000000000000e2';
const LEGACY_SGD = 'shop-s:00000000000000e3';
const QUARANTINED_DOMAINS = new Set(['shop-q.example']);
const seedFor = (id, overrides) => ({
  ...SEED_ROW,
  id: `eps_${id.replace(/[^a-z0-9]/g, '_')}`,
  external_product_id: id,
  destination_url: `https://${id.split(':')[0]}.example/products/item`,
  ...overrides,
});
const SEEDS = [
  SEED_ROW,
  seedFor(LEGACY_QUARANTINED, { domain: 'shop-q.example', title: 'Brand Q quarantined serum', price_amount: 31 }),
  seedFor(LEGACY_ATTACHED, { domain: 'shop-t.example', title: 'Brand T attached toner', attached_product_key: 'pk_attached_1' }),
  seedFor(LEGACY_SGD, {
    domain: 'shop-s.example',
    title: 'Brand S sunscreen 50ml',
    price_amount: 39,
    price_currency: 'SGD',
    seed_data: { brand: 'Brand S', title: 'Brand S sunscreen 50ml', snapshot: { price_currency: 'SGD' } },
  }),
];
// The seed's own currency, as seedSearchOfferScope.seedCurrencySql reads it (column, else the page read).
const seedCurrency = (r) => String(r.price_currency || r.seed_data?.snapshot?.price_currency || '').trim().toUpperCase();
const seedQueries = [];
const budgetedQueries = [];
process.env.DATABASE_URL = 'postgres://127.0.0.1:1/legacy_seed_stub';
const dbPath = require.resolve('../src/db/index.js');
const realDb = require('../src/db');
const MATCH_BRANCHES = ['external_product_id', 'seed_id', 'seed_data_external_product_id', 'seed_data_product_id', 'seed_snapshot_product_id'];
let probeFails = false;
async function fakeQuery(sql, params) {
  const text = String(sql || '');
  // The search-side probe: signatureSeedNotActive's ACTIVE_SEED_MATCH_SQL, one boolean per match branch.
  // Since review GD-2 it is ONE statement per page: $1 is the array of ids, one answer row per id.
  if (/EXISTS \(SELECT 1 FROM external_product_seeds WHERE status = 'active'/.test(text)) {
    seedQueries.push({ sql: 'probe', params });
    if (probeFails) throw new Error('connection refused');
    const ids = Array.isArray(params) && Array.isArray(params[0]) ? params[0] : [];
    return {
      rows: ids.map((id) => {
        const row = { product_id: id, ...Object.fromEntries(MATCH_BRANCHES.map((name) => [name, false])) };
        if (id === LEGACY_OPEN) row.external_product_id = true;
        return row;
      }),
    };
  }
  // The re-routed legacy read (review GD-3): its gates are emulated only when the statement carries them, so a
  // gate removed from the SQL lets the row through here exactly as it would in the database.
  if (/FROM\s+external_product_seeds/i.test(text) && Array.isArray(params) && params.length === 2) {
    seedQueries.push({ sql: text, params, gated: true });
    const [pid, currency] = params;
    const rows = SEEDS.filter((r) => r.status === 'active' && r.external_product_id === pid)
      .filter((r) => !/attached_product_key IS NULL/.test(text) || r.attached_product_key == null)
      .filter((r) => !/catalog_source_quarantine/.test(text) || !QUARANTINED_DOMAINS.has(String(r.domain).toLowerCase()))
      .filter((r) => !/END\) = \$2/.test(text) || seedCurrency(r) === currency);
    return { rows: rows.slice(0, 1) };
  }
  // The seed-DB detail lane.
  if (/FROM\s+external_product_seeds/i.test(text)) {
    seedQueries.push({ sql: text, params });
    // The ungated lookup answers any active seed by id: what the re-route used to serve as-is.
    const hit = Array.isArray(params) && /external_product_id\s*=\s*\$1/.test(text)
      ? SEEDS.find((r) => r.status === 'active' && r.external_product_id === params[0])
      : null;
    if (hit) return { rows: [hit] };
  }
  return { rows: [] };
}
require.cache[dbPath].exports = {
  ...realDb,
  query: fakeQuery,
  // The search-side probe runs under its deadline through queryWithBudget (review GD-2).
  queryWithBudget: (sql, params, options) => {
    budgetedQueries.push({ sql: String(sql || ''), options });
    return fakeQuery(sql, params);
  },
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
  LEGACY_SEED_DETAIL_MATCH_CLAUSE,
  isLegacySeedDetailServable,
  legacySeedDetailGate,
  __internal: legacySeedInternal,
} = require('../src/services/legacySeedIdServability');
const { seedCurrencySql } = require('../src/services/seedSearchOfferScope');
const { finalizeInvokeSearchBody, installInvokeEgress, projectInvokeResponse } = require('../src/invokeEgress');
const app = require('../src/server');

test.after(() => {
  nock.cleanAll();
  process.env = { ...ORIGINAL_ENV };
});
// The drop remembers the database's answers for a few seconds (review GD-2); each test starts with none.
test.beforeEach(() => legacySeedInternal.PROCESS_PROBE_CACHE.clear());

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
  const slow = await dropUnopenableLegacySeedRows(body, { noActiveSeed: () => new Promise((ok) => setTimeout(() => ok(true), 200)), env: {}, deadlineMs: 20 });
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

// ---- review GD-2 / GD-4 on the real routing -----------------------------------------------------------

test('GD-2 E2E /mcp: the whole page is asked about in ONE statement', async () => {
  nock.cleanAll();
  nock(process.env.SELF_INVOKE_BASE)
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
    .reply(200, { status: 'success', products: [ROUTED, WITH_SIG, DEAD] });
  const token = await tokenFor();
  seedQueries.length = 0;
  budgetedQueries.length = 0;
  const search = JSON.stringify(await mcpCall(token, 'search_catalog', { query: 'one statement placeholder e2e' }));
  nock.cleanAll();
  assert.ok(!search.includes(DEAD.product_id), search.slice(0, 400));
  const probes = seedQueries.filter((q) => q.sql === 'probe');
  assert.equal(probes.length, 1, 'one probe statement for the page');
  assert.deepEqual(probes[0].params, [[LEGACY_OPEN, DEAD.product_id]]);
  const budgeted = budgetedQueries.filter((q) => /FROM unnest\(\$1::text\[\]\)/.test(q.sql));
  assert.equal(budgeted.length, 1, 'the probe statement runs under a budget, so a hung one gives its connection back');
  assert.equal(budgeted[0].options && budgeted[0].options.timeoutMs, 250, 'the budget is the drop deadline');
});

test('GD-2 E2E /mcp: a page the loopback egress already probed is not probed again by the kernel', async () => {
  nock.cleanAll();
  nock(process.env.SELF_INVOKE_BASE)
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
    .reply(200, { status: 'success', products: [ROUTED, DEAD] }, { 'X-Pivota-Legacy-Seed-Probe': '1' });
  const token = await tokenFor();
  seedQueries.length = 0;
  const search = JSON.stringify(await mcpCall(token, 'search_catalog', { query: 'already probed placeholder e2e' }));
  nock.cleanAll();
  assert.equal(seedQueries.filter((q) => q.sql === 'probe').length, 0, 'the second pass is skipped');
  assert.ok(search.includes(DEAD.product_id), 'the loopback hop decided what this page holds');
});

test('GD-4: a re-keyed id already on the page is served once, the first one kept; nothing else is deduplicated', () => {
  const sig = WITH_SIG.pivota_signature_id;
  const observed = { id: sig, product_id: sig, merchant_id: 'merch_obs_0000000000000004', title: 'observed row' };
  const twinA = { product_id: 'brand-x', merchant_id: 'merch_0000000000000005' };
  const twinB = { product_id: 'brand-x', merchant_id: 'merch_0000000000000005', title: 'a pre-existing duplicate' };
  const first = projectLegacySeedRows({ total: 5, products: [observed, WITH_SIG, twinA, twinB, ROUTED] });
  assert.deepEqual(first.body.products.map((p) => p.title || p.product_id), ['observed row', 'brand-x', 'a pre-existing duplicate', ROUTED.title]);
  assert.equal(first.dedupedCount, 1);
  assert.equal(first.body.total, 4, 'total follows');
  const rekeyedFirst = projectLegacySeedRows({ products: [WITH_SIG, observed] });
  assert.deepEqual(rekeyedFirst.body.products.map((p) => p.merchant_id), [SHARED], 'the first of the two stays');
  const noRekey = { products: [twinA, twinB] };
  assert.equal(projectLegacySeedRows(noRekey).body, noRekey, 'a page with no re-key is the same object');
});

// ---- review GD-3: the re-route is held to a normal detail read's gates, for the buyer's market ----------

test('GD-3: the gate: one serving currency or no re-route; the built detail must be priced in it', () => {
  assert.equal(legacySeedDetailGate('SG').servingCurrency, 'SGD');
  assert.equal(legacySeedDetailGate(undefined).servingCurrency, 'USD', 'silence is the served default');
  for (const market of ['US,SG', 'en-US', 'XX']) assert.equal(legacySeedDetailGate(market), null, market);
  const sg = legacySeedDetailGate('SG');
  assert.equal(isLegacySeedDetailServable({ price: 39, currency: 'SGD' }, sg), true);
  assert.equal(isLegacySeedDetailServable({ price: 24, currency: 'USD' }, sg), false, 'another currency');
  assert.equal(isLegacySeedDetailServable({ title: 'no price' }, sg), true, 'no price quoted: nothing in a wrong currency');
  assert.equal(isLegacySeedDetailServable({ price: 39, currency: 'SGD', price_currency: 'USD' }, sg), false, 'every stated currency counts');
  assert.equal(isLegacySeedDetailServable({ price: 39 }, sg), false, 'a price with no currency is not served');
  assert.equal(isLegacySeedDetailServable({ price: 39, currency: 'SGD' }, null), false);
});

test('GD-3: the gated statement carries every gate, bound to the id and the buyer currency', () => {
  const clause = LEGACY_SEED_DETAIL_MATCH_CLAUSE;
  assert.match(clause, /^external_product_id = \$1\b/, 'the id\'s own row only');
  assert.ok(clause.includes('AND attached_product_key IS NULL'));
  assert.ok(clause.includes(`AND ${seedCurrencySql('external_product_seeds')} = $2`), 'the seed currency is the buyer\'s');
  assert.ok(clause.includes('catalog_source_quarantine') && clause.includes('lower(external_product_seeds.domain)'), 'the domain quarantine, table-qualified');
  assert.doesNotMatch(clause, /\$3/);
});

async function directDetail(product, extra = {}) {
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH, (body) => body && body.api_key === AGENT_KEY)
    .reply(200, { valid: true, agent_id: 'agent_legacy_seed_test', is_active: true, auth_source: 'api_keys' });
  return supertest(app)
    .post('/agent/shop/v1/invoke')
    .set('X-Agent-API-Key', AGENT_KEY)
    .send({ operation: 'get_product_detail', payload: { product, ...extra.payload }, ...(extra.metadata ? { metadata: extra.metadata } : {}) });
}

function refusedByTheSeedLane(text, hits, label) {
  assert.ok(!text.includes('"legacy_seed_route":true'), `${label}: not served by the re-route: ${text.slice(0, 400)}`);
  assert.equal(hits.length, 1, `${label}: the request keeps the route it had before`);
}

test('GD-3: a quarantined legacy id is not served with a price, on /mcp or the direct door', async () => {
  nock.cleanAll();
  let hits = backendDetailTrap();
  const token = await tokenFor();
  const detail = await mcpCall(token, 'get_product', { merchant_id: SHARED, product_id: LEGACY_QUARANTINED });
  const text = JSON.stringify(detail);
  nock.cleanAll();
  assert.equal(detail.result?.isError, true, text.slice(0, 400));
  assert.ok(!text.includes('Brand Q quarantined serum') && !text.includes('31'), `no quarantined title or price: ${text.slice(0, 400)}`);
  assert.equal(hits.length, 1);

  hits = backendDetailTrap();
  const res = await directDetail({ merchant_id: SHARED, product_id: LEGACY_QUARANTINED });
  const body = JSON.stringify(res.body);
  nock.cleanAll();
  assert.equal(res.body.product?.title, undefined, body.slice(0, 400));
  assert.ok(!body.includes('Brand Q quarantined serum'));
  refusedByTheSeedLane(body, hits, 'direct');
});

test('GD-3: a legacy seed attached to a catalog product is not re-routed', async () => {
  nock.cleanAll();
  const hits = backendDetailTrap();
  const res = await directDetail({ merchant_id: SHARED, product_id: LEGACY_ATTACHED });
  const body = JSON.stringify(res.body);
  nock.cleanAll();
  assert.ok(!body.includes('Brand T attached toner'), body.slice(0, 400));
  refusedByTheSeedLane(body, hits, 'attached');
});

// The commerce kernel's get_product_detail, with the market the MCP executor hands beside the payload
// (safety-kernel canonicalExecutor: `read(op, payload, { market })`). /mcp declares the `market` argument only
// while a live product read is on, so the kernel is driven directly here.
const kernelDetail = (productId, market) =>
  app._debug.invokeCommerceKernelRawUpstream(
    'get_product_detail',
    { product: { merchant_id: SHARED, product_id: productId } },
    {},
    market ? { market } : {},
  );

test('GD-3: an SG buyer never gets the USD seed through the re-route (kernel declared market, payload or metadata)', async () => {
  nock.cleanAll();
  let hits = backendDetailTrap();
  const kernel = await kernelDetail(LEGACY_OPEN, 'SG').then((r) => JSON.stringify(r), (err) => `threw:${err && err.message}`);
  nock.cleanAll();
  assert.ok(!kernel.includes('Brand A barrier cream 50ml'), `the USD seed is not served to SG: ${kernel.slice(0, 400)}`);
  refusedByTheSeedLane(kernel, hits, 'kernel, market SG');

  for (const extra of [{ payload: { market: 'SG' } }, { metadata: { market: 'SG' } }]) {
    hits = backendDetailTrap();
    const res = await directDetail({ merchant_id: SHARED, product_id: LEGACY_OPEN }, extra);
    const body = JSON.stringify(res.body);
    nock.cleanAll();
    assert.ok(!body.includes('Brand A barrier cream 50ml'), `${JSON.stringify(extra)}: ${body.slice(0, 400)}`);
    refusedByTheSeedLane(body, hits, JSON.stringify(extra));
  }

  hits = backendDetailTrap();
  const multi = await directDetail({ merchant_id: SHARED, product_id: LEGACY_OPEN }, { payload: { market: 'US,SG' } });
  nock.cleanAll();
  refusedByTheSeedLane(JSON.stringify(multi.body), hits, 'a market with no single currency');
});

test('GD-3: an SG buyer gets the SGD seed, in SGD; a US buyer does not', async () => {
  nock.cleanAll();
  let hits = backendDetailTrap();
  seedQueries.length = 0;
  const kernel = await kernelDetail(LEGACY_SGD, 'SG');
  nock.cleanAll();
  assert.equal(kernel.product?.title, 'Brand S sunscreen 50ml', JSON.stringify(kernel).slice(0, 400));
  assert.equal(String(kernel.product?.currency).toUpperCase(), 'SGD');
  assert.equal(kernel.metadata?.legacy_seed_route, true);
  assert.equal(hits.length, 0);
  assert.ok(seedQueries.some((q) => q.gated && q.params[0] === LEGACY_SGD && q.params[1] === 'SGD'), 'the read is bound to the buyer currency');

  hits = backendDetailTrap();
  const res = await directDetail({ merchant_id: SHARED, product_id: LEGACY_SGD }, { payload: { market: 'SG' } });
  nock.cleanAll();
  assert.equal(res.status, 200);
  assert.equal(res.body.product?.title, 'Brand S sunscreen 50ml');
  assert.equal(String(res.body.product?.currency).toUpperCase(), 'SGD');
  assert.equal(hits.length, 0);

  hits = backendDetailTrap();
  const us = await directDetail({ merchant_id: SHARED, product_id: LEGACY_SGD });
  nock.cleanAll();
  assert.ok(!JSON.stringify(us.body).includes('Brand S sunscreen 50ml'), 'silence is the US default: no SGD seed');
  refusedByTheSeedLane(JSON.stringify(us.body), hits, 'US buyer, SGD seed');

  hits = backendDetailTrap();
  const kernelUs = await kernelDetail(LEGACY_SGD).then((r) => JSON.stringify(r), (err) => `threw:${err && err.message}`);
  nock.cleanAll();
  assert.ok(!kernelUs.includes('Brand S sunscreen 50ml'), kernelUs.slice(0, 400));
  refusedByTheSeedLane(kernelUs, hits, 'kernel, no market');
});

test('GD-3: the normal US path is unchanged: a declared US buyer gets what silence gets', async () => {
  nock.cleanAll();
  backendDetailTrap();
  const silent = await directDetail({ merchant_id: SHARED, product_id: LEGACY_OPEN });
  const declared = await directDetail({ merchant_id: SHARED, product_id: LEGACY_OPEN }, { payload: { market: 'US' } });
  nock.cleanAll();
  assert.equal(silent.status, 200);
  assert.equal(silent.body.product?.title, 'Brand A barrier cream 50ml');
  assert.equal(String(silent.body.product?.currency).toUpperCase(), 'USD');
  const stable = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'generated_at' ? undefined : x)));
  assert.deepEqual(stable(declared.body), stable(silent.body));

  const kernelSilent = await kernelDetail(LEGACY_OPEN);
  const kernelUs = await kernelDetail(LEGACY_OPEN, 'US');
  assert.equal(kernelSilent.product?.title, 'Brand A barrier cream 50ml');
  assert.deepEqual(stable(kernelUs), stable(kernelSilent));
});

test('GD-4: the direct door answers a legacy id through its normal detail flow (include handling)', async () => {
  nock.cleanAll();
  const hits = backendDetailTrap();
  const res = await directDetail({ merchant_id: SHARED, product_id: LEGACY_OPEN }, { payload: { include: ['pdp'] } });
  nock.cleanAll();
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  assert.equal(res.body.product?.title, 'Brand A barrier cream 50ml');
  assert.equal(res.body.metadata?.legacy_seed_route, true);
  assert.equal(res.body.metadata?.legacy_pdp_include_disabled, true, 'include:[pdp] is handled like any detail read');
  assert.equal(hits.length, 0);
});

// Last in the file: it leaves detail cache entries behind. The shared seller's detail is not cached by default
// (TTL 0); with a TTL configured, a US answer must not be replayed to an SG buyer.
test('GD-3: with the detail cache on, a cached US answer is never replayed to an SG buyer', async () => {
  nock.cleanAll();
  process.env.PRODUCT_DETAIL_CACHE_TTL_MS_EXTERNAL_SEED = '60000';
  try {
    backendDetailTrap();
    const us = await directDetail({ merchant_id: SHARED, product_id: LEGACY_OPEN });
    assert.equal(us.body.product?.title, 'Brand A barrier cream 50ml');
    const usAgain = await directDetail({ merchant_id: SHARED, product_id: LEGACY_OPEN }, { payload: { options: { debug: true } } });
    nock.cleanAll();
    const hits = backendDetailTrap();
    const sg = await directDetail({ merchant_id: SHARED, product_id: LEGACY_OPEN }, { payload: { market: 'SG' } });
    nock.cleanAll();
    assert.ok(usAgain.body.product, 'the US answer is served');
    assert.ok(!JSON.stringify(sg.body).includes('Brand A barrier cream 50ml'), JSON.stringify(sg.body).slice(0, 400));
    refusedByTheSeedLane(JSON.stringify(sg.body), hits, 'SG after a cached US answer');
  } finally {
    delete process.env.PRODUCT_DETAIL_CACHE_TTL_MS_EXTERNAL_SEED;
    nock.cleanAll();
  }
});
