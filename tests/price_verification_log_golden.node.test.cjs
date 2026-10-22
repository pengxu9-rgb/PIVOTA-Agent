'use strict';

// PRICE_VERIFICATION_LOG IS LOG ONLY: every answer an agent gets is byte-identical with the flag off and on,
// through the REAL doors (/mcp, /ucp/mcp, /public/mcp, REST search), and only the log changes. And each door's
// line counts the prices THAT DOOR serves (priceVerificationFacts, WHAT COUNTS).
//
// HARNESS: tests/_support/priceLogDoors.cjs (no store, backend, search pipeline or reco lane is contacted).
// Off vs on inside one build cannot see a change that happens whatever the flag says; the answers are also
// pinned against bodies captured before the log existed: tests/price_verification_log_fixture.node.test.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPriceLogDoors, NOW, iso, SECRET, QUERY, maskIds } = require('./_support/priceLogDoors.cjs');

const doors = createPriceLogDoors({ port: 3993 });
const { app, lines, CASES } = doors;

test.before(() => doors.start(test.mock.timers));
test.after(() => doors.stop(test.mock.timers));

/** The same request with the flag off, then on: the bodies, and the lines each one wrote. */
async function offThenOn(request) {
  const off = await doors.send(request, { flag: false });
  const on = await doors.send(request, { flag: true });
  return { off, on };
}

const served = (ls) => ls.filter((l) => l.event === 'price_verification_served');
const counts = (l) => ({ live: l.live, recent: l.recent, stored: l.stored, verified_count: l.verified_count, total: l.total });

// THE LINE'S EXACT KEY SET (PII guard): a served line carries these keys and nothing else -- never the tool
// arguments, the query text, a header or a buyer field. `extra` names the per-surface additions.
const BASE_KEYS = [
  'event', 'msg', 'surface', 'door', 'tier', 'caller_class', 'agent_id', 'request_id', 'market', 'live', 'recent',
  'stored', 'verified_count', 'total', 'added_ms', 'skipped_reason',
];
const OVERLAY_KEYS = [
  'overlay_ran', 'overlay_eligible', 'overlay_fetch_attempts', 'overlay_cache_hits', 'overlay_verified',
  'overlay_drifted', 'overlay_gone', 'overlay_dropped_gone', 'overlay_failure_reasons',
];
function assertLineKeys(line, extra = []) {
  assert.deepEqual(Object.keys(line).sort(), [...BASE_KEYS, ...extra].sort(), `exact key set: ${JSON.stringify(line)}`);
}

// X-Pivota-Price-Context grammar: `key=value` pairs joined by `;`, keys from this fixed set, each at most once,
// values URI-encoded tokens. Nothing else (no Authorization, no argument) may ride in it.
const CONTEXT_KEYS = new Set(['door', 'tier', 'caller_class', 'agent_id', 'request_id', 'door_key', 'started_at_ms']);
function assertContextHeader(header) {
  assert.equal(typeof header, 'string');
  const seen = new Set();
  for (const part of header.split(';')) {
    const m = /^([a-z_]+)=([A-Za-z0-9_.%-]{1,128})$/.exec(part);
    assert.ok(m, `header part ${JSON.stringify(part)} breaks the grammar`);
    assert.ok(CONTEXT_KEYS.has(m[1]), `header key ${m[1]} is not allowed`);
    assert.ok(!seen.has(m[1]), `header key ${m[1]} repeated`);
    seen.add(m[1]);
  }
  assert.ok(seen.has('door') && seen.has('request_id') && seen.has('door_key'));
}

