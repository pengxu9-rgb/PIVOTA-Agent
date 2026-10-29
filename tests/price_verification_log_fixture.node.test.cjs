'use strict';

// PRICE_VERIFICATION_LOG CHANGES NOTHING AN AGENT GETS, against answers captured BEFORE the log existed.
//
// The golden test (price_verification_log_golden) compares flag off with flag on inside ONE build, so it cannot
// see a change that happens whatever the flag says: a facts hook that sorted the native page in place, or a
// reader line that lost its fields, is the same off and on. This file compares both against
// tests/fixtures/price_verification_log/door_answers.json, captured from the tree BEFORE #2490 (the commit named
// in the file), through the same doors and fixtures (tests/_support/priceLogDoors.cjs):
//   - every answer body, byte for byte (random request / trace / recommendation ids masked);
//   - the lines that are not the price line: the live-read lines, `mcp tools/call complete` and
//     `invoke request complete` (time, build id and gateway request id masked). Flag on, a live-read line may
//     carry the price context (door, tier, caller_class, agent_id, request_id, via_loopback, http_status) and
//     nothing else new;
//   - the loopback calls: flag off, none carries X-Pivota-Price-Context.
// The find_products_multi completion line's market_carrier / ignored_payload_market (marketTelemetry
// describeMarketCarrier) came after the capture. They are stripped before the comparison and checked on their own,
// against what each case sends, so nothing else on that line can change unseen.
//
// RECAPTURE (only when an answer is MEANT to change, in the same PR as that change):
//   git worktree add --detach <dir> <commit before the price log, or the change's parent>
//   copy tests/_support/priceLogDoors.cjs and this file into it, link node_modules, then in <dir>:
//   PRICE_LOG_FIXTURE_WRITE=<this repo>/tests/fixtures/price_verification_log/door_answers.json \
//     PRICE_LOG_FIXTURE_COMMIT=$(git rev-parse HEAD) node --test tests/price_verification_log_fixture.node.test.cjs
// The harness requires nothing from the price log, so it runs unchanged on such a tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPriceLogDoors, maskIds } = require('./_support/priceLogDoors.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'price_verification_log', 'door_answers.json');
const WRITE = process.env.PRICE_LOG_FIXTURE_WRITE || '';
const doors = createPriceLogDoors({ port: 3995 });

test.before(() => doors.start(test.mock.timers));
test.after(() => doors.stop(test.mock.timers));

const READER_LINE = /(_ucp_live_read$|^pdp_live_read$|^get_offers_)/;
const PINNED_MSGS = new Set(['mcp tools/call complete', 'invoke request complete']);
const VOLATILE_KEYS = new Set(['time', 'build_id', 'gateway_request_id']);
// What PRICE_VERIFICATION_LOG adds to a live-read line, by design (priceVerificationLog.priceContextLogFields,
// ucpLiveOfferRead.httpStatusLogField).
const PRICE_CONTEXT_KEYS = ['door', 'tier', 'caller_class', 'agent_id', 'request_id', 'via_loopback', 'http_status'];
// Added to the find_products_multi completion line after the capture; nothing else was.
const MARKET_CARRIER_KEYS = ['market_carrier', 'ignored_payload_market'];
const isSearchCompletion = (l) => l.msg === 'invoke request complete' && l.operation === 'find_products_multi';
// What each case's find_products_multi completion lines must carry, in order: rest_search sends no market;
// the other two put it in a search block. No case sends a `market` beside a search block.
const EXPECTED_CARRIERS = {
  rest_search: [{ market_carrier: 'none' }],
  mcp_real_loopback_search: [{ market_carrier: 'search_block' }],
  invoke_overlaid_elsewhere: [{ market_carrier: 'search_block' }],
};

function pinnedLines(lines, { flag }) {
  return lines
    .filter((l) => READER_LINE.test(String(l.event || '')) || PINNED_MSGS.has(l.msg))
    .map((l) => {
      const out = {};
      for (const [k, v] of Object.entries(l)) if (!VOLATILE_KEYS.has(k)) out[k] = v;
      if (flag && READER_LINE.test(String(l.event || ''))) for (const k of PRICE_CONTEXT_KEYS) delete out[k];
      if (isSearchCompletion(l)) for (const k of MARKET_CARRIER_KEYS) delete out[k];
      return out;
    });
}

const snapshot = (r, { flag }) => ({
  status: r.status,
  text: maskIds(r.text),
  lines: pinnedLines(r.lines, { flag }),
  carriers: r.lines.filter(isSearchCompletion).map((l) => {
    const out = {};
    for (const k of MARKET_CARRIER_KEYS) if (k in l) out[k] = l[k];
    return out;
  }),
  loopback: r.headers.map((h) => ({ operation: h.operation, price_context: flag ? undefined : h.price_context })),
});

if (WRITE) {
  test('capture the door answers (PRICE_LOG_FIXTURE_WRITE)', async () => {
    const cases = {};
    for (const [name, request] of Object.entries(doors.CASES)) {
      cases[name] = snapshot(await doors.send(request, { flag: false }), { flag: false });
      delete cases[name].carriers; // checked against EXPECTED_CARRIERS, never pinned
    }
    fs.mkdirSync(path.dirname(WRITE), { recursive: true });
    fs.writeFileSync(WRITE, `${JSON.stringify({ captured_from: process.env.PRICE_LOG_FIXTURE_COMMIT || null, cases }, null, 2)}\n`);
  });
} else {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

  test('the fixture covers every door case, and was captured before the price log', () => {
    assert.deepEqual(Object.keys(fixture.cases).sort(), Object.keys(doors.CASES).sort());
    assert.match(String(fixture.captured_from), /^[0-9a-f]{40}$/);
    for (const [name, want] of Object.entries(fixture.cases)) {
      for (const line of want.lines) for (const k of MARKET_CARRIER_KEYS) assert.ok(!(k in line), `${name}: the fixture predates ${k}`);
    }
  });

  for (const name of Object.keys(doors.CASES)) {
    test(`${name}: the answer and its lines are the pre-log ones, flag off and flag on`, async () => {
      const want = fixture.cases[name];
      assert.ok(want, `no fixture for ${name}`);
      for (const flag of [false, true]) {
        const got = snapshot(await doors.send(doors.CASES[name], { flag }), { flag });
        const label = `${name} (PRICE_VERIFICATION_LOG ${flag ? 'on' : 'off'})`;
        assert.equal(got.status, want.status, `${label}: status`);
        assert.equal(got.text, want.text, `${label}: the answer must be the pre-log answer, byte for byte`);
        assert.deepEqual(got.lines, want.lines, `${label}: live-read and completion lines`);
        assert.deepEqual(got.carriers, EXPECTED_CARRIERS[name] || [], `${label}: market_carrier / ignored_payload_market`);
        assert.deepEqual(got.loopback.map((h) => h.operation), want.loopback.map((h) => h.operation), `${label}: the same loopback calls`);
        if (!flag) assert.deepEqual(got.loopback, want.loopback, `${label}: no loopback call carries a price context`);
      }
    });
  }
}
