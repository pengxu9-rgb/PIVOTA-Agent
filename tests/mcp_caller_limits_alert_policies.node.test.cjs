'use strict';

// The caller-limit alert policies in monitoring/alerts/mcp_caller_limits/, run end to end against the lines the
// real limiter writes (src/guardrails/mcpCallerLimits.js):
//
//   real WARN line -> the log metric's filter -> the metric's label extractors -> the alert policy's filter.
//
// Why: nothing alerted on SHEDDING. A shed call is logged outcome=shed / error_class=capacity, which the tool
// error-rate alert deliberately never counts, so a saturated database showed only as shedding and paged nobody;
// and nothing said when the limits had been on per-instance shares for a long time (store down, salt
// unavailable, snapshot stale). The YAML is read by a reviewer and applied by hand, never run, so this file
// runs it. Each filter is parsed clause by clause; an unrecognised clause fails the test instead of being
// skipped. Positive and negative controls on both policies.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  createCallerLimiter,
  createSaltProvider,
  logMcpCallerLimitsBootStatus,
  resolveDoorCaller,
} = require('../src/guardrails/mcpCallerLimits');
const { readCallerLimitsConfig } = require('../src/guardrails/mcpCallerLimitsConfig');

const DIR = path.join(__dirname, '..', 'monitoring', 'alerts', 'mcp_caller_limits');
const LB = '192.0.2.10';
const T0 = 1_800_000_000_000; // a window boundary (divisible by 60 000)

// ---------------- the query languages these files use ----------------

function get(obj, dotted) {
  return dotted.split('.').reduce((v, k) => (v == null ? undefined : v[k]), obj);
}

function literal(raw) {
  if (/^".*"$/.test(raw)) return JSON.parse(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  throw new Error(`unrecognised literal ${raw}`);
}

function tokenize(filter) {
  const tokens = [];
  const re = /\s*(\(|\)|AND\b|OR\b|[A-Za-z_][\w.]*\s*(?:!=|=~|=|:)\s*(?:one_of\([^)]*\)|"(?:[^"\\]|\\.)*"|\*|[^\s()]+))/y;
  let i = 0;
  const src = filter.trim();
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`unrecognised filter text at: ${src.slice(i, i + 40)}`);
    tokens.push(m[1]);
    i = re.lastIndex;
    while (i < src.length && /\s/.test(src[i])) i += 1;
  }
  return tokens;
}

function comparison(tok, entry) {
  const m = tok.match(/^([A-Za-z_][\w.]*)\s*(!=|=~|=|:)\s*(.+)$/);
  if (!m) throw new Error(`unrecognised clause: ${tok}`);
  const [, field, op, raw] = m;
  const have = get(entry, field);
  if (op === ':' && raw === '*') return have !== undefined && have !== null;
  if (raw.startsWith('one_of(')) {
    if (op !== '=') throw new Error(`one_of only with = : ${tok}`);
    const values = raw.slice(7, -1).split(',').map((v) => literal(v.trim()));
    return values.includes(have);
  }
  const want = literal(raw);
  if (op === '=') return have === want;
  if (op === '!=') return have !== undefined && have !== want;
  if (op === '=~') return typeof have === 'string' && new RegExp(want).test(have);
  throw new Error(`unsupported operator in ${tok}`);
}

/**
 * The subset of the Logging / Monitoring filter languages these files use: comparisons, parentheses, OR, and
 * AND (explicit or implied by adjacency). As in the Logging query language, OR binds tighter than AND.
 */
