// The loopback-only network guard goes first, so nothing below can reach a real host.
require('../agent_readiness_eval/_net_guard.cjs');

const nock = require('nock');
const request = require('supertest');
const { createRetinoidFixtureQuery } = require('../fixtures/retinoid_explicit_query_catalog.cjs');

// Real retinoids, through the real /agent/shop/v1/invoke route, under the request and product shapes
// a safety review found released when the context reader was relaxed (only user turns read, a flag
// gating only by its name, household words skipped) or the product's raw text was re-ordered and
// HTML-stripped. Every case here must keep the retinoid out.
//
// Two lanes:
// - the beauty discovery lane (metadata.source "search"): rows come from a jest mock of
//   src/services/discoveryFeed and the retinoid safety net is the only retinoid rule on them;
// - the beauty gate lanes, over the explicit-query fixture catalog.
// Each lane first proves it serves the retinoid with no signal, so a hidden result is the rule's.

const UPSTREAM = 'http://pivota-upstream.invalid';
const ENV_KEYS = [
  'PIVOTA_API_BASE', 'PIVOTA_API_KEY', 'API_MODE', 'DATABASE_URL', 'FIND_PRODUCTS_MULTI_VECTOR_ENABLED',
  'AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED', 'GATEWAY_RATE_LIMIT_ENABLED', 'BEAUTY_RETINOID_SOFT_SAFETY_TIER',
];
jest.setTimeout(120000);

const BASE_ROW = {
  merchant_id: 'merch_seam_fixture', product_type: 'Serum', status: 'published', inventory_quantity: 5, price: 30, currency: 'USD',
  image_url: 'https://fixture-cdn.invalid/strict.jpg',
};
const RETINOL_ROW = { ...BASE_ROW, id: 'strict_retinol', product_id: 'strict_retinol', title: 'Retinol Night Serum', description: 'Night serum with retinol.' };
const PLAIN_ROW = { ...BASE_ROW, id: 'strict_plain', product_id: 'strict_plain', title: 'Hyaluronic Hydrating Serum', description: 'Hydrating serum.' };
const manyVariants = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `v${i}`, title: `Shade ${i}`, sku: `SKU-${i}`, option1: `Shade ${i}`, option2: '30 ml', barcode: `0000${i}` }));
// Products that name their retinoid only in a script the search texts drop, behind enough variants or
// tags (80 six-field variants) to fill a 400-part text budget before the ingredients are reached.
const PRODUCT_CASES = [
  ['korean ingredients, 80 variants', { title: 'Glow Cushion Foundation SPF 50', description: 'Cushion foundation.', ingredients: '정제수, 사이클로펜타실록세인, 레티놀, 글리세린', variants: manyVariants(80) }],
  ['russian ingredients, 100 tags, 80 variants', { title: 'Night Serum C', description: 'Night serum.', ingredients: 'вода, глицерин, ретинол', tags: Array.from({ length: 100 }, (_, i) => `tag-${i}`), variants: manyVariants(80) }],
  ['thai inci, 80 variants', { title: 'Night Serum D', description: 'Night serum.', inci: 'น้ำ, เรตินอล', variants: manyVariants(80) }],
  ['korean name between "<" and ">" in prose', { title: 'Night Serum E', description: 'Gentle pH <5.5 formula with 레티놀 0.1% for skin aged >25.' }],
  // what the wider reading adds: a stand-in title with a real retinoid in its actives, a name split
  // by an inline tag, a name only in a variant's option value
  ['stand-in title, a real retinoid in actives', { title: 'Bakuchiol Retinol Alternative Serum', description: 'Night serum.', actives: ['retinal'] }],
  ['retinol split by an inline tag', { title: 'Night Serum F', description: 'Night serum with re<span>tinol</span> for smoother skin.' }],
  ['retinol only in a variant option', { title: 'Night Serum G', description: 'Night serum.', variants: [{ id: 'v1', sku: 'S1', option1: 'Retinol 0.3%' }] }],
  // a stand-in title, and a real retinoid named in a structured field right after one whose text
  // could join a stand-in phrase across the field boundary ("... 0%" + "Retinol", "without" + "Retinol")
  ['stand-in title; actives "0%" then a retinoid in key ingredients', { title: 'Retinol Alternative Night Cream', description: 'Night cream.', actives: ['Fragrance 0%'], key_ingredients: ['Retinol 0.1%', 'Bakuchiol'] }],
  ['stand-in title; actives "without" then a retinoid in key ingredients', { title: 'Retinol Alternative Night Cream', description: 'Night cream.', actives: ['Parabens: without'], key_ingredients: ['Retinol'] }],
  ['stand-in title; a retinoid in active ingredients, then actives "Alternatives: ..."', { title: 'Bakuchiol Retinol Alternative Serum', description: 'Night serum.', active_ingredients: 'Bakuchiol, Retinol', actives: 'Alternatives: rosehip oil' }],
  ['stand-in title; active ingredients "0%" then a retinoid in key ingredients', { title: 'Retinol Alternative Night Cream', description: 'Night cream.', active_ingredients: ['Fragrance 0%'], key_ingredients: ['Retinol 0.1%'] }],
].map(([label, fields], i) => [label, { ...BASE_ROW, id: `strict_p${i}`, product_id: `strict_p${i}`, ...fields }]);

