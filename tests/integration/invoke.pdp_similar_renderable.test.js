const { once } = require('events');
const nock = require('nock');

function hasRuntimeDeps() {
  for (const dep of ['dotenv', 'express', 'axios']) {
    try {
      require.resolve(dep);
    } catch {
      return false;
    }
  }
  return true;
}

const describeIfRuntimeDeps = hasRuntimeDeps() ? describe : describe.skip;

const API_BASE = 'http://localhost:8080';
const MERCHANT_ID = 'merch_208139f7600dbf42';
const PRODUCT_ID = 'BOTTLE_001';

const ENV_KEYS = [
  'API_MODE',
  'PIVOTA_API_BASE',
  'PIVOTA_API_KEY',
  'DATABASE_URL',
  'PGHOST',
  'AGENT_AUTH_INTROSPECT_URL',
  'AGENT_AUTH_INTROSPECT_INTERNAL_KEY',
  'AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED',
  'PDP_PRODUCT_GROUP_SUBJECT_VIA_SIGNATURE_ENABLED',
];
let dbCalls = [];
let previousEnv = null;
let recommendCalls = [];

function buildBottleProduct() {
  return {
    merchant_id: MERCHANT_ID,
    product_id: PRODUCT_ID,
    id: PRODUCT_ID,
    title: 'Insulated Water Bottle',
    brand: 'Pivota Test',
    currency: 'USD',
    price: { amount: 19, currency: 'USD' },
    platform: 'shopify',
    platform_product_id: PRODUCT_ID,
    in_stock: true,
  };
}

// The server hard-ignores API_MODE=MOCK now ("Ignoring disabled API_MODE=MOCK
// runtime mode") and always runs REAL, so this suite runs REAL mode with the
// upstream nocked. Product detail is fetched via POST /agent/shop/v1/invoke
// with operation get_product_detail (fetchProductDetailFromUpstream); all
// other upstream lookups (group resolve, reviews, legacy detail) get 404s.
// DATABASE_URL/PGHOST are cleared so the get_pdp_v2 serving-eligibility gate
// does not fail closed for this non-external-seed merchant.
// get_pdp_v2 runs the same visible-id step as find_similar_products, so a relationship-graph card
// whose product page will not render (no row passing source, route and serving gate) is withheld
// from the PDP similar module too.
const DEAD_SIG = 'sig_0000000000000000000000000000dead';
const LIVE_SIG = 'sig_00000000000000000000000000000a11';
// pg_ family cards render through the signature their group resolves to (get_pdp_v2's product_group
// subject lane): a group resolving to a dead sig, a group with no signed active member, and a group
// resolving to a live sig.
const GROUP_LIVE_SIG = 'sig_00000000000000000000000000000b22';
const PG_DEAD = 'pg_catalog_00000000000dead';
const PG_EMPTY = 'pg_catalog_0000000000empty';
const PG_LIVE = 'pg_catalog_00000000000a11';
function groupMemberRow(groupId, sig) {
  return { requested_group_id: groupId, product_key: `pk_${groupId}`, merchant_id: 'merch_obs_x', platform: 'external_seed',
    source_product_id: `ext_${groupId}`, pdp_lifecycle_stage: 'published', pivota_signature_id: sig, pivota_signature_minted_at: null,
    content_key: null, internal_product_group_id: groupId, is_primary: true, member_rank: 1 };
}
function gateRow(sig, overrides = {}) {
  return { pivota_signature_id: sig, merchant_id: 'merch_obs_x', platform: 'external_seed', source_system: 'external_product_seeds_mirror_v1',
    source_product_id: 'ext_x', sync_status: 'live', pdp_lifecycle_stage: 'published', source_active: true, pdp_seed_route_ok: true,
    serving_eligible: true, blocker_code: null, blocker_detail: null, content_quality_score: 90,
    active_external_seed_source_match: true, mirror_seed_inactive: false, ...overrides };
}
function graphCard(sig, edgeId) {
  return { product_id: sig, pivota_signature_id: sig, title: `Steel Bottle ${edgeId}`, image_url: 'https://cdn.example.test/b.jpg',
    card_highlight: 'Insulated steel', price: 21, currency: 'USD', source: 'relationship_graph', recommendation_source: 'relationship_graph',
    relationship_edge_id: edgeId, relationship_type: 'competitive_alternative' };
}

