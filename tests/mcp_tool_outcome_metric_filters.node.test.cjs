'use strict';

// The log-based metric filters in infra/gcp/monitoring/mcp_tool_outcomes/, evaluated against the completion
// lines the recorder (src/observability/mcpToolCallOutcome.js) actually produces.
//
// Why: a caller-limit 503 written before dispatch used to log as outcome=internal_error / error_class=server,
// so the server-error metric (and through it the error-rate alert) counted the caller limits SHEDDING load as
// an outage, and the answered-call denominator counted each instant refusal as an answered call. The filters
// are YAML a reviewer reads, not code anything runs, so this file runs them: each filter is parsed clause by
// clause (an unrecognised clause fails the test rather than being skipped) and applied to real recorder output.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { createMcpToolCallRecorder } = require('../src/observability/mcpToolCallOutcome');
const { limitRejectionResponse } = require('../src/guardrails/mcpCallerLimits');

const DIR = path.join(__dirname, '..', 'infra', 'gcp', 'monitoring', 'mcp_tool_outcomes');

function loadFilter(name) {
  const doc = YAML.parse(fs.readFileSync(path.join(DIR, `metric.${name}.yaml`), 'utf8'));
  assert.equal(typeof doc.filter, 'string', `${name} has a filter`);
  return doc.filter;
}

function get(entry, dotted) {
  return dotted.split('.').reduce((v, k) => (v == null ? undefined : v[k]), entry);
}

