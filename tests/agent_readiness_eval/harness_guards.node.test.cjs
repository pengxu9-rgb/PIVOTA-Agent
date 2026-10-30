'use strict';

// FIRST: no test in this directory may reach a non-loopback host (see _net_guard.cjs).
require('./_net_guard.cjs');

// The harness's own guard rails, each pinned by a test that fails if the guard is removed:
// the compiled-in tool allowlist, run-wide cancellation (and the hard exit on a second signal), the discovery
// rate and wall-clock limits, the call budget, the load-mode kill check and tool allowlist, argument
// validation, env-only secrets, and where results may be written. Every network call here goes to a loopback
// listener started by the test.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { throwingFetch } = require('./_net_guard.cjs');
const { McpClient, ALLOWED_TOOLS } = require('../../scripts/agent-readiness-eval/lib/mcpClient.cjs');
const safety = require('../../scripts/agent-readiness-eval/lib/safety.cjs');
const { resolveConfig, validateConfig } = require('../../scripts/agent-readiness-eval/lib/config.cjs');
const { runLoad } = require('../../scripts/agent-readiness-eval/lib/load.cjs');
const { loadQuerySet } = require('../../scripts/agent-readiness-eval/lib/journeys.cjs');
const { main } = require('../../scripts/agent-readiness-eval/run.cjs');

const QUERY_SET = path.join(__dirname, '..', '..', 'scripts', 'agent-readiness-eval', 'fixtures', 'queries.v1.json');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-guards-'));
const sink = () => {
  const c = [];
  return { write: (s) => { c.push(String(s)); return true; }, text: () => c.join('') };
};
const runDirOf = (base) => {
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('run_'));
  assert.equal(dirs.length, 1);
  return path.join(base, dirs[0]);
};

/** A minimal attested MCP server on loopback: search answers after `delayMs`, counting tool calls. */
async function miniServer({ delayMs = 0 } = {}) {
  const seen = { requests: 0, toolCalls: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.requests += 1;
      const rpc = JSON.parse(body || '{}');
      res.setHeader('x-pivota-deployment', 'eval-clone');
      res.setHeader('content-type', 'application/json');
      const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      if (rpc.method === 'initialize') return reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'mini', version: '0' }, capabilities: { tools: {} } });
      if (rpc.method === 'notifications/initialized') { res.statusCode = 202; return res.end(); }
      if (rpc.method === 'tools/list') {
        return reply({ tools: [{ name: 'search_catalog', inputSchema: { type: 'object', properties: { query: {}, market: {}, page_size: {}, price_max: {}, currency: {} } }, annotations: { readOnlyHint: true } }] });
      }
      seen.toolCalls += 1;
      const answer = () => reply({ structuredContent: { products: [], empty_reason: 'no_match' }, content: [{ type: 'text', text: 'none' }] });
      if (delayMs) setTimeout(answer, delayMs);
      else answer();
      return undefined;
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test('S3: McpClient.callTool refuses any tool outside the compiled-in allowlist before any I/O', async () => {
  assert.deepEqual([...ALLOWED_TOOLS], ['search_catalog', 'get_product', 'get_offers', 'get_alternatives', 'recommend_products']);
  const f = throwingFetch();
  const client = new McpClient({ endpoint: 'http://127.0.0.1:1/mcp', fetchImpl: f });
  for (const name of ['create_checkout_session', 'complete_checkout_session', 'create_payment_link', 'update_checkout_session', 'cancel_checkout_session', 'request_after_sales', 'get_order', 'start_purchase', 'SEARCH_CATALOG', '']) {
    await assert.rejects(() => client.callTool(name, {}), /not an allowed tool/, name);
  }
  assert.equal(f.calls.length, 0);
});

test('S4: stopping the run cancels an in-flight call at once, and refuses new ones without I/O', async () => {
  const srv = await miniServer({ delayMs: 5000 });
  const ks = safety.createKillSwitch({ env: {}, onSignal: false });
  try {
    const client = new McpClient({ endpoint: `${srv.base}/public/mcp`, timeoutMs: 30000, runSignal: ks.signal });
    const t0 = Date.now();
    const pending = client.callTool('search_catalog', { query: 'x' });
    setTimeout(() => ks.trip('test stop'), 100);
    const r = await pending;
    assert.equal(r.outcome, 'aborted');
    assert.ok(Date.now() - t0 < 2000, `cancelled promptly (${Date.now() - t0}ms)`);
    const before = srv.seen.requests;
    assert.equal((await client.callTool('search_catalog', { query: 'y' })).outcome, 'aborted');
    assert.equal(srv.seen.requests, before, 'nothing sent after the stop');
  } finally {
    ks.dispose();
    await srv.close();
  }
});

