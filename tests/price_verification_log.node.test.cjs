'use strict';

// src/observability/priceVerificationLog.js + priceVerificationFacts.js, and the log-only HTTP status on the
// UCP live readers' failures. Pure units; the doors themselves are pinned by
// tests/price_verification_log_golden.node.test.cjs. No network: the readers get a fake UCP client.

const test = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_FLAG = process.env.PRICE_VERIFICATION_LOG;
const facts = require('../src/observability/priceVerificationFacts');
const pv = require('../src/observability/priceVerificationLog');
const { createUcpLiveOfferReader, createUcpLiveProductReader } = require('../src/services/ucpLiveOfferRead');

const on = () => { process.env.PRICE_VERIFICATION_LOG = 'on'; };
const off = () => { delete process.env.PRICE_VERIFICATION_LOG; };
test.afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.PRICE_VERIFICATION_LOG;
  else process.env.PRICE_VERIFICATION_LOG = ORIGINAL_FLAG;
});

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60 * 1000;

function sink() {
  const lines = [];
  return { lines, info: (obj, msg) => lines.push({ ...obj, msg }) };
}

function loopbackReq(header, { xff } = {}) {
  return {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { ...(header ? { 'x-pivota-price-context': header } : {}), ...(xff ? { 'x-forwarded-for': xff } : {}) },
  };
}

test('flag off: nothing is computed, labelled, sent or wrapped', async () => {
  off();
  assert.equal(facts.priceVerificationLogEnabled(), false);
  assert.equal(facts.priceFactsOf('search_catalog', { products: [{ price: 1 }] }), null);
  assert.equal(pv.createMcpPriceCapture(), null);
  const p = Promise.resolve(7);
  await pv.runWithPriceContext({ door: 'mcp' }, async () => {
    assert.deepEqual(pv.priceContextLogFields(), {});
    assert.deepEqual(pv.priceContextHeaders(), {});
    assert.equal(pv.trackLiveWork(p), p, 'the same promise object, not a wrapper');
    assert.equal(pv.trackSearchOverlay(p), p);
    assert.equal(pv.mcpPriceCapture(), null);
  });
  let ranInside = null;
  pv.runWithPriceDoor({ headers: {} }, 'mcp', () => { ranInside = pv.currentPriceContext(); });
  assert.equal(ranInside, null, 'off: the door opens no context');
  const s = sink();
  assert.equal(pv.logPriceVerificationServed(s, { surface: 'search', items: [{ price: 1 }] }), false);
  assert.deepEqual(s.lines, []);
});

test('flag values: on/1/true/yes/enabled turn it on; anything else is off', () => {
  for (const v of ['on', '1', 'true', 'YES', 'enabled']) assert.equal(facts.priceVerificationLogEnabled({ PRICE_VERIFICATION_LOG: v }), true, v);
  for (const v of ['', 'off', '0', 'shadow', undefined]) assert.equal(facts.priceVerificationLogEnabled({ PRICE_VERIFICATION_LOG: v }), false, String(v));
});

test('classifyFact: live during the request, recent inside the surface window, stored otherwise', () => {
  const o = { startedAtMs: NOW, nowMs: NOW + 2000, ttlMs: 15 * MIN };
  const fact = (at, extra = {}) => ({ priced: true, merchant: true, at, ...extra });
  assert.equal(pv.classifyFact(fact(NOW + 500), o), 'live');
  assert.equal(pv.classifyFact(fact(NOW - 900), o), 'live', 'stamped while the request was admitted (1s slack)');
  assert.equal(pv.classifyFact(fact(NOW - 5 * MIN), o), 'recent');
  assert.equal(pv.classifyFact(fact(NOW - 16 * MIN), o), 'stored', 'older than the window');
  assert.equal(pv.classifyFact(fact(NOW - 5 * MIN), { ...o, ttlMs: 0 }), 'stored', 'get_offers accepts no recent answer');
  assert.equal(pv.classifyFact(fact(null), o), 'stored', 'a merchant answer with no time is not provably fresh');
  assert.equal(pv.classifyFact({ priced: true, merchant: false, at: NOW }, o), 'stored');
  assert.equal(pv.classifyFact({ priced: false, merchant: true, at: NOW }, o), null, 'no price, not counted');
  assert.deepEqual(pv.TTL_MS, { search: 15 * MIN, recommend_products: 15 * MIN, get_product: 10 * MIN, get_pdp_v2: 10 * MIN, get_offers: 0 });
});