const turn = (role, content) => ({ role, content });
// Request shapes that carry a hard safety signal (pregnancy, a child, a prescription retinoid).
const SIGNALLED = [
  ['pregnancy in a tool turn', { messages: [turn('tool', '{"user_profile":{"pregnant":true,"trimester":2}}'), turn('user', 'serum')] }],
  ['breastfeeding in a function turn', { messages: [turn('function', 'profile lookup: breastfeeding'), turn('user', 'serum')] }],
  ['pregnancy in a developer turn', { messages: [turn('developer', 'Known user facts: pregnant, second trimester.'), turn('user', 'serum')] }],
  ['pregnancy in an assistant turn', { messages: [turn('assistant', 'Summary so far: the user is pregnant.'), turn('user', 'serum')] }],
  ['pregnancy in an assistant turn, Spanish', { messages: [turn('assistant', 'Entendido, estás embarazada.'), turn('user', 'serum')] }],
  ['pregnancy in an agent turn', { messages: [{ role: 'agent', content: 'Customer said she is pregnant.' }, turn('user', 'serum')] }],
  ['isotretinoin in a tool turn', { messages: [turn('tool', 'medications: isotretinoin 20mg'), turn('user', 'serum')] }],
  ['a child in a tool turn, Korean', { messages: [turn('tool', '구매 대상: 아기'), turn('user', 'serum')] }],
  ['flag under_18', null, { safety_flags: { under_18: true } }],
  ['flag pediatric', null, { safety_flags: { pediatric: true } }],
  ['flag underage', null, { safety_flags: ['underage'] }],
  ['flag high_risk', null, { safety_flags: { high_risk: true } }],
  ['"I have 2 kids, ... for them"', { messages: [turn('user', 'I have 2 kids, looking for a retinol serum for them')] }],
  ['"we have three little kids and they want to try retinol"', { messages: [turn('user', 'we have three little kids and they want to try retinol')] }],
  ['profile family.pregnant', { user_profile: { family: { pregnant: true } } }],
  ['profile family_status pregnant', { user_profile: { family_status: 'pregnant' } }],
  ['profile family_planning trying to conceive', { user_profile: { family_planning: 'trying to conceive' } }],
  ['profile household shopping for an 8 year old', { user_profile: { household: 'shopping for my 8 year old' } }],
  ['profile pregnancy_status "not pregnant, breastfeeding"', { user_profile: { pregnancy_status: 'not pregnant, breastfeeding' } }],
  ['nested conversation, pregnancy in a tool turn', { conversation: { messages: [turn('tool', 'pregnant: yes'), turn('user', 'serum')] } }],
  // fields and shapes read on the request side
  ['pregnancy in Gemini contents parts', { contents: [{ role: 'user', parts: [{ text: 'I am 20 weeks pregnant' }] }] }],
  ['breastfeeding in a string input', { input: 'serum while breastfeeding' }],
  ['a child by birth year', { user_profile: { birth_year: new Date().getUTCFullYear() - 8 } }],
  ['a prescription retinoid in medications', { user_profile: { medications: ['Differin'] } }],
  ['pregnancy in payload filters', { filters: { life_stage: 'pregnancy' } }],
  ['pregnancy in a metadata safety object', null, { safety: { pregnant: true } }],
  ['a child in search.context turns', null, null, { context: { messages: [turn('user', 'for my toddler')] } }],
  ['age group "child"', { user_profile: { age_group: 'child' } }],
  ['pregnancy in a turn carried as parts', { messages: [{ role: 'user', parts: [{ text: 'I am pregnant' }] }, turn('user', 'serum')] }],
  ['pregnancy in a recent-query object', { recent_queries: [{ query: 'pregnancy safe moisturizer' }] }],
  ['Thai "retinal" in an avoid list', { avoid_ingredients: ['เรตินัล'] }],
  // every row is [label, payload, metadata, searchExtra]: test.each passes a callback for a missing column
].map(([label, payload = null, metadata = null, searchExtra = null]) => [label, payload, metadata, searchExtra]);

