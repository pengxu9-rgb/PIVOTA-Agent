'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gatePublicFeedRows } = require('../src/services/publicFeedGate');

const SIG = 'sig_0f01590f3b80a41810bf3f5703637b27';
const EXT = 'ext_fb756aa379b28bd89ad3f4c8';
// A projection that keeps what the ACP shape keeps. Deliberately NOT one of the
// real mappers: this file tests the POLICY, and coupling it to a mapper would
// make a mapper change look like a policy failure.
const project = (r) => ({ id: r.id, price: r.price, currency: r.currency });
const gate = (rows, logger, env) => gatePublicFeedRows(rows, { project, logger, lane: 't', env });

test('drops ext_* ids — the gate the connected lane never had', () => {
  // The prod case: 17 of 17 rows carried ext_* and every PDP answered 500.
  const rows = [
    { id: SIG, price: 19.5, currency: 'USD' },
    { id: EXT, price: 19.5, currency: 'USD' },
  ];
  const { items, dropped } = gate(rows);
  assert.deepEqual(items.map((i) => i.id), [SIG]);
  assert.equal(dropped.unlinkable, 1);
});

test('drops rigs, and does so on the RAW row', () => {
  // Ordering is load-bearing: merchant_id does NOT survive buildAcpFeedItem, so
  // gating after projection would silently stop excluding rigs on the connected
  // lane. This projection drops merchant_id exactly like that mapper does.
  const rows = [
    { id: SIG, price: 10, currency: 'USD', merchant_id: 'merch_test_ownist_001' },
    { id: SIG, price: 10, currency: 'USD', merchant_id: 'merch_real' },
  ];
  const { items, dropped } = gate(rows);
  assert.equal(dropped.rig, 1);
  assert.equal(items.length, 1);
});

test('drops price-less and currency-less rows', () => {
  const rows = [
    { id: SIG, price: 19.5, currency: 'USD' },
    { id: SIG, price: null, currency: 'USD' },
    { id: SIG, price: 0, currency: 'USD' },
    { id: SIG, price: 19.5, currency: '' },
  ];
  const { items, dropped } = gate(rows);
  assert.equal(items.length, 1);
  assert.equal(dropped.unquotable, 3);
});

test('all three gates are reachable and counted independently', () => {
  // A single mixed batch, so a gate that silently swallowed another's rows
  // would show up as a wrong attribution rather than a right total.
  const rows = [
    { id: SIG, price: 19.5, currency: 'USD' },                                   // survives
    { id: SIG, price: 1, currency: 'USD', merchant_id: 'merch_test_ownist_001' }, // rig
    { id: EXT, price: 1, currency: 'USD' },                                       // unlinkable
    { id: SIG, price: null, currency: 'USD' },                                    // unquotable
  ];
  const { items, dropped } = gate(rows);
  assert.equal(items.length, 1);
  assert.deepEqual(dropped, { rig: 1, unlinkable: 1, unquotable: 1 });
});

test('an unresolvable link logs at WARN, not info', () => {
  // A dead link on a public feed is a data problem upstream. If this degrades to
  // info it disappears into the noise prod already filters.
  const warns = []; const infos = [];
  gate([{ id: EXT, price: 1, currency: 'USD' }], { warn: (o) => warns.push(o), info: (o) => infos.push(o) });
  assert.equal(warns.length, 1);
  assert.equal(warns[0].reason, 'unresolvable_pdp_id');
  assert.equal(infos.length, 0);
});

test('a clean batch logs nothing', () => {
  const lines = [];
  const { items } = gate([{ id: SIG, price: 5, currency: 'USD' }], { warn: (o) => lines.push(o), info: (o) => lines.push(o) });
  assert.equal(items.length, 1);
  assert.equal(lines.length, 0, 'no drops must mean no log lines');
});

test('tolerates junk input without throwing', () => {
  for (const bad of [undefined, null, 'nope', {}]) {
    const { items, dropped } = gate(bad);
    assert.deepEqual(items, []);
    assert.deepEqual(dropped, { rig: 0, unlinkable: 0, unquotable: 0 });
  }
});