test('priceFactOf: price spellings, answer times, and prices the answer withholds', () => {
  assert.deepEqual(facts.priceFactOf({ price: 10, price_source: 'merchant_live', price_as_of: iso(NOW) }), { priced: true, merchant: true, at: NOW });
  assert.deepEqual(facts.priceFactOf({ price: { current: { amount: 9, currency: 'USD' } }, live_read: { checked_at: iso(NOW) }, price_source: 'merchant_live' }), { priced: true, merchant: true, at: NOW });
  assert.deepEqual(facts.priceFactOf({ price_amount: '12.5' }), { priced: true, merchant: false, at: null });
  assert.deepEqual(facts.priceFactOf({ price: 25, merchant_price_verified: true, live_read: { checked_at: iso(NOW) } }), { priced: true, merchant: true, at: NOW });
  assert.equal(facts.priceFactOf({ price: 0 }).priced, false, '0 is the not-buyable sentinel');
  assert.equal(facts.priceFactOf({ price: 14, commerce_verification: { required: true } }).priced, false);
  assert.equal(facts.priceFactOf({ price: 14, commerce_verification: { price_trusted: false } }).priced, false);
  assert.equal(facts.priceFactOf(null), null);
});

test('priceFactsOf: the priced objects of each tool, the overlay copy, the market, the page limit', () => {
  on();
  const search = facts.priceFactsOf('search_catalog', {
    products: [{ price: 1, price_source: 'merchant_live', price_as_of: iso(NOW) }, { price: 2 }, 'junk'],
    metadata: { market: 'us', live_merchant_price: { attempted: true, verified_count: 1, failure_reasons: { timeout: 2, 'bad key!': 1 }, ucp: { mode: 'enforce', planned_count: 3, by_status: { x: 1 } }, note: 'free text with spaces' } },
  }).price_facts;
  assert.equal(search.surface, 'search');
  assert.equal(search.items.length, 2, 'a non-object row has no fact');
  assert.equal(search.market, 'US');
  assert.deepEqual(search.overlay, { attempted: true, verified_count: 1, failure_reasons: { timeout: 2 }, ucp: { mode: 'enforce', planned_count: 3 } });
  assert.equal(facts.priceFactsOf('search_catalog', { products: [{ price: 1 }, { price: 2 }, { price: 3 }] }, { limit: 2 }).price_facts.items.length, 2);

  assert.equal(facts.priceFactsOf('get_product', { product: { price: 5 } }).price_facts.items.length, 1);
  assert.equal(facts.priceFactsOf('get_product', { price: 5 }).price_facts.items.length, 1, 'a bare product');
  const offers = facts.priceFactsOf('get_offers', { signals: [{ value: { price: 25, merchant_price_verified: true, live_read: { checked_at: iso(NOW) } } }, { value: { price: 27 } }], metadata: { market: 'SG' } }).price_facts;
  assert.deepEqual(offers.items, [{ priced: true, merchant: true, at: NOW }, { priced: true, merchant: false, at: null }]);
  assert.equal(offers.market, 'SG');
  assert.equal(offers.overlay, undefined, 'only search carries an overlay');
  const reco = facts.priceFactsOf('recommend_products', { signals: [{ value: { product: { price: 30, price_verified: true } } }] }).price_facts;
  assert.deepEqual(reco.items, [{ priced: true, merchant: false, at: null }], 'price_verified (a PDP loopback) is not a merchant answer');
  assert.equal(facts.priceFactsOf('get_intel', { price: 1 }), null);
  assert.equal(facts.priceFactsOf('search_catalog', null).price_facts.items.length, 0);
});