function assertGolden({ off, on }, label) {
  assert.equal(off.status, 200, `${label}: ${off.text.slice(0, 300)}`);
  assert.equal(on.status, off.status, `${label}: same status`);
  assert.equal(maskIds(on.text), maskIds(off.text), `${label}: the answer must be byte-identical with PRICE_VERIFICATION_LOG on`);
  assert.deepEqual(served(off.lines), [], `${label}: flag off writes no price line`);
  assert.deepEqual(off.headers.map((h) => h.price_context), off.headers.map(() => null), `${label}: off, no loopback call carries a price context`);
  // The context header is for this process's own loopback only: never the backend (offers.resolve, v1 / v2
  // search) and never the merchant's UCP client, flag off or on.
  for (const r of [off, on]) {
    assert.deepEqual(r.backend.filter((b) => b.price_context !== null), [], `${label}: no backend call carries X-Pivota-Price-Context`);
    assert.deepEqual(r.merchant.filter((m) => /door_key|door=|X-Pivota-Price-Context/i.test(m)), [], `${label}: no merchant call carries the price context`);
  }
  for (const l of off.lines) {
    for (const k of ['door', 'request_id', 'http_status']) {
      if (String(l.event || '').endsWith('_ucp_live_read')) assert.equal(l[k], undefined, `${label}: off, ${l.event} carries no ${k}`);
    }
  }
}

// The search page (priceLogDoors SEARCH_PAGE): noid live, live, recent, old, stored, unpriced, held, nocur (recent).
test('MCP /mcp search_catalog: byte-identical; the native page counted as /mcp serves it, held and unpublishable rows included', async () => {
  const pair = await offThenOn(CASES.mcp_search);
  assertGolden(pair, '/mcp search');
  assert.equal(pair.off.headers.length, 1);
  assert.match(pair.on.headers[0].price_context, /^door=mcp;tier=authenticated;/, 'on: the loopback names its door and caller');
  assertContextHeader(pair.on.headers[0].price_context);
  assert.ok(!pair.on.headers[0].price_context.includes(SECRET) && !pair.on.headers[0].price_context.includes(QUERY), 'no secret or query in the header');
  for (const l of served(pair.on.lines)) {
    const text = JSON.stringify(l);
    assert.ok(!text.includes(SECRET) && !text.includes(QUERY), `no secret or query text in a served line: ${text}`);
  }
  const [line, ...more] = served(pair.on.lines);
  assert.equal(more.length, 0, 'exactly one line per answer: the loopback invoke writes none of its own');
  assert.equal(line.msg, 'price_verification_served');
  assertLineKeys(line, OVERLAY_KEYS);
  assert.equal(line.surface, 'search');
  assert.equal(line.door, 'mcp');
  assert.equal(line.tier, 'authenticated');
  assert.equal(line.market, 'US');
  assert.deepEqual(
    counts(line),
    { live: 2, recent: 2, stored: 3, verified_count: 4, total: 7 },
    '/mcp serves the native page: the id-less row and the no-currency row carry prices, and a price flagged for verification is still quoted (stored); only the 0 sentinel is not a price',
  );
  assert.equal(line.overlay_ran, true);
  assert.equal(line.overlay_verified, 2);
  assert.deepEqual(line.overlay_failure_reasons, { http_429: 1 });
  // The loopback here is a fixture: the page carries an overlay outcome this request never ran.
  assert.equal(line.skipped_reason, 'overlay_not_observed');
  assert.equal(line.cache_hit, undefined, 'the read cache is off here');
  assert.match(line.request_id, /^[0-9a-f]{16}$/);
  assert.ok(pair.on.headers[0].price_context.includes(`request_id=${line.request_id}`), 'the loopback carries the door line\'s request id');
});

test('MCP /ucp/mcp search_catalog: byte-identical; only the rows the UCP shaper publishes are counted', async () => {
  const pair = await offThenOn(CASES.ucp_search);
  assertGolden(pair, '/ucp/mcp search');
  const lines_ = served(pair.on.lines);
  assert.equal(lines_.length, 1);
  assertLineKeys(lines_[0], OVERLAY_KEYS);
  assert.equal(lines_[0].door, 'ucp_mcp');
  const published = JSON.parse(JSON.parse(pair.on.text).result.content[0].text).products.length;
  assert.equal(published, 5, 'the shaper published live, recent, old, stored and unpriced');
  assert.deepEqual(
    counts(lines_[0]),
    { live: 1, recent: 1, stored: 2, verified_count: 2, total: 4 },
    'no id (noid), live quote required (held) and no ISO currency (nocur) are not published, so not counted',
  );
});