function matches(filter, entry) {
  const tokens = tokenize(filter);
  let pos = 0;
  function factor() {
    const tok = tokens[pos];
    if (tok === '(') {
      pos += 1;
      const v = conj();
      if (tokens[pos] !== ')') throw new Error('unbalanced parentheses');
      pos += 1;
      return v;
    }
    if (tok === undefined || tok === ')' || tok === 'AND' || tok === 'OR') throw new Error(`unexpected ${tok}`);
    pos += 1;
    return comparison(tok, entry);
  }
  function disj() {
    let v = factor();
    while (tokens[pos] === 'OR') {
      pos += 1;
      v = factor() || v;
    }
    return v;
  }
  function conj() {
    let v = disj();
    while (pos < tokens.length && tokens[pos] !== ')') {
      if (tokens[pos] === 'AND') pos += 1;
      v = disj() && v;
    }
    return v;
  }
  const out = conj();
  if (pos !== tokens.length) throw new Error('trailing filter text');
  return out;
}

// ---------------- the files ----------------

const load = (file) => YAML.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));

// The metric names the README's create commands give each metric file.
function metricNamesFromReadme() {
  const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
  const out = {};
  for (const m of readme.matchAll(/gcloud logging metrics create (\S+)\s+--config-from-file=(\S+)/g)) out[m[2]] = m[1];
  return out;
}

const NAMES = metricNamesFromReadme();

function metricOf(file) {
  const doc = load(file);
  return { file, name: NAMES[file], filter: doc.filter, extractors: doc.labelExtractors || {} };
}

// What Cloud Logging stores for one pino line on the gateway service.
function entry(line) {
  return {
    resource: { type: 'cloud_run_revision', labels: { service_name: 'gateway' } },
    severity: 'WARNING',
    jsonPayload: { ...line.obj, msg: line.msg },
  };
}

// One point of the log metric: its type and the labels its extractors pull from the entry (as strings).
function metricPoint(metric, logEntry) {
  const labels = {};
  for (const [key, expr] of Object.entries(metric.extractors)) {
    const m = String(expr).match(/^EXTRACT\(([\w.]+)\)$/);
    if (!m) throw new Error(`unsupported extractor ${expr}`);
    const v = get(logEntry, m[1]);
    if (v !== undefined && v !== null) labels[key] = String(v);
  }
  return {
    metric: { type: `logging.googleapis.com/user/${metric.name}`, label: labels, labels },
    resource: { type: logEntry.resource.type },
  };
}

function policyFilters(file) {
  const doc = load(file);
  return doc.conditions.map((c) => c.conditionThreshold.filter);
}

/** Does this real line reach the policy: counted by the metric, and passing the policy's filter? */
function pages(policyFile, metric, line) {
  const e = entry(line);
  if (!matches(metric.filter, e)) return false;
  const point = metricPoint(metric, e);
  return policyFilters(policyFile).some((f) => matches(f, point));
}

// ---------------- real producer lines ----------------

function baseEnv(extra = {}) {
  return {
    MCP_CALLER_LIMITS_MODE: 'enforce',
    MCP_CALLER_LIMITS_STORE: 'postgres',
    MCP_CALLER_LIMITS_ANON_RPM: '0',
    MCP_CALLER_LIMITS_ANON_CONCURRENCY: '0',
    MCP_CALLER_LIMITS_PARTNER_RPM: '0',
    MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '0',
    MCP_CALLER_LIMITS_ANON_TIER_RPM: '0',
    MCP_CALLER_LIMITS_ANON_TIER_CONCURRENCY_PER_INSTANCE: '0',
    MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING: '0',
    MCP_CALLER_LIMITS_SHED_PARTNER_POOL_WAITING: '0',
    MCP_CALLER_LIMITS_OAUTH_UNREGISTERED_TIER_RPM: '0',
    MCP_CALLER_LIMITS_OAUTH_UNREGISTERED_TIER_CONCURRENCY_PER_INSTANCE: '0',
    MCP_CALLER_LIMITS_EXPECTED_INSTANCES: '1',
    ...extra,
  };
}