test('the loopback context is honoured only on a loopback self-call, and only as known labels', () => {
  const header = 'door=mcp;tier=authenticated;caller_class=api_key;agent_id=agent_1;request_id=abc123;started_at_ms=1792598400000';
  assert.deepEqual(pv.inheritedContext(loopbackReq(header)), {
    door: 'mcp', tier: 'authenticated', caller_class: 'api_key', agent_id: 'agent_1', request_id: 'abc123', started_at_ms: 1792598400000,
  });
  assert.equal(pv.inheritedContext(loopbackReq(header, { xff: '203.0.113.9' })), null, 'routed in from outside: ignored');
  assert.equal(pv.inheritedContext({ ...loopbackReq(header), socket: { remoteAddress: '10.0.0.4' } }), null);
  assert.deepEqual(pv.inheritedContext(loopbackReq('door=admin;tier=root;agent_id=a b;request_id=%ZZ')), null, 'unknown door: no context');
  assert.deepEqual(pv.inheritedContext(loopbackReq('door=public_mcp;tier=root;agent_id=a%20b')), { door: 'public_mcp' }, 'bad values dropped');
  assert.equal(pv.inheritedContext(loopbackReq('x'.repeat(600))), null);
});

test('priceContextHeaders round-trips through inheritedContext', async () => {
  on();
  const req = { headers: {}, socket: { remoteAddress: '203.0.113.9' }, invokeAuth: { auth_mode: 'api_key', agent_id: 'agent_7' } };
  await pv.runWithPriceDoor(req, 'ucp_mcp', async () => {
    const { 'X-Pivota-Price-Context': header } = pv.priceContextHeaders();
    const back = pv.inheritedContext(loopbackReq(header));
    const mine = pv.currentPriceContext();
    assert.equal(back.door, 'ucp_mcp');
    assert.equal(back.tier, 'authenticated');
    assert.equal(back.caller_class, 'api_key');
    assert.equal(back.agent_id, 'agent_7');
    assert.equal(back.request_id, mine.request_id);
    assert.equal(back.started_at_ms, mine.started_at_ms);
  });
});

test('a loopback call reports its overlay to its door, which closes its registry entry when done', async () => {
  on();
  const doorReq = { headers: { 'x-cloud-trace-context': 'ABCDEF0123456789/1;o=1' }, socket: { remoteAddress: '203.0.113.9' } };
  let doorStore;
  let release;
  const held = new Promise((r) => { release = r; });
  const done = pv.runWithPriceDoor(doorReq, 'mcp', async () => {
    doorStore = pv.currentPriceContext();
    assert.equal(doorStore.request_id, 'abcdef0123456789', 'Cloud Run trace id is the request id');
    const header = pv.priceContextHeaders()['X-Pivota-Price-Context'];
    // The loopback invoke, as priceContextMiddleware('invoke') runs it.
    await new Promise((resolve) => {
      pv.priceContextMiddleware('invoke')(loopbackReq(header), {}, async () => {
        const store = pv.currentPriceContext();
        assert.equal(store.via_loopback, true);
        assert.equal(store.door, 'mcp', 'labelled with the door that asked');
        assert.equal(store.parent, doorStore);
        assert.deepEqual(pv.priceContextLogFields().door, 'mcp');
        pv.trackSearchOverlay(null, { skipped: 'page_gt_1' });
        await pv.trackLiveWork(new Promise((r) => setTimeout(r, 15)));
        resolve();
      });
    });
    await held;
  });
  assert.equal(pv._openDoors.get('abcdef0123456789'), doorStore, 'open while the door works');
  release();
  await done;
  assert.equal(pv._openDoors.has('abcdef0123456789'), false, 'closed when it is done');
  const work = pv.recordedLiveWork(doorStore);
  assert.equal(work.overlay_calls, 1);
  assert.equal(work.overlay_skipped, 'page_gt_1');
  assert.ok(work.added_ms >= 10, `the loopback's live work counts on the door: ${work.added_ms}`);
});