async function startServer({ groupBatch = 'ok', groupSubjectViaSignature = true } = {}) {
  jest.resetModules();
  nock.cleanAll();
  dbCalls = [];
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.API_MODE = 'REAL';
  process.env.PIVOTA_API_BASE = API_BASE;
  process.env.PIVOTA_API_KEY =
    'ak_live_0000000000000000000000000000000000000000000000000000000000000000';
  process.env.AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED = 'true';
  process.env.PDP_PRODUCT_GROUP_SUBJECT_VIA_SIGNATURE_ENABLED = groupSubjectViaSignature ? 'true' : 'false';
  process.env.DATABASE_URL = 'postgres://offline-fixture';
  delete process.env.PGHOST;
  delete process.env.AGENT_AUTH_INTROSPECT_URL;
  delete process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY;

  nock(API_BASE)
    .persist()
    .post('/agent/shop/v1/invoke', (body) => body?.operation === 'get_product_detail')
    .reply(200, { status: 'success', product: buildBottleProduct() });
  nock(API_BASE).persist().get(/.*/).reply(404, { error: 'NOT_FOUND' });
  nock(API_BASE).persist().post(/.*/).reply(404, { error: 'NOT_FOUND' });

  const actualDb = jest.requireActual('../../src/db');
  jest.doMock('../../src/db', () => ({
    ...actualDb,
    query: jest.fn(async (sql, params = []) => {
      const text = String(sql);
      dbCalls.push(text);
      if (text.includes('product_group_subject_signature_batch')) {
        if (groupBatch === 'throw') throw new Error('statement timeout');
        return { rows: [groupMemberRow(PG_DEAD, DEAD_SIG), groupMemberRow(PG_LIVE, GROUP_LIVE_SIG)] };
      }
      if (text.includes('similar_relationship_graph_renderability')) {
        const asked = new Set(params[0] || []);
        return { rows: [gateRow(DEAD_SIG, { serving_eligible: false, blocker_code: 'no_us_offer' }), gateRow(LIVE_SIG), gateRow(GROUP_LIVE_SIG)]
          .filter((row) => asked.has(row.pivota_signature_id)) };
      }
      // The PDP's own serving gate for the base product: eligible.
      if (text.includes('ips.serving_eligible') && text.includes('LIMIT 1')) {
        return { rows: [{ content_key: 'ck_bottle', product_key: 'pk_bottle', pivota_signature_id: null, sync_status: 'live',
          pdp_lifecycle_stage: 'published', serving_eligible: true, readiness_tier: 'ready', blocker_code: null }] };
      }
      return { rows: [] };
    }),
  }));
  const actualRecommendationEngine = jest.requireActual('../../src/services/RecommendationEngine');
  jest.doMock('../../src/services/RecommendationEngine', () => ({
    ...actualRecommendationEngine,
    recommend: jest.fn(async () => ({ items: [], metadata: { similar_status: 'empty' } })),
  }));
  const actualRecall = jest.requireActual('../../src/services/relationshipGraphRecall');
  jest.doMock('../../src/services/relationshipGraphRecall', () => ({
    ...actualRecall,
    fetchRelationshipGraphRecallForAnchor: jest.fn(async () => ({
      edges: [],
      items: [
        graphCard(DEAD_SIG, 'prel_dead'),
        graphCard(LIVE_SIG, 'prel_live'),
        graphCard(PG_DEAD, 'prel_pg_dead'),
        graphCard(PG_EMPTY, 'prel_pg_empty'),
        graphCard(PG_LIVE, 'prel_pg_live'),
      ],
      metadata: { enabled: true, edge_count: 5, item_count: 5, read_status: 'ready', read_reason: null },
    })),
  }));
  const app = require('../../src/server');
  const server = app.listen(0);
  await once(server, 'listening');
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer(server) {
  if (server) await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  nock.cleanAll();
  for (const [key, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv = null;
  jest.resetModules();
  jest.dontMock('../../src/db');
  jest.dontMock('../../src/services/RecommendationEngine');
  jest.dontMock('../../src/services/relationshipGraphRecall');
}

async function fetchSimilar(baseUrl) {
  const response = await fetch(`${baseUrl}/agent/shop/v1/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operation: 'get_pdp_v2',
      payload: { product: { merchant_id: MERCHANT_ID, product_id: PRODUCT_ID }, include: ['similar'] },
    }),
  });
  const body = await response.json();
  expect(response.status).toBe(200);
  const similar = body.modules.find((module) => module?.type === 'similar');
  return {
    ids: (similar?.data?.items || []).map((item) => item.relationship_edge_id).filter(Boolean).sort(),
    withheld: similar?.data?.metadata?.relationship_graph_not_renderable_withheld_count,
  };
}

describeIfRuntimeDeps('get_pdp_v2 similar withholds graph cards whose product page will not render', () => {
  test('dead sig_ and pg_ cards are absent and counted; the renderable ones are served', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const { ids, withheld } = await fetchSimilar(baseUrl);
      expect(ids).toEqual(['prel_live', 'prel_pg_live']);
      expect(withheld).toBe(3);
      expect(dbCalls.some((sql) => sql.includes('similar_relationship_graph_renderability'))).toBe(true);
      expect(dbCalls.filter((sql) => sql.includes('product_group_subject_signature_batch'))).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  });

  test('a failed pg_ subject read keeps every pg_ card and still withholds the dead sig_ card', async () => {
    const { server, baseUrl } = await startServer({ groupBatch: 'throw' });
    try {
      const { ids, withheld } = await fetchSimilar(baseUrl);
      expect(ids).toEqual(['prel_live', 'prel_pg_dead', 'prel_pg_empty', 'prel_pg_live']);
      expect(withheld).toBe(1);
    } finally {
      await stopServer(server);
    }
  });

  test('with the pg_ subject-via-signature lane off, pg_ cards are left to the group lane', async () => {
    const { server, baseUrl } = await startServer({ groupSubjectViaSignature: false });
    try {
      const { ids, withheld } = await fetchSimilar(baseUrl);
      expect(ids).toEqual(['prel_live', 'prel_pg_dead', 'prel_pg_empty', 'prel_pg_live']);
      expect(withheld).toBe(1);
      expect(dbCalls.some((sql) => sql.includes('product_group_subject_signature_batch'))).toBe(false);
    } finally {
      await stopServer(server);
    }
  });
});