function clock(start = T0) {
  const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

function capturingLog() {
  const lines = [];
  return { lines, warn: (obj, msg) => lines.push({ obj, msg }), info: (obj, msg) => lines.push({ obj, msg }) };
}

const anonReq = (ip) => ({ headers: { 'x-forwarded-for': `${ip}, ${LB}` }, socket: { remoteAddress: '192.0.2.20' } });
const apiKeyReq = (agentId) => ({
  headers: { 'x-forwarded-for': `203.0.113.5, ${LB}` },
  invokeAuth: { auth_mode: 'api_key', agent_id: agentId, key_fingerprint: `fp_${agentId}`, introspect_auth_source: 'api_keys' },
});
const oauthReq = (clientId) => ({
  headers: { 'x-forwarded-for': `203.0.113.6, ${LB}` },
  invokeAuth: { auth_mode: 'mcp_oauth', oauth_client_id: clientId, oauth_issuer: 'https://issuer.caller-limits-alerts.invalid' },
});
const who = (req, env) => resolveDoorCaller(req, { config: readCallerLimitsConfig(env) });

// A store that has never synced: every shared limit is on the per-instance share.
const silentStore = { kind: 'postgres', async sync() { return []; } };

/** The decision line the limiter writes for `callers` admitted in order; returns the last one's line. */
function decisionFor(envExtra, reqs, { poolStats, store = null } = {}) {
  const env = baseEnv(envExtra);
  const log = capturingLog();
  const lim = createCallerLimiter({ env, now: clock().now, store, autoSync: false, log, poolStats: poolStats || (() => null) });
  for (const req of reqs) lim.admit(who(req, env));
  const lines = log.lines.filter((l) => l.obj.event === 'mcp_caller_limit');
  assert.ok(lines.length >= 1, 'the limiter wrote a decision line');
  return lines[lines.length - 1];
}

const DECISIONS = metricOf('decisions_metric.yaml');
const STORE = metricOf('store_metric.yaml');
const SHED_POLICY = 'shed_alert_policy.yaml';
const STORE_POLICY = 'store_alert_policy.yaml';

test('the README names both metrics the policies read, and each policy reads the metric its file defines', () => {
  assert.equal(DECISIONS.name, 'mcp_caller_limit_decisions');
  assert.equal(STORE.name, 'mcp_caller_limit_store');
  assert.match(policyFilters(SHED_POLICY)[0], /user\/mcp_caller_limit_decisions"/);
  assert.match(policyFilters(STORE_POLICY)[0], /user\/mcp_caller_limit_store"/);
  const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
  for (const file of [SHED_POLICY, STORE_POLICY]) {
    assert.ok(readme.includes(`--policy-from-file=${file}`), `README creates ${file}`);
    const doc = load(file);
    assert.deepEqual(doc.notificationChannels, [], `${file}: channels are filled at create time`);
    for (const c of doc.conditions) {
      const ct = c.conditionThreshold;
      assert.equal(ct.comparison, 'COMPARISON_GT');
      assert.equal(ct.thresholdValue, 0);
      assert.equal(ct.aggregations[0].perSeriesAligner, 'ALIGN_SUM');
      // Sustained, not one burst: the condition must hold longer than one aligned window.
      assert.ok(parseInt(ct.duration, 10) > parseInt(ct.aggregations[0].alignmentPeriod, 10), `${file} is sustained`);
    }
  }
});

// ---- the shed policy ----

const SHED_CASES = {
  'shed: anonymous, pool saturated': () =>
    decisionFor({ MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING: '2' }, [anonReq('203.0.113.11')], { poolStats: () => ({ waiting: 5 }) }),
  'shed: an unregistered OAuth client, at the partner threshold': () =>
    decisionFor({ MCP_CALLER_LIMITS_SHED_PARTNER_POOL_WAITING: '2' }, [oauthReq('client_alerts_1')], { poolStats: () => ({ waiting: 5 }) }),
  'tier_concurrency: the anonymous tier full on this instance': () =>
    decisionFor({ MCP_CALLER_LIMITS_ANON_TIER_CONCURRENCY_PER_INSTANCE: '1' }, [anonReq('203.0.113.12'), anonReq('203.0.113.13')]),
  'tier_concurrency: the unregistered-OAuth tier full on this instance': () =>
    decisionFor({ MCP_CALLER_LIMITS_OAUTH_UNREGISTERED_TIER_CONCURRENCY_PER_INSTANCE: '1' }, [oauthReq('client_alerts_2'), oauthReq('client_alerts_3')]),
  'tier_rate: the anonymous tier over its rate': () =>
    decisionFor({ MCP_CALLER_LIMITS_ANON_TIER_RPM: '1' }, [anonReq('203.0.113.14'), anonReq('203.0.113.15')]),
  'tier_rate: the unregistered-OAuth tier over its rate': () =>
    decisionFor({ MCP_CALLER_LIMITS_OAUTH_UNREGISTERED_TIER_RPM: '1' }, [oauthReq('client_alerts_4'), oauthReq('client_alerts_5')]),
  'tier_rate: the per-instance share while the shared store has no fresh count': () =>
    decisionFor(
      { MCP_CALLER_LIMITS_ANON_TIER_RPM: '8', MCP_CALLER_LIMITS_EXPECTED_INSTANCES: '4' },
      [anonReq('203.0.113.16'), anonReq('203.0.113.17'), anonReq('203.0.113.18')],
      { store: silentStore },
    ),
};

for (const [label, make] of Object.entries(SHED_CASES)) {
  test(`shed policy pages on a real enforce-mode 503: ${label}`, () => {
    const line = make();
    assert.equal(line.obj.action, 'reject');
    assert.equal(line.obj.status, 503);
    assert.equal(pages(SHED_POLICY, DECISIONS, line), true);
    assert.equal(pages(STORE_POLICY, STORE, line), false, 'a decision line is not a store problem');
  });
}

test('the line facts the runbook relies on: unregistered OAuth is marked, and the per-instance share says limit_split', () => {
  const oauth = SHED_CASES['tier_rate: the unregistered-OAuth tier over its rate']();
  assert.equal(oauth.obj.reason, 'tier_rate');
  assert.equal(oauth.obj.tier, 'partner');
  assert.equal(oauth.obj.oauth_unregistered, true);
  const split = SHED_CASES['tier_rate: the per-instance share while the shared store has no fresh count']();
  assert.equal(split.obj.reason, 'tier_rate');
  assert.equal(split.obj.limit_split, true);
  assert.equal(split.obj.limit, 2, 'eight a minute across four expected instances');
  assert.equal(split.obj.store_fresh, false);
});

const NOT_SHED = {
  'a per-caller rate 429': () => decisionFor({ MCP_CALLER_LIMITS_ANON_RPM: '1' }, [anonReq('203.0.113.21'), anonReq('203.0.113.21')]),
  'a per-caller concurrency 429': () =>
    decisionFor({ MCP_CALLER_LIMITS_PARTNER_CONCURRENCY: '1' }, [apiKeyReq('agent_alerts_1'), apiKeyReq('agent_alerts_1')]),
  'observe mode: a would-be shed': () =>
    decisionFor(
      { MCP_CALLER_LIMITS_MODE: 'observe', MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING: '2' },
      [anonReq('203.0.113.22')],
      { poolStats: () => ({ waiting: 5 }) },
    ),
};

for (const [label, make] of Object.entries(NOT_SHED)) {
  test(`shed policy does not page on ${label}, though the decisions metric counts it`, () => {
    const line = make();
    assert.equal(matches(DECISIONS.filter, entry(line)), true, 'the metric still counts it');
    assert.equal(pages(SHED_POLICY, DECISIONS, line), false);
  });
}

test('shed policy: a decision line from another service is not counted', () => {
  const line = SHED_CASES['shed: anonymous, pool saturated']();
  const e = entry(line);
  e.resource.labels.service_name = 'another-service';
  assert.equal(matches(DECISIONS.filter, e), false);
});

// ---- the store policy ----

async function storeLines() {
  const c = clock(T0 + 1000);
  const log = capturingLog();
  const env = baseEnv({ MCP_CALLER_LIMITS_SYNC_MS: '2000' });
  // A sync that fails (statement timeout).
  const failing = { kind: 'postgres', async sync() { throw Object.assign(new Error('canceling statement'), { code: '57014' }); } };
  const lim = createCallerLimiter({ env, now: c.now, store: failing, autoSync: false, log });
  lim.admit(who(anonReq('203.0.113.31'), env)).release();
  await lim.syncNow();
  // The snapshot going stale while syncs back off.
  for (let i = 0; i < 20; i += 1) {
    c.advance(2000);
    lim.admit(who(anonReq('203.0.113.31'), env)).release();
    await lim.syncNow();
  }
  // A sync that succeeds but takes more than half its budget.
  const slowClock = clock(T0 + 1000);
  const slow = {
    kind: 'postgres',
    async sync() {
      slowClock.advance(60_000);
      return [];
    },
  };
  const slowLim = createCallerLimiter({ env, now: slowClock.now, store: slow, autoSync: false, log });
  slowLim.admit(who(anonReq('203.0.113.32'), env)).release();
  await slowLim.syncNow();
  // The shared salt unavailable.
  await createSaltProvider({
    store: { async getOrCreateSalt() { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); } },
    now: c.now,
    log,
  }).ready();
  return log.lines;
}

test('store policy pages on every real store, salt and stale line, each with its code', async () => {
  const lines = await storeLines();
  const seen = new Set();
  for (const line of lines) {
    if (!/^mcp_caller_limit_(store|salt|stale)$/.test(line.obj.event)) continue;
    seen.add(`${line.obj.event}:${line.obj.code}`);
    assert.equal(pages(STORE_POLICY, STORE, line), true, `${line.obj.event} ${line.obj.code}`);
    assert.equal(pages(SHED_POLICY, DECISIONS, line), false, 'a store line is not shedding');
    assert.equal(metricPoint(STORE, entry(line)).metric.labels.code, String(line.obj.code));
  }
  for (const want of ['mcp_caller_limit_store:57014', 'mcp_caller_limit_store:SYNC_SLOW', 'mcp_caller_limit_stale:SNAPSHOT_STALE', 'mcp_caller_limit_salt:ECONNREFUSED']) {
    assert.ok(seen.has(want), `${want} was produced and paged (saw ${[...seen].join(', ')})`);
  }
});

test('store policy does not page on decision, zombie or boot lines', () => {
  const decision = SHED_CASES['tier_rate: the per-instance share while the shared store has no fresh count']();
  assert.equal(pages(STORE_POLICY, STORE, decision), false);
  const log = capturingLog();
  logMcpCallerLimitsBootStatus({ selfInvokeBase: 'http://127.0.0.1:3000', log, env: baseEnv() });
  assert.equal(log.lines.length, 1);
  assert.equal(pages(STORE_POLICY, STORE, log.lines[0]), false);
  assert.equal(pages(SHED_POLICY, DECISIONS, log.lines[0]), false);
  const zombie = { obj: { event: 'mcp_caller_limit_reaped', zombie: true, door: 'mcp', tier: 'partner' }, msg: 'reaped' };
  assert.equal(pages(STORE_POLICY, STORE, zombie), false);
  assert.equal(pages(SHED_POLICY, DECISIONS, zombie), false);
});

test('the filter evaluator: OR binds tighter than AND, adjacency is AND, and unknown syntax throws', () => {
  const e = { a: 'x', b: 'y' };
  assert.equal(matches('a="x" (b="n" OR b="y")', e), true);
  assert.equal(matches('a="x" AND (b="n" OR b="m")', e), false);
  assert.equal(matches('a="z" OR a="x" b="y"', e), true, '(a="z" OR a="x") AND b="y"');
  assert.equal(matches('a=one_of("p", "x")', e), true);
  assert.throws(() => matches('a > 3', e));
  assert.throws(() => matches('NOT a="x"', e));
});