test('added_ms is the span live work covered, not the sum of parallel reads', async () => {
  on();
  await pv.runWithPriceContext({ door: 'mcp' }, async () => {
    const t = (ms) => pv.trackLiveWork(new Promise((r) => setTimeout(r, ms)));
    await Promise.all([t(30), t(30), t(30)]);
    const { added_ms: added } = pv.recordedLiveWork(pv.currentPriceContext());
    assert.ok(added >= 25 && added < 80, `three parallel 30ms reads add ~30ms, got ${added}`);
    await assert.rejects(pv.trackLiveWork(Promise.reject(new Error('boom'))), /boom/, 'a failure passes through');
  });
});

test('the MCP capture: one line per priced tool result; a cache replay is recent and waited for nothing', async () => {
  on();
  const s = sink();
  const ok = { body: { jsonrpc: '2.0', id: 1, result: { content: [] } } };
  await pv.runWithPriceContext({ door: 'public_mcp', tier: 'public', started_at_ms: Date.now() }, async () => {
    const store = pv.currentPriceContext();
    const capture = pv.mcpPriceCapture();
    assert.equal(pv.mcpPriceCapture(), capture, 'one per request');
    capture.note({ cache_hit: 'stale' });
    capture.note({ price_facts: {
      tool: 'search_catalog', surface: 'search', market: null,
      items: [{ priced: true, merchant: true, at: Date.now() - 4 * MIN }, { priced: true, merchant: false, at: null }],
      overlay: { attempted: true, verified_count: 1 },
    } });
    store.live_first_ms = 1;
    store.live_last_ms = 500;
    assert.equal(pv.logMcpPriceVerificationServed(s, ok, { market: 'us' }), true);
  });
  const [line] = s.lines;
  assert.equal(line.msg, 'price_verification_served');
  assert.equal(line.event, 'price_verification_served');
  assert.deepEqual(
    { surface: line.surface, door: line.door, tier: line.tier, market: line.market, live: line.live, recent: line.recent, stored: line.stored, verified_count: line.verified_count, total: line.total, added_ms: line.added_ms, skipped_reason: line.skipped_reason, cache_hit: line.cache_hit, overlay_ran: line.overlay_ran, overlay_verified: line.overlay_verified },
    { surface: 'search', door: 'public_mcp', tier: 'public', market: 'US', live: 0, recent: 1, stored: 1, verified_count: 1, total: 2, added_ms: 0, skipped_reason: 'mcp_read_cache_replay', cache_hit: 'stale', overlay_ran: true, overlay_verified: 1 },
  );

  const s2 = sink();
  await pv.runWithPriceContext({ door: 'mcp' }, async () => {
    const capture = pv.mcpPriceCapture();
    capture.note({ price_facts: { tool: 'search_catalog', surface: 'search', items: [] } });
    pv.logMcpPriceVerificationServed(s2, ok);
    pv.logMcpPriceVerificationServed(s2, { body: { result: { isError: true } } });
  });
  assert.equal(s2.lines.length, 2 - 1, 'a tool error writes no line');
  assert.equal(s2.lines[0].skipped_reason, 'lane_not_overlaid', 'no overlay ran for this answer');

  const s3 = sink();
  await pv.runWithPriceContext({ door: 'mcp' }, async () => {
    pv.mcpPriceCapture().note({ cache_hit: false });
    pv.logMcpPriceVerificationServed(s3, ok);
  });
  assert.deepEqual(s3.lines, [], 'a tool that handed over no facts (not priced) writes no line');
});

test('logPriceVerificationServed: only known surfaces; labels are tokens; door falls back to the context', async () => {
  on();
  const s = sink();
  await pv.runWithPriceContext({ door: 'rest', tier: 'unauthenticated' }, async () => {
    assert.equal(pv.logPriceVerificationServed(s, { surface: 'nope', items: [] }), false);
    pv.logPriceVerificationServed(s, { surface: 'get_pdp_v2', items: [{ price: 3 }], market: 'u s', skipped_reason: 'has space', added_ms: -4 });
  });
  assert.equal(s.lines.length, 1);
  assert.equal(s.lines[0].door, 'rest');
  assert.equal(s.lines[0].market, null);
  assert.equal(s.lines[0].skipped_reason, null);
  assert.equal(s.lines[0].added_ms, 0);
  assert.equal(s.lines[0].stored, 1);
});