test('MCP /public/mcp search_catalog: byte-identical; the public tier counts the rows it serves with a price', async () => {
  const pair = await offThenOn(CASES.public_search);
  assertGolden(pair, '/public/mcp search');
  const [line, ...more] = served(pair.on.lines);
  assert.equal(more.length, 0);
  assertLineKeys(line, OVERLAY_KEYS);
  assert.equal(line.door, 'public_mcp');
  assert.equal(line.tier, 'public');
  const rows = JSON.parse(pair.on.text).result.structuredContent.products;
  assert.deepEqual(rows.map((p) => p.price != null), [true, true, true, true, false, false, false],
    'served: live, recent, old, stored priced; unpriced, held, nocur without a price; noid dropped');
  // The id-less row first, so a fact list not aligned to the projected rows shifts every status by one; the held
  // and no-currency rows are served WITHOUT a price, so a fact that ignored the projection would count them.
  assert.deepEqual(counts(line), { live: 1, recent: 1, stored: 2, verified_count: 2, total: 4 });
});

test('MCP /mcp get_offers (live read enforced): byte-identical; the reader line names the door and request', async () => {
  const pair = await offThenOn(CASES.mcp_get_offers);
  assertGolden(pair, '/mcp get_offers');
  const offLive = pair.off.lines.find((l) => l.event === 'get_offers_ucp_live_read');
  assert.ok(offLive, 'the live read ran with the flag off too');
  const [line, ...more] = served(pair.on.lines);
  assert.equal(more.length, 0);
  assertLineKeys(line);
  assert.equal(line.surface, 'get_offers');
  assert.equal(line.door, 'mcp');
  assert.equal(line.market, 'US');
  assert.equal(line.live, 1, 'the offer the merchant answered during this request');
  assert.equal(line.stored, 1, 'backend-verified, but this request\'s read of it was skipped: stamped, not answered');
  assert.equal(line.total, 2);
  assert.deepEqual(pair.on.backend.map((b) => b.route), ['offers.resolve'], 'the backend was called, without the header');
  const onLive = pair.on.lines.find((l) => l.event === 'get_offers_ucp_live_read');
  assert.equal(onLive.door, 'mcp');
  assert.equal(onLive.request_id, line.request_id, 'the read line and the served line share the request id');
});

test('flag on, the merchant\'s UCP client is handed no price context', async () => {
  // The reader's 30 s lookup memo would answer this call from the flag-off run above (Date is frozen), so the
  // clock moves past it: this call really reaches the (fake) merchant client.
  test.mock.timers.setTime(NOW + 31 * 1000);
  try {
    const on = await doors.send(CASES.mcp_get_offers, { flag: true });
    assert.equal(on.status, 200);
    assert.ok(on.merchant.length > 0, 'the merchant was asked');
    assert.deepEqual(on.merchant.filter((m) => /door_key|door=|price.context/i.test(m)), []);
    assert.equal(served(on.lines).length, 1);
  } finally {
    test.mock.timers.setTime(NOW);
  }
});

test('MCP /mcp recommend_products: byte-identical; its price checks loop back with the door\'s context only when on', async () => {
  const pair = await offThenOn(CASES.mcp_recommend);
  assertGolden(pair, '/mcp recommend_products');
  assert.deepEqual(pair.off.headers.map((h) => h.operation), ['get_pdp_v2', 'get_pdp_v2'], 'one price check per grounded item');
  assert.equal(pair.on.headers.length, 2);
  const [line, ...more] = served(pair.on.lines);
  assert.equal(more.length, 0, 'the price-check loopbacks write no line of their own');
  for (const { price_context: header } of pair.on.headers) {
    assertContextHeader(header);
    assert.match(header, /^door=mcp;tier=authenticated;/);
    assert.ok(header.includes(`request_id=${line.request_id}`), 'each check carries the door line\'s request id');
  }
  assertLineKeys(line);
  assert.equal(line.surface, 'recommend_products');
  assert.equal(line.door, 'mcp');
  // price_verified is the PDP's price over loopback, not a merchant answer: stored, by design.
  assert.deepEqual(counts(line), { live: 0, recent: 0, stored: 2, verified_count: 0, total: 2 });
});