test('BOTH lanes call the shared gate — neither keeps a private chain', () => {
  // The whole point of #1847. If a lane re-assembles its own filter chain, the
  // two can silently diverge again — which is how the connected lane ended up
  // with no link gate while the index lane had one.
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/services/acpFeedSource'), 'utf8');
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(source, /gatePublicFeedRows\(products, \{/, 'the index lane must call the shared gate');
  assert.match(server, /gatePublicFeedRows\(products, \{/, 'the connected lane must call the shared gate');
  // And neither may re-apply the predicates itself — a lane that still filters
  // locally is a lane that can drift.
  const laneBody = server.slice(server.indexOf('const getProducts = async (query)'), server.indexOf('return createAcpRestAdapter('));
  assert.ok(!/\.filter\(\(p\) => !isTestMerchantId/.test(laneBody), 'the connected lane must not keep its own rig filter');
  assert.ok(!/isQuotableFeedItem\(mapFeedItem/.test(laneBody), 'the connected lane must not keep its own price filter');
});

test('the link gate CANNOT be opted out of by a caller', () => {
  // Review finding: while `isLinkable` was an injected parameter, a lane could
  // pass `() => true` and still be "calling the shared gate" — rig and price
  // were hard-wired but the one gate #1847 exists to add was neutralisable.
  // The predicate is now owned by this module, so there is no seam to pass.
  const out = gatePublicFeedRows([{ id: EXT, price: 1, currency: 'USD' }], {
    project, lane: 't', isLinkable: () => true,   // ignored — no such option
  });
  assert.equal(out.items.length, 0, 'a caller-supplied isLinkable must not be honoured');
  assert.equal(out.dropped.unlinkable, 1);
});

test('the rig escape hatch works with NO env option — the connected lane path', () => {
  // Review finding: the index lane threads `env` explicitly and that is pinned
  // twice, but the CONNECTED lane relies on the default — and nothing pinned
  // it. Both `env = {}` in the gate and `env: {}` at the call site killed the
  // no-deploy hatch with the whole suite green. The connected lane is the one
  // that served 20/20 rigs on 2026-07-23, so this is the path that matters.
  const prev = process.env.PIVOTA_TEST_MERCHANT_IDS;
  try {
    process.env.PIVOTA_TEST_MERCHANT_IDS = 'merch_spotted_today';
    const out = gatePublicFeedRows([{ id: SIG, price: 5, currency: 'USD', merchant_id: 'merch_spotted_today' }], {
      project, lane: 'connected',   // deliberately NO env option
    });
    assert.equal(out.dropped.rig, 1, 'an operator must be able to exclude a rig without a deploy');
    assert.equal(out.items.length, 0);
  } finally {
    if (prev === undefined) delete process.env.PIVOTA_TEST_MERCHANT_IDS;
    else process.env.PIVOTA_TEST_MERCHANT_IDS = prev;
  }
});

test('a logger missing .info does not throw — it skips, as the old chain did', () => {
  // Review finding: `if (logger) { logger.info(` threw where the replaced chain
  // used `logger?.info` and silently skipped. The throw surfaces as a bare,
  // unlogged 500 on the public feed via the adapter's guard().
  assert.doesNotThrow(() => gate([{ id: SIG, price: null, currency: 'USD' }], { warn() {} }));
  assert.doesNotThrow(() => gate([{ id: EXT, price: 1, currency: 'USD' }], { info() {} }));
  assert.doesNotThrow(() => gate([{ id: EXT, price: 1, currency: 'USD' }], {}));
});

test('log lines carry BOTH lane and source', () => {
  // The index lane's sibling log lines in server.js still emit
  // `source: 'index_feed'`, so dropping it here would make a `source=` query
  // return a partial view of that lane.
  const lines = [];
  gatePublicFeedRows([{ id: EXT, price: 1, currency: 'USD' }], {
    project, lane: 'index_feed', logger: { warn: (o) => lines.push(o), info: (o) => lines.push(o) },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].lane, 'index_feed');
  assert.equal(lines[0].source, 'index_feed');
  assert.equal(lines[0].surface, 'acp_public_feed');
});