test('searchOverlayLogFields: the overlay outcome as flat fields, why it did not run included', () => {
  assert.deepEqual(pv.searchOverlayLogFields(undefined), { overlay_ran: false });
  assert.deepEqual(pv.searchOverlayLogFields({ attempted: false, skipped_reason: 'budget_constraint' }), { overlay_ran: false, overlay_skipped_reason: 'budget_constraint' });
  assert.deepEqual(
    pv.searchOverlayLogFields({ attempted: true, eligible_count: 4, fetch_attempt_count: 3, cache_hit_count: 1, verified_count: 2, drift_count: 1, gone_count: 0, dropped_gone_count: 0, deadline_exceeded: true, failure_reasons: { http_429: 1 }, ucp: { mode: 'shadow', planned_count: 2, settled_count: 0, verified_count: 0 } }),
    { overlay_ran: true, overlay_eligible: 4, overlay_fetch_attempts: 3, overlay_cache_hits: 1, overlay_verified: 2, overlay_drifted: 1, overlay_gone: 0, overlay_dropped_gone: 0, overlay_deadline_exceeded: true, overlay_failure_reasons: { http_429: 1 }, overlay_ucp: { mode: 'shadow', planned: 2, settled: 0, verified: 0 } },
  );
});

// --- the HTTP status of a failed lookup, on the reader lines (ucpLiveOfferRead) -----------------------------

function failingClient(status) {
  return {
    async discoverEndpoint(base) { return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 }; },
    async lookupCatalog() { return { ok: false, status, error: 'rate_limited' }; },
  };
}

const OFFER = {
  offer_id: 'of:x:1', merchant_id: 'm', price: 25, currency: 'USD', in_stock: true,
  execution_spec: { merchant_domain: 'store.test', variant_id: '43734829564039' },
};

test('get_offers reader: a 429 lookup is logged with its status (flag on) and as before (flag off)', async () => {
  for (const flag of [false, true]) {
    if (flag) on(); else off();
    const logs = [];
    const r = createUcpLiveOfferReader({ ucpClient: failingClient(429), mode: 'enforce', log: (event, fields) => logs.push({ event, ...fields }) });
    const { offers } = await r.readOffers([OFFER], { market: 'US', currency: 'USD' });
    assert.equal(offers[0].live_read.status, 'error');
    assert.equal(offers[0].live_read.http_status, undefined, 'never in the answer');
    const host = logs.find((l) => l.event === 'get_offers_ucp_live_read').hosts[0];
    assert.equal(host.reason, 'lookup_failed');
    assert.equal(host.http_status, flag ? 429 : undefined, `flag ${flag ? 'on' : 'off'}`);
  }
});

test('get_product reader: a 503 lookup is logged with its status (flag on) and never reaches the product', async () => {
  for (const flag of [false, true]) {
    if (flag) on(); else off();
    const logs = [];
    const r = createUcpLiveProductReader({ ucpClient: failingClient(503), mode: 'enforce', log: (event, fields) => logs.push({ event, ...fields }) });
    const product = {
      product_id: 'p1', currency: 'USD', price: 25, destination_url: 'https://store.test/products/tint',
      variants: [{ variant_id: '43734829564039', price: { current: { amount: 25, currency: 'USD' } } }],
    };
    const served = await r.readProduct({ product }, { market: 'US' });
    const line = logs.find((l) => l.event === 'get_product_ucp_live_read');
    assert.equal(line.status, 'error');
    assert.equal(line.http_status, flag ? 503 : undefined);
    assert.equal(JSON.stringify(served).includes('503'), false, 'the status is a log field only');
  }
});