function literal(raw) {
  if (/^".*"$/.test(raw)) return JSON.parse(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  throw new Error(`unrecognised literal ${raw}`);
}

/** The subset of the Cloud Logging query language these filters use: clauses joined by AND. */
function matches(filter, entry) {
  const clauses = filter.split(/\s+AND\s+/).map((c) => c.trim()).filter(Boolean);
  return clauses.every((clause) => {
    // `NOT field=value` matches when the field is absent too (Cloud Logging negation), unlike `!=`.
    let m = clause.match(/^NOT\s+([A-Za-z_][\w.]*)=(.+)$/);
    if (m) return get(entry, m[1]) !== literal(m[2].trim());
    m = clause.match(/^([A-Za-z_][\w.]*):\*$/);
    if (m) return get(entry, m[1]) !== undefined && get(entry, m[1]) !== null;
    m = clause.match(/^([A-Za-z_][\w.]*)\s*(!=|>=|<=|=)\s*(.+)$/);
    if (!m) throw new Error(`unrecognised clause: ${clause}`);
    const [, field, op, raw] = m;
    const want = literal(raw.trim());
    const have = get(entry, field);
    if (op === '=') return have === want;
    if (op === '!=') return have !== undefined && have !== want;
    if (op === '>=') return typeof have === 'number' && have >= want;
    return typeof have === 'number' && have <= want;
  });
}

// One completion line as Cloud Logging stores it, the fields built by the real recorder.
function entry(recorder, status, extra = {}) {
  return {
    resource: { type: 'cloud_run_revision', labels: { service_name: 'gateway' } },
    jsonPayload: {
      msg: 'mcp tools/call complete',
      door: 'public_mcp',
      tool: 'search_catalog',
      tier: 'public',
      status,
      latency_ms: 1,
      ...recorder.fields(status),
      ...extra,
    },
  };
}

function shedLine(reason) {
  const refusal = limitRejectionResponse({ reason, status: 503, retryAfterSec: 5 }, { rpcId: 1, tier: 'anonymous' });
  const r = createMcpToolCallRecorder();
  r.recordCallerLimitRefusal(refusal);
  return entry(r, refusal.status);
}

function tooManyLine(reason) {
  const refusal = limitRejectionResponse({ reason, status: 429, retryAfterSec: 5 }, { rpcId: 1, tier: 'partner' });
  const r = createMcpToolCallRecorder();
  r.recordCallerLimitRefusal(refusal);
  return entry(r, refusal.status, { door: 'mcp', tier: 'authenticated' });
}

function internalErrorLine() {
  const r = createMcpToolCallRecorder();
  r.recordInternalError();
  return entry(r, 503);
}

function answeredLine() {
  const r = createMcpToolCallRecorder();
  r.recordRpcResponse({ status: 200, body: { jsonrpc: '2.0', id: 1, result: { content: [] } } });
  return entry(r, 200);
}

const SERVER_ERRORS = 'mcp_tool_call_server_errors';
const CALLS = 'mcp_tool_calls';
const LATENCY = 'mcp_tool_call_latency';

test('controls: the evaluator counts a real server error and a real answer, so the exclusions below mean something', () => {
  assert.equal(matches(loadFilter(SERVER_ERRORS), internalErrorLine()), true, 'a failed dispatch is a server error');
  assert.equal(matches(loadFilter(CALLS), internalErrorLine()), true);
  assert.equal(matches(loadFilter(CALLS), answeredLine()), true);
  assert.equal(matches(loadFilter(LATENCY), answeredLine()), true);
  assert.equal(matches(loadFilter(SERVER_ERRORS), answeredLine()), false);
  // First-party traffic stays out of every metric.
  assert.equal(matches(loadFilter(CALLS), entry(createMcpToolCallRecorder(), 200, { tier: 'first_party' })), false);
});

for (const reason of ['shed', 'tier_concurrency', 'tier_rate']) {
  test(`a caller-limit ${reason} 503 is not a server error, not an answered call, and not a latency sample`, () => {
    const line = shedLine(reason);
    assert.equal(line.jsonPayload.outcome, 'shed');
    assert.equal(matches(loadFilter(SERVER_ERRORS), line), false, 'the server-error metric excludes shedding');
    assert.equal(matches(loadFilter(CALLS), line), false, 'the denominator excludes shedding');
    assert.equal(matches(loadFilter(LATENCY), line), false, 'an instant refusal is not a latency sample');
  });
}

test('the server-error filter excludes shedding by outcome even if its class were ever server again', () => {
  const line = shedLine('shed');
  line.jsonPayload.error_class = 'server';
  assert.equal(matches(loadFilter(SERVER_ERRORS), line), false);
});

for (const reason of ['rate', 'concurrency']) {
  test(`a caller-limit ${reason} 429 stays a client refusal, outside all three metrics`, () => {
    const line = tooManyLine(reason);
    assert.equal(line.jsonPayload.outcome, 'refused');
    assert.equal(line.jsonPayload.error_class, 'client');
    assert.equal(line.jsonPayload.error_code, 'HTTP_429');
    for (const name of [SERVER_ERRORS, CALLS, LATENCY]) assert.equal(matches(loadFilter(name), line), false, name);
  });
}

// Our own eval traffic (src/guardrails/syntheticCallers.js) carries `synthetic: true` on its completion line.
// Real tool traffic is near zero, so an eval run would otherwise BE these metrics and fire (or mask) the alerts.
// Every MCP outcome metric excludes it, and an unmarked line (no field at all) is still counted.
const ALL_MCP_METRICS = fs.readdirSync(DIR).filter((f) => /^metric\.mcp_.*\.yaml$/.test(f)).map((f) => f.slice(7, -5));

test('a synthetic line is excluded from every MCP outcome metric; the same line unmarked is counted', () => {
  assert.ok(ALL_MCP_METRICS.length >= 6, ALL_MCP_METRICS.join(','));
  const zero = () => {
    const r = createMcpToolCallRecorder();
    r.recordRpcResponse({ status: 200, body: { jsonrpc: '2.0', id: 1, result: { content: [] } } });
    r.observe({ result_count: 0, upstream_degraded: true });
    return entry(r, 200);
  };
  const lines = [zero(), internalErrorLine(), answeredLine()];
  for (const name of ALL_MCP_METRICS) {
    const filter = loadFilter(name);
    assert.match(filter, /AND NOT jsonPayload\.synthetic=true/, `${name} excludes synthetic traffic`);
    const counted = lines.filter((l) => matches(filter, l));
    assert.ok(counted.length > 0, `${name}: some real line is counted (control)`);
    for (const l of counted) {
      const marked = { ...l, jsonPayload: { ...l.jsonPayload, synthetic: true } };
      assert.equal(matches(filter, marked), false, `${name}: the same line marked synthetic is not counted`);
    }
  }
});

test('the price verification metrics exclude synthetic traffic too', () => {
  const PV = path.join(__dirname, '..', 'infra', 'gcp', 'monitoring', 'price_verification');
  const names = fs.readdirSync(PV).filter((f) => /^metric\..*\.yaml$/.test(f));
  assert.ok(names.length >= 3);
  for (const f of names) {
    const filter = YAML.parse(fs.readFileSync(path.join(PV, f), 'utf8')).filter;
    const line = { resource: { type: 'cloud_run_revision', labels: { service_name: 'gateway' } }, jsonPayload: { msg: 'price_verification_served', tier: 'authenticated' } };
    assert.equal(matches(filter, line), true, `${f}: a real line is counted`);
    assert.equal(matches(filter, { ...line, jsonPayload: { ...line.jsonPayload, synthetic: true } }), false, `${f}: synthetic is not`);
  }
});