test('S4: the first signal stops and cancels; the second exits immediately with 130', () => {
  const exits = [];
  const ks = safety.createKillSwitch({ env: {}, onSignal: true, exit: (code) => exits.push(code) });
  try {
    ks._signal('SIGINT');
    assert.match(ks.check(), /SIGINT/);
    assert.equal(ks.signal.aborted, true);
    assert.deepEqual(exits, []);
    ks._signal('SIGTERM');
    assert.deepEqual(exits, [130]);
  } finally {
    ks.dispose();
  }
  const kf = path.join(tmp(), 'KILL');
  const ks2 = safety.createKillSwitch({ killFile: kf, env: {}, onSignal: false });
  fs.writeFileSync(kf, '');
  assert.match(ks2.check(), /kill file/);
  assert.equal(ks2.signal.aborted, true, 'the kill file also cancels in-flight work');
});

test('S5: discovery is rate-limited across workers and bounded by a wall clock', async () => {
  const srv = await miniServer();
  try {
    const out = tmp();
    const t0 = Date.now();
    const code = await main(['--base-url', srv.base, '--journeys', 'discovery', '--limit', '6', '--rps', '5', '--concurrency', '4', '--pacing-ms', '1', '--out', out], {}, { out: sink(), err: sink() });
    const elapsed = Date.now() - t0;
    assert.notEqual(code, 2);
    assert.equal(srv.seen.toolCalls, 6);
    assert.ok(elapsed >= 950, `6 calls at 5 rps take >= ~1s even with 4 workers (took ${elapsed}ms)`);
    const out2 = tmp();
    const code2 = await main(['--base-url', srv.base, '--journeys', 'discovery', '--rps', '2', '--max-wall-seconds', '1', '--pacing-ms', '1', '--out', out2], {}, { out: sink(), err: sink() });
    assert.equal(code2, 3);
    const r = JSON.parse(fs.readFileSync(path.join(runDirOf(out2), 'results.json'), 'utf8'));
    assert.match(r.metrics.run.aborted, /wall-clock limit/);
    assert.ok(r.discovery.length <= 4, `stopped by the wall clock after ${r.discovery.length} queries`);
  } finally {
    await srv.close();
  }
});

test('S5: argument validation rejects out-of-range and non-integer values', () => {
  const problems = (argv) => validateConfig(resolveConfig(['--base-url', 'http://127.0.0.1:1', ...argv], {})).join('\n');
  assert.match(problems(['--concurrency', '33']), /concurrency must be an integer in \[1, 32\]/);
  assert.match(problems(['--concurrency', '0']), /concurrency/);
  assert.match(problems(['--concurrency', '2.5']), /concurrency/);
  assert.match(problems(['--pacing-ms', '0']), /pacing-ms/);
  assert.match(problems(['--pacing-ms', '-5']), /pacing-ms/);
  assert.match(problems(['--rps', '0']), /rps/);
  assert.match(problems(['--rps', String(safety.HARD_CAPS.maxDiscoveryRps + 1)]), /rps/);
  assert.match(problems(['--timeout-ms', '-1']), /timeout-ms/);
  assert.match(problems(['--follow-top', '-1']), /follow-top/);
  assert.match(problems(['--follow-sample', '1.5']), /follow-sample/);
  assert.match(problems(['--limit', '-3']), /limit/);
  assert.match(problems(['--max-wall-seconds', '0']), /max-wall-seconds/);
  assert.equal(problems([]), '');
});

test('S2: the journey call budget stops the run (the budget can only lower the compiled-in cap)', async () => {
  const srv = await miniServer();
  try {
    const out = tmp();
    const code = await main(['--base-url', srv.base, '--journeys', 'discovery', '--rps', '50', '--pacing-ms', '1', '--out', out], {}, { out: sink(), err: sink() }, { callBudget: 3 });
    assert.equal(code, 3);
    assert.equal(srv.seen.toolCalls, 3);
    const r = JSON.parse(fs.readFileSync(path.join(runDirOf(out), 'results.json'), 'utf8'));
    assert.match(r.metrics.run.aborted, /call budget exhausted/);
  } finally {
    await srv.close();
  }
});

