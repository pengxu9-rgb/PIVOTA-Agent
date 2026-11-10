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
const { revertNoMarketDescriptionEdits } = require('./_support/noMarketDescriptionEdits.cjs');

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

// DECISION D-10 (2026-11-08): a read that names no market is answered as US and says so (`market_assumed`, and on the
// UCP door the same notice in `messages`); recommend_products takes no market, so it always says so. These cases name
// none: their answer is the pre-log one PLUS that label, which is taken back out (and asserted) here. Every other
// case names a market, and is compared byte for byte as it always was.
const NO_MARKET_CASES = new Set(['ucp_search', 'public_search', 'mcp_recommend']);
function stripMarketAssumed(text) {
  const o = JSON.parse(text);
  const r = (o && o.result) || {};
  let label = null;
  const take = (inner) => {
    if (!inner || typeof inner !== 'object' || !('market_assumed' in inner)) return false;
    label = inner.market_assumed;
    delete inner.market_assumed;
    if (Array.isArray(inner.messages)) {
      const rest = inner.messages.filter((m) => m.code !== 'market_assumed');
      if (rest.length) inner.messages = rest;
      else delete inner.messages;
    }
    return true;
  };
  if (r.structuredContent) take(r.structuredContent);
  if (Array.isArray(r.content) && r.content[0] && /^\{/.test(r.content[0].text)) {
    const inner = JSON.parse(r.content[0].text);
    if (take(inner)) r.content[0].text = JSON.stringify(inner, null, 2);
  }
  return { text: JSON.stringify(o), label };
}

// ...and their `mcp tools/call complete` line records `market_assumed: true` (the production count of calls that
// relied on the default), which is taken back out of the pinned lines (and asserted) the same way.
function assumedOnCompletionLines(lines, name) {
  if (!NO_MARKET_CASES.has(name)) return { lines, assumed: undefined };
  let assumed = false;
  const out = lines.map((l) => {
    if (l.msg !== 'mcp tools/call complete' || !('market_assumed' in l)) return l;
    assumed = l.market_assumed === true;
    const { market_assumed: _m, ...rest } = l;
    return rest;
  });
  return { lines: out, assumed };
}

const snapshot = (r, { flag, name } = {}) => ({
  status: r.status,
  completion_market_assumed: assumedOnCompletionLines(pinnedLines(r.lines, { flag }), name).assumed,
  // The tool list: D-10's description edits (and only those) reversed before the byte comparison.
  text: NO_MARKET_CASES.has(name) ? stripMarketAssumed(maskIds(r.text)).text : name === 'public_tools_list' ? revertNoMarketDescriptionEdits(maskIds(r.text)) : maskIds(r.text),
  market_assumed: NO_MARKET_CASES.has(name) ? stripMarketAssumed(maskIds(r.text)).label : undefined,
  lines: assumedOnCompletionLines(pinnedLines(r.lines, { flag }), name).lines,
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
        const got = snapshot(await doors.send(doors.CASES[name], { flag }), { flag, name });
        const label = `${name} (PRICE_VERIFICATION_LOG ${flag ? 'on' : 'off'})`;
        assert.equal(got.status, want.status, `${label}: status`);
        if (NO_MARKET_CASES.has(name)) {
          assert.equal(got.market_assumed && got.market_assumed.code, 'US', `${label}: no market named, so US assumed and said`);
          assert.equal(got.completion_market_assumed, true, `${label}: and the completion line counts it`);
        }
        else assert.equal(got.market_assumed, undefined);
        assert.equal(got.text, want.text, `${label}: the answer must be the pre-log answer, byte for byte`);
        assert.deepEqual(got.lines, want.lines, `${label}: live-read and completion lines`);
        assert.deepEqual(got.carriers, EXPECTED_CARRIERS[name] || [], `${label}: market_carrier / ignored_payload_market`);
        assert.deepEqual(got.loopback.map((h) => h.operation), want.loopback.map((h) => h.operation), `${label}: the same loopback calls`);
        if (!flag) assert.deepEqual(got.loopback, want.loopback, `${label}: no loopback call carries a price context`);
      }
    });
  }
}