// Neutral answers stay neutral, as before: the retinoid is still served.
const NEUTRAL = [
  ['pregnancy_status "N/A"', { user_profile: { pregnancy_status: 'N/A' } }],
  ['pregnancy_status "n/a"', { user_profile: { pregnancy_status: 'n/a' } }],
  ['safety_flags "n/a"', null, { safety_flags: 'n/a' }],
  ['safety_flags { pregnant: "n/a" }', null, { safety_flags: { pregnant: 'n/a' } }],
  ['pregnancy_status "not applicable"', { user_profile: { pregnancy_status: 'not applicable' } }],
].map(([label, payload = null, metadata = null]) => [label, payload, metadata]);

let savedEnv;
let upstreamRows = [];
beforeAll(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  nock.disableNetConnect();
  nock.enableNetConnect((host) => /^(127\.0\.0\.1|\[?::1\]?)(:\d+)?$/.test(String(host || '')));
  Object.assign(process.env, {
    PIVOTA_API_BASE: UPSTREAM, PIVOTA_API_KEY: 'test_key', API_MODE: 'REAL', DATABASE_URL: 'postgres://fixture-db.invalid/test',
    FIND_PRODUCTS_MULTI_VECTOR_ENABLED: 'false', AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false', GATEWAY_RATE_LIMIT_ENABLED: 'false',
  });
  delete process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER;
  const upstreamBody = () => ({ status: 'success', success: true, products: upstreamRows.map((r) => JSON.parse(JSON.stringify(r))), total: upstreamRows.length });
  nock(UPSTREAM).persist().get(/.*/).reply(200, upstreamBody);
  nock(UPSTREAM).persist().post(/.*/).reply(200, upstreamBody);
});
afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  jest.dontMock('../../src/db');
  jest.dontMock('../../src/services/discoveryFeed');
});

function loadDiscoveryLane(rows) {
  jest.resetModules();
  jest.doMock('../../src/db', () => ({
    query: async (sql) => (String(sql).includes('COUNT(*)::int AS total') ? { rows: [{ total: 0 }] } : { rows: [] }),
  }));
  jest.doMock('../../src/services/discoveryFeed', () => {
    const actual = jest.requireActual('../../src/services/discoveryFeed');
    return {
      ...actual,
      getDiscoveryFeed: jest.fn(async () => ({
        products: rows.map((r) => JSON.parse(JSON.stringify(r))), total: rows.length, metadata: { candidate_source: 'seam_lane' },
      })),
    };
  });
  return require('../../src/server');
}
function loadGateLanes() {
  jest.resetModules();
  jest.dontMock('../../src/services/discoveryFeed');
  jest.doMock('../../src/db', () => ({ query: createRetinoidFixtureQuery() }));
  return require('../../src/server');
}

async function invoke(app, { operation = 'find_products_multi', query, payload = {}, metadata = {}, searchExtra = {} }) {
  const body = { operation, payload: { ...payload, search: { query, page: 1, limit: 12, in_stock_only: true, ...(searchExtra || {}) }, query }, metadata };
  const resp = await request(app).post('/agent/shop/v1/invoke').send(body);
  expect(resp.status).toBe(200);
  return resp;
}
async function servedIds(app, args) {
  const resp = await invoke(app, args);
  return (resp.body.products || []).map((p) => String(p.product_id || p.id));
}

describe('discovery lane: the safety net hides the retinoid', () => {
  let app;
  beforeAll(() => {
    app = loadDiscoveryLane([RETINOL_ROW, PLAIN_ROW]);
  });
  test('control: with no signal the retinoid is served', async () => {
    expect(await servedIds(app, { query: 'serum', metadata: { source: 'search' } })).toContain(RETINOL_ROW.id);
  });
  test.each(SIGNALLED)('%s', async (_label, payload, metadata, searchExtra) => {
    const ids = await servedIds(app, { query: 'serum', payload: payload || {}, metadata: { source: 'search', ...(metadata || {}) }, searchExtra });
    expect(ids).not.toContain(RETINOL_ROW.id);
    expect(ids).toContain(PLAIN_ROW.id);
  });
  test.each(NEUTRAL)('neutral: %s', async (_label, payload, metadata) => {
    const ids = await servedIds(app, { query: 'serum', payload: payload || {}, metadata: { source: 'search', ...(metadata || {}) } });
    expect(ids).toContain(RETINOL_ROW.id);
  });
});