function loadConfig(overrides = {}) {
  const c = resolveConfig(['--base-url', 'http://127.0.0.1:1', '--load', '--page-size', '5'], {});
  c.load = { ...c.load, rpsStart: 20, rpsEnd: 20, rampSeconds: 0, holdSeconds: 5, maxConcurrency: 4, maxRequests: 1000, ...overrides };
  return c;
}

test('S2: load mode checks the kill switch every tick (a kill file mid-run stops it)', async () => {
  const srv = await miniServer();
  const kf = path.join(tmp(), 'KILL');
  const ks = safety.createKillSwitch({ killFile: kf, env: {}, onSignal: false });
  try {
    const config = loadConfig();
    setTimeout(() => fs.writeFileSync(kf, ''), 400);
    const t0 = Date.now();
    const r = await runLoad({ config, querySet: loadQuerySet(QUERY_SET), killSwitch: ks, makeClient: () => new McpClient({ endpoint: `${srv.base}/public/mcp`, runSignal: ks.signal }) });
    assert.match(r.stopped_by, /kill file/);
    assert.ok(Date.now() - t0 < 2500, 'stopped long before the 5s schedule');
    assert.ok(srv.seen.toolCalls > 0 && srv.seen.toolCalls < 60);
  } finally {
    ks.dispose();
    await srv.close();
  }
});

test('S2: load mode refuses tools outside its allowlist before creating any client', async () => {
  let made = 0;
  const ks = safety.createKillSwitch({ env: {}, onSignal: false });
  await assert.rejects(
    () => runLoad({ config: loadConfig({ tools: ['get_product'] }), querySet: loadQuerySet(QUERY_SET), killSwitch: ks, makeClient: () => { made += 1; return null; } }),
    /supports only search_catalog/,
  );
  assert.equal(made, 0);
  ks.dispose();
});

test('S9: secrets are env-only, the breaker window must be >= 1', () => {
  for (const flag of ['--caller-keys', '--api-key', '--bearer-token']) {
    assert.match(validateConfig(resolveConfig(['--base-url', 'http://127.0.0.1:1', flag, 'x'], {})).join('\n'), /secrets come from env only/, flag);
  }
  assert.equal(resolveConfig(['--caller-keys', 'k1'], {}).secrets.callerKeys.length, 0, 'never read from argv');
  const base = loadConfig().load;
  assert.match(safety.checkLoad({ ...base, breakerWindow: 0 }).problems.join(), /breaker window/);
  assert.match(safety.checkLoad({ ...base, breakerWindow: 2.5 }).problems.join(), /breaker window/);
  assert.equal(safety.checkLoad({ ...base, breakerWindow: 1 }).ok, true);
});

test('S10: results are refused inside a git checkout; each run gets its own new directory', async () => {
  // A unique path, removed in `finally`: if the refusal were ever broken, this test must not leave results in the
  // repository (or poison later runs).
  const repoOut = path.join(__dirname, `should-never-exist-${process.pid}-${Date.now()}`);
  try {
    const io = { out: sink(), err: sink() };
    const f = throwingFetch();
    assert.equal(await main(['--base-url', 'http://127.0.0.1:1', '--out', repoOut], {}, io, { fetchImpl: f }), 2);
    assert.match(io.err.text(), /inside a git checkout/);
    assert.equal(fs.existsSync(repoOut), false);
    assert.equal(f.calls.length, 0);
  } finally {
    fs.rmSync(repoOut, { recursive: true, force: true });
  }
  const srv = await miniServer();
  try {
    const out = tmp();
    for (let i = 0; i < 2; i += 1) {
      await main(['--base-url', srv.base, '--journeys', 'discovery', '--limit', '1', '--rps', '50', '--pacing-ms', '1', '--out', out], {}, { out: sink(), err: sink() });
    }
    const dirs = fs.readdirSync(out).filter((d) => d.startsWith('run_'));
    assert.equal(dirs.length, 2, 'two runs, two directories, nothing overwritten');
  } finally {
    await srv.close();
  }
});
