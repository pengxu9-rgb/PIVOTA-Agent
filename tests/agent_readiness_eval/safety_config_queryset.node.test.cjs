'use strict';

// The readiness eval's guard rails: target refusal (production is refused until a server-side synthetic
// designation exists), hard load caps, the kill switch, config/secret handling, schema-driven argument
// building, the read-only tool policy, SLO evaluation and the query set's composition.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveConfig, validateConfig, redactConfig, DEFAULT_SLOS } = require('../../scripts/agent-readiness-eval/lib/config.cjs');
const safety = require('../../scripts/agent-readiness-eval/lib/safety.cjs');
const { argsForSchema, classifyTools, loadQuerySet, planCalls } = require('../../scripts/agent-readiness-eval/lib/journeys.cjs');
const { evaluateSlos, overallVerdict } = require('../../scripts/agent-readiness-eval/lib/report.cjs');
const { judgePayload, runJudge } = require('../../scripts/agent-readiness-eval/lib/judge.cjs');
const { targetRps, callerIdentities } = require('../../scripts/agent-readiness-eval/lib/load.cjs');
const { build } = require('../../scripts/agent-readiness-eval/fixtures/build_query_set.cjs');

const QUERY_SET = path.join(__dirname, '..', '..', 'scripts', 'agent-readiness-eval', 'fixtures', 'queries.v1.json');
const cfg = (argv, env = {}) => resolveConfig(argv, env);

test('local development hosts are accepted without ceremony', () => {
  for (const url of ['http://127.0.0.1:3000', 'http://localhost:8080', 'http://[::1]:3000', 'http://gw.localhost', 'http://gateway.test']) {
    const r = safety.checkTarget(cfg(['--base-url', url]));
    assert.equal(r.ok, true, `${url}: ${r.problems.join('; ')}`);
  }
});

test('a non-local host needs --allow-remote-target and a non-local target kind', () => {
  const r = safety.checkTarget(cfg(['--base-url', 'https://clone.example.net']));
  assert.equal(r.ok, false);
  const ok = safety.checkTarget(cfg(['--base-url', 'https://clone.example.net', '--allow-remote-target', '--target-kind', 'prod-clone']));
  assert.equal(ok.ok, true, ok.problems.join('; '));
});

test('production hosts are REFUSED today, whatever flags are passed', () => {
  const argv = [
    '--base-url', 'https://agent.pivota.cc', '--tier', 'commerce', '--allow-remote-target',
    '--target-kind', 'prod-synthetic', '--synthetic-flag-ack', safety.SYNTHETIC_FLAG_ACK,
  ];
  const r = safety.checkTarget(cfg(argv, { READINESS_EVAL_API_KEY: 'k' }));
  assert.equal(safety.SYNTHETIC_TRAFFIC_SERVER_SUPPORT, false);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /synthetic-traffic designation does not exist yet/);
  for (const host of ['mcp.pivota.cc', 'api.pivota.cc', 'pivota.cc', 'x.pivota.ai']) {
    assert.equal(safety.isProductionHost(host), true, host);
  }
  assert.equal(safety.isProductionHost('notpivota.cc'), false);
  // A Host header naming production from a remote IP is judged as production too.
  const viaIp = safety.checkTarget(cfg(['--base-url', 'https://203.0.113.10', '--host-header', 'mcp.pivota.cc', '--allow-remote-target', '--target-kind', 'prod-clone']));
  assert.equal(viaIp.ok, false);
});

test('load settings beyond the compiled-in caps are refused', () => {
  const base = cfg(['--load', '--base-url', 'http://127.0.0.1:1']).load;
  assert.equal(safety.checkLoad(base).ok, true);
  assert.equal(safety.checkLoad({ ...base, rpsEnd: safety.HARD_CAPS.maxRps + 1 }).ok, false);
  assert.equal(safety.checkLoad({ ...base, maxConcurrency: safety.HARD_CAPS.maxConcurrency + 1 }).ok, false);
  assert.equal(safety.checkLoad({ ...base, maxRequests: safety.HARD_CAPS.maxLoadRequests + 1 }).ok, false);
  assert.equal(safety.checkLoad({ ...base, holdSeconds: safety.HARD_CAPS.maxLoadSeconds }).ok, false);
  assert.equal(cfg([]).load.enabled, false, 'load mode is off by default');
});