test('REST /agent/v1/products/search: byte-identical; one line at door rest with the lane and the overlay outcome', async () => {
  const pair = await offThenOn(CASES.rest_search);
  assertGolden(pair, 'REST search');
  assert.deepEqual(pair.on.backend.map((b) => b.route), ['v1_search'], 'v1 search was called, without the header');
  const [line, ...more] = served(pair.on.lines);
  assert.equal(more.length, 0);
  assertLineKeys(line, [...OVERLAY_KEYS.filter((k) => !['overlay_failure_reasons'].includes(k)), 'lane', 'market_source']);
  assert.equal(line.surface, 'search');
  assert.equal(line.door, 'rest');
  assert.equal(line.tier, 'unauthenticated');
  assert.equal(line.total, 1);
  assert.equal(line.stored, 1);
  assert.equal(typeof line.lane, 'string');
  assert.equal(line.overlay_ran, false);
});

test('an MCP search that REALLY loops back into the invoke handler: byte-identical, and one line, not one per hop', async () => {
  const pair = await offThenOn(CASES.mcp_real_loopback_search);
  assertGolden(pair, '/mcp real loopback search');
  assert.deepEqual(pair.on.backend.map((b) => b.route), ['v2_search'], 'the loopback hop called v2 search, without the header');
  const hops = pair.on.lines.filter((l) => l.msg === 'invoke request complete');
  assert.deepEqual(hops.map((l) => [l.status, l.operation, l.caller_loopback]), [[200, 'find_products_multi', true]],
    'the search ran in the real invoke handler, over loopback, and answered 200');
  const all = served(pair.on.lines);
  // Had the loopback not been recognised as this door's (X-Pivota-Price-Context on a loopback self-call), the
  // invoke hop would have written a second line, at door `invoke`.
  assert.equal(all.length, 1, `one line per answer: ${JSON.stringify(all)}`);
  assertLineKeys(all[0], ['overlay_ran']);
  assert.equal(all[0].door, 'mcp');
  assert.equal(all[0].surface, 'search');
  assert.equal(all[0].skipped_reason, 'lane_not_overlaid', 'the upstream-proxy lane never calls the overlay, and its answer carries no outcome');
});

test('invoke find_products_multi whose page was overlaid outside this request: overlay_not_observed, not lane_not_overlaid', async () => {
  const pair = await offThenOn(CASES.invoke_overlaid_elsewhere);
  assertGolden(pair, 'invoke overlaid elsewhere');
  assert.ok(pair.on.backend.length > 0 && pair.on.backend.every((b) => b.route === 'v2_search'), 'the upstream-proxy lane, over the backend');
  const [line, ...more] = served(pair.on.lines);
  assert.equal(more.length, 0);
  assert.equal(line.door, 'invoke');
  assert.equal(line.surface, 'search');
  assert.equal(line.overlay_ran, true, 'the answer carries an overlay outcome');
  assert.equal(line.skipped_reason, 'overlay_not_observed', 'no overlay call was recorded in this request');
});

test('a tools/call that is not priced, and a non-tools/call method, write no price line', async () => {
  const pair = await offThenOn(CASES.public_tools_list);
  assertGolden(pair, 'tools/list');
  assert.deepEqual(served(pair.on.lines), []);
});

// --- the invoke handler's line (logInvokePriceVerification), from the final body ---------------------------

const pv = require('../src/observability/priceVerificationLog');