describe('discovery lane: a product whose text is a flood of unterminated HTML comments', () => {
  test('a signalled request over it answers promptly', async () => {
    // no retinoid in it, so both product readings run in full
    const flood = { ...BASE_ROW, id: 'strict_flood', product_id: 'strict_flood', title: 'Night Serum H', description: 'Night serum.', ingredients: 'water, glycerin', tags: Array.from({ length: 20 }, () => '<!--'.repeat(5000)) };
    const app = loadDiscoveryLane([flood, PLAIN_ROW]);
    await servedIds(app, { query: 'serum', metadata: { source: 'search' } }); // warm
    const started = Date.now();
    const ids = await servedIds(app, { query: 'serum', payload: { user_profile: { pregnancy_status: 'pregnant' } }, metadata: { source: 'search' } });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(ids).toContain(flood.id);
  });
});

describe('find_products: the net also drops every card that points at a removed product', () => {
  const KO_ROW = { ...BASE_ROW, id: 'strict_fp_ko', product_id: 'strict_fp_ko', title: 'Premium Night Serum', description: 'Night serum.', ingredients: '정제수, 글리세린, 레티놀, 나이아신아마이드' };
  let app;
  beforeAll(() => {
    upstreamRows = [KO_ROW, PLAIN_ROW];
    app = loadDiscoveryLane([KO_ROW, PLAIN_ROW]);
  });
  afterAll(() => {
    upstreamRows = [];
  });
  test('control: with no signal the product is served', async () => {
    const resp = await invoke(app, { operation: 'find_products', query: 'serum', metadata: { source: 'search' } });
    expect(JSON.stringify(resp.body)).toContain(KO_ROW.id);
  });
  test('with a pregnancy profile the product is in no list and no card anywhere in the body', async () => {
    const resp = await invoke(app, { operation: 'find_products', query: 'serum', payload: { user_profile: { pregnancy_status: 'pregnant' } }, metadata: { source: 'search' } });
    expect(JSON.stringify(resp.body)).not.toContain(KO_ROW.id);
    expect(JSON.stringify(resp.body)).not.toContain(KO_ROW.title);
    expect((resp.body.products || []).map((p) => String(p.product_id || p.id))).toContain(PLAIN_ROW.id);
  });
});

describe('discovery lane: a product naming its retinoid only in a non-Latin script or in prose with "<" ... ">"', () => {
  test.each(PRODUCT_CASES)('%s', async (_label, row) => {
    const app = loadDiscoveryLane([row, PLAIN_ROW]);
    expect(await servedIds(app, { query: 'serum', metadata: { source: 'search' } })).toContain(row.id);
    const ids = await servedIds(app, { query: 'serum', payload: { user_profile: { pregnancy_status: 'pregnant' } }, metadata: { source: 'search' } });
    expect(ids).not.toContain(row.id);
    expect(ids).toContain(PLAIN_ROW.id);
  });
});

describe('beauty gate lanes: retinol serum', () => {
  let app;
  const retinoidIdsIn = (ids) => ids.filter((id) => /ret|adap|tret|granactive/.test(id));
  beforeAll(() => {
    app = loadGateLanes();
  });
  test('control: with no signal retinoids are served', async () => {
    const ids = await servedIds(app, { query: 'retinol serum', metadata: { source: 'beauty_cross_agent_batch', market: 'US' } });
    expect(retinoidIdsIn(ids).length).toBeGreaterThan(0);
  });
  test.each(SIGNALLED)('%s', async (_label, payload, metadata, searchExtra) => {
    const p = JSON.parse(JSON.stringify(payload || {}));
    for (const list of [p.messages, p.conversation && p.conversation.messages]) {
      if (Array.isArray(list)) for (const m of list) if (m.role === 'user' && m.content === 'serum') m.content = 'retinol serum';
    }
    const sx = JSON.parse(JSON.stringify(searchExtra || {}));
    for (const m of (sx.context && sx.context.messages) || []) if (m.role === 'user' && m.content === 'serum') m.content = 'retinol serum';
    const ids = await servedIds(app, { query: 'retinol serum', payload: p, metadata: { source: 'beauty_cross_agent_batch', market: 'US', ...(metadata || {}) }, searchExtra: sx });
    expect(retinoidIdsIn(ids)).toEqual([]);
  });
  test.each(NEUTRAL)('neutral: %s', async (_label, payload, metadata) => {
    const ids = await servedIds(app, { query: 'retinol serum', payload: payload || {}, metadata: { source: 'beauty_cross_agent_batch', market: 'US', ...(metadata || {}) } });
    expect(retinoidIdsIn(ids).length).toBeGreaterThan(0);
  });
});