test('kill switch: env at start, kill file, manual trip', () => {
  assert.match(safety.createKillSwitch({ env: { READINESS_EVAL_KILL: '1' }, onSignal: false }).check(), /READINESS_EVAL_KILL/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rekill-'));
  const killFile = path.join(dir, 'KILL');
  const ks = safety.createKillSwitch({ killFile, env: {}, onSignal: false });
  assert.equal(ks.check(), null);
  fs.writeFileSync(killFile, '');
  assert.match(ks.check(), /kill file/);
  const ks2 = safety.createKillSwitch({ env: {}, onSignal: false });
  ks2.trip('breaker');
  assert.equal(ks2.check(), 'breaker');
});

test('config: secrets come from env only and are redacted; flags override env; SLO overrides', () => {
  const c = cfg(['--tier', 'commerce', '--slo', 'search_p95_ms_max=5000', '--slo', 'missing_price_max=off'], {
    READINESS_EVAL_BASE_URL: 'http://127.0.0.1:3000',
    READINESS_EVAL_API_KEY: 'ak_live_secret',
    READINESS_EVAL_CALLER_KEYS: 'k1,k2',
    READINESS_EVAL_TIER: 'public',
  });
  assert.equal(c.tier, 'commerce');
  assert.equal(c.endpoint, 'http://127.0.0.1:3000/mcp');
  assert.equal(c.auth, 'api_key');
  assert.equal(c.slos.search_p95_ms_max, 5000);
  assert.equal(c.slos.missing_price_max, null);
  assert.deepEqual(validateConfig(c), []);
  const red = JSON.stringify(redactConfig(c));
  assert.equal(red.includes('ak_live_secret'), false);
  assert.equal(red.includes('k1'), false);
  assert.match(red, /<2 keys>/);
  assert.ok(c.outDir.startsWith(os.tmpdir()), 'results default outside the (public) repo');
  assert.match(validateConfig(cfg(['--slo', 'bogus=1'])).join(), /unknown --slo/);
  assert.match(validateConfig(cfg(['--tier', 'commerce'], { READINESS_EVAL_BASE_URL: 'http://127.0.0.1:1' })).join(), /READINESS_EVAL_API_KEY/);
});

test('argsForSchema keeps only declared properties and reports missing required ones', () => {
  const tool = { inputSchema: { type: 'object', required: ['product_id'], properties: { product_id: {}, merchant_id: {} } } };
  assert.deepEqual(argsForSchema(tool, { product_id: 'p', merchant_id: undefined, market: 'US' }), { args: { product_id: 'p' }, dropped: ['market'], missingRequired: [] });
  assert.deepEqual(argsForSchema(tool, { merchant_id: 'm' }).missingRequired, ['product_id']);
});

test('only tools annotated readOnlyHint:true are callable; mutating tools are skipped with a reason', () => {
  const { callable, skipped } = classifyTools([
    { name: 'search_catalog', annotations: { readOnlyHint: true } },
    { name: 'create_checkout_session', annotations: { readOnlyHint: false, destructiveHint: false } },
    { name: 'complete_checkout_session', annotations: {} },
    { name: 'mystery_tool' },
  ]);
  assert.deepEqual([...callable.keys()], ['search_catalog']);
  assert.deepEqual(skipped.map((s) => s.tool), ['create_checkout_session', 'complete_checkout_session', 'mystery_tool']);
  assert.match(skipped[0].reason, /never calls it/);
});

test('SLO evaluation: pass / fail / no_data / off, and the overall verdict', () => {
  const metrics = {
    availability: { availability: 0.999, tool_error_rate: 0.02 },
    search: { latency: { p95: 1200 }, in_catalog_zero_result_rate: 0.05, relevance_pass_rate: 0.95, duplicate_query_rate: 0 },
    rows_gated: { currency_market_mismatch: 0, price_problem_total: 3, missing_link: 0 },
    negative: { pass_rate: 1 },
    consistency: { stable_rate: null },
    follow: { offer_search_price_agreement: 1, chain_resolve_rate: 1 },
  };
  const res = evaluateSlos(metrics, { ...DEFAULT_SLOS, duplicate_query_rate_max: null });
  const by = Object.fromEntries(res.map((r) => [r.key, r.status]));
  assert.equal(by.availability_min, 'pass');
  assert.equal(by.tool_error_rate_max, 'fail');
  assert.equal(by.missing_price_max, 'fail');
  assert.equal(by.consistency_stable_rate_min, 'no_data');
  assert.equal(by.duplicate_query_rate_max, 'off');
  assert.equal(overallVerdict(res, {}), 'fail');
  assert.equal(overallVerdict(res, { aborted: 'x' }), 'aborted');
});

test('LLM judge payload carries only the query and allowlisted product fields', async () => {
  const product = { id: 'sig_secret', merchant_id: 'merch_secret', title: 'Lipstick', brand: 'B', category: 'Lips', link: 'https://x.example/r?token=t', actives: ['A'], price: { amount: 5, currency: 'USD', currencyValid: true }, description: 'long text' };
  const payload = judgePayload({ id: 'q1', text: 'red lipstick', lang: 'en', market: 'US', expect: {} }, [product]);
  const s = JSON.stringify(payload);
  for (const leaked of ['sig_secret', 'merch_secret', 'token', 'long text', 'q1']) assert.equal(s.includes(leaked), false, leaked);
  assert.deepEqual(Object.keys(payload.products[0]).sort(), ['actives', 'brand', 'category', 'price', 'title']);
  const out = await runJudge(async () => ({ scores: [0.9] }), { text: 'x' }, [product]);
  assert.equal(out.precision, 1);
  const failed = await runJudge(async () => { throw new Error('judge down'); }, { text: 'x' }, [product]);
  assert.match(failed.error, /judge down/);
});

test('load schedule ramps linearly then holds; one identity per caller key', () => {
  const load = { rpsStart: 1, rpsEnd: 5, rampSeconds: 10 };
  assert.equal(targetRps(load, 0), 1);
  assert.equal(targetRps(load, 5), 3);
  assert.equal(targetRps(load, 30), 5);
  const ids = callerIdentities(cfg(['--tier', 'commerce'], { READINESS_EVAL_CALLER_KEYS: 'k1,k2,k3' }));
  assert.deepEqual(ids.map((i) => i.label), ['caller_1', 'caller_2', 'caller_3']);
  assert.equal(new Set(ids.map((i) => i.fp)).size, 3);
  assert.equal(JSON.stringify(ids.map(({ secret, ...rest }) => rest)).includes('k1'), false);
});

test('query set: >= 300 queries, every class / language / market represented, builder in sync', () => {
  const onDisk = fs.readFileSync(QUERY_SET, 'utf8');
  assert.equal(onDisk, `${JSON.stringify(build(), null, 2)}\n`, 'queries.v1.json is stale: run build_query_set.cjs');
  const set = loadQuerySet(QUERY_SET);
  assert.ok(set.queries.length >= 300, `${set.queries.length} queries`);
  const classes = new Set(set.queries.map((q) => q.class));
  for (const c of ['makeup_shade', 'skincare_concern', 'skincare_ingredient', 'ingredient_bare', 'negation', 'brand', 'price_capped', 'negative_non_beauty', 'negative_nonsense', 'negative_unsafe']) {
    assert.ok(classes.has(c), c);
  }
  const langs = new Set(set.queries.map((q) => q.lang));
  for (const l of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'fr', 'es']) assert.ok(langs.has(l), l);
  const markets = new Set(set.queries.map((q) => q.market));
  for (const m of ['US', 'SG', null]) assert.ok(markets.has(m), String(m));
  for (const q of set.queries) {
    assert.ok(q.expect && typeof q.expect.in_catalog === 'boolean', `${q.id} has expectations`);
    assert.equal('product_id' in q.expect, false, 'expected properties, never expected products');
    if (q.expect.negative) assert.equal(q.expect.in_catalog, false);
    else assert.ok(q.expect.category || q.expect.ingredients || q.expect.brand, `${q.id} constrains something`);
  }
  assert.ok(set.recommend.length >= 10);
});

test('dry-run plan counts calls without making any', () => {
  const set = loadQuerySet(QUERY_SET);
  const plan = planCalls(cfg(['--limit', '10', '--follow-top', '1', '--consistency-sample', '3', '--consistency-repeats', '2']), set);
  assert.equal(plan.queries, 10);
  assert.equal(plan.calls_upper_bound.search_catalog, 16);
  assert.equal(plan.calls_upper_bound.get_product, 10);
});