test('invoke get_pdp_v2: the card price counted (a cached merchant answer is recent), with its variants', async () => {
  process.env.PRICE_VERIFICATION_LOG = 'on';
  lines.length = 0;
  try {
    const card = {
      product_id: 'ext_lsm', price: 24, currency: 'USD', price_source: 'merchant_live',
      live_read: { status: 'verified', checked_at: iso(NOW - 3 * 60e3) },
      variants: [{ variant_id: '1', live_read: { status: 'verified' } }, { variant_id: '2' }],
    };
    const body = { status: 'success', modules: [{ type: 'canonical', data: { pdp_payload: { product: card } } }] };
    await pv.runWithPriceContext({ door: 'invoke', tier: 'authenticated', started_at_ms: NOW }, async () => {
      app._debug.logInvokePriceVerification({ operation: 'get_pdp_v2', body, statusCode: 200, payload: { market: 'US' }, metadata: {} });
      app._debug.logInvokePriceVerification({ operation: 'get_pdp_v2', body, statusCode: 404 });
    });
    const [line, ...more] = served(lines);
    assert.equal(more.length, 0, 'an error status writes no line');
    assert.deepEqual(
      { surface: line.surface, door: line.door, live: line.live, recent: line.recent, total: line.total, added_ms: line.added_ms, variants_total: line.variants_total, variants_live_read: line.variants_live_read },
      { surface: 'get_pdp_v2', door: 'invoke', live: 0, recent: 1, total: 1, added_ms: 0, variants_total: 2, variants_live_read: 1 },
    );
  } finally {
    delete process.env.PRICE_VERIFICATION_LOG;
  }
});

test('invoke find_products_multi: overlay outcome, lane and bound market; a loopback call writes none and hands its door the market', async () => {
  process.env.PRICE_VERIFICATION_LOG = 'on';
  lines.length = 0;
  try {
    const body = {
      products: [
        { price: 10, currency: 'USD', price_source: 'merchant_live', price_as_of: iso(NOW) },
        { price: 11, currency: 'USD', price_source: 'catalog_offer' },
      ],
      metadata: { query_source: 'beauty_mainline_direct', live_merchant_price: { attempted: true, eligible_count: 2, verified_count: 1, failure_reasons: { timeout: 1 } } },
    };
    const marketRecord = { market_bound: 'US', market_source: 'declared' };
    await pv.runWithPriceContext({ door: 'invoke', tier: 'first_party', started_at_ms: NOW }, async () => {
      pv.trackSearchOverlay(Promise.resolve(body));
      app._debug.logInvokePriceVerification({ operation: 'find_products_multi', body, statusCode: 200, marketRecord });
    });
    const [line] = served(lines);
    assert.deepEqual(
      { door: line.door, tier: line.tier, market: line.market, market_source: line.market_source, lane: line.lane, live: line.live, stored: line.stored, total: line.total, skipped_reason: line.skipped_reason, overlay_verified: line.overlay_verified, overlay_failure_reasons: line.overlay_failure_reasons },
      { door: 'invoke', tier: 'first_party', market: 'US', market_source: 'declared', lane: 'beauty_mainline_direct', live: 1, stored: 1, total: 2, skipped_reason: null, overlay_verified: 1, overlay_failure_reasons: { timeout: 1 } },
    );

    lines.length = 0;
    const door = { door: 'mcp' };
    await pv.runWithPriceContext({ door: 'mcp', via_loopback: true, parent: door }, async () => {
      app._debug.logInvokePriceVerification({ operation: 'find_products_multi', body, statusCode: 200, marketRecord });
      app._debug.logInvokePriceVerification({ operation: 'get_pdp_v2', body: { modules: [] }, statusCode: 200 });
    });
    assert.deepEqual(served(lines), [], 'the door that asked writes the line for its answer');
    assert.equal(door.search_market, 'US');

    lines.length = 0;
    await pv.runWithPriceContext({ door: 'rest' }, async () => {
      app._debug.logInvokePriceVerification({ operation: 'find_products_multi', body: { products: [{ price: 3 }], metadata: {} }, statusCode: 200 });
    });
    assert.equal(served(lines)[0].skipped_reason, 'lane_not_overlaid', 'a lane that never called the overlay says so');
  } finally {
    delete process.env.PRICE_VERIFICATION_LOG;
  }
});
