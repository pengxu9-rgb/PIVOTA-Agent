'use strict';

// FIRST: no test in this directory may reach a non-loopback host (see _net_guard.cjs).
require('./_net_guard.cjs');

// END TO END against a local stub MCP server — the harness CLI (run.cjs main) over real HTTP.
//
// The stub is not a hand-rolled imitation of the wire: it mounts the gateway's OWN MCP machinery —
// mcp-server/src/remoteMcpAdapter.js over createPublicReadToolSurface (the /public/mcp tier) and
// createCommerceToolSurface (the /mcp door) — so framing, tools/list schemas, annotations, argument guards,
// projection and error mapping are the production code paths. Only the canonical executor underneath is a
// fake, answering from an invented in-memory catalog with deliberately planted defects, so the test proves
// the harness catches them.
//
// The stub also records every request it receives, which is how this test proves the harness never calls a
// mutating tool and never follows a product/offer link.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main } = require('../../scripts/agent-readiness-eval/run.cjs');
const { throwingFetch } = require('./_net_guard.cjs');

const API_KEY = `ak_live_${'c'.repeat(64)}`;
const CALLER_KEYS = [`ak_live_${'1'.repeat(64)}`, `ak_live_${'2'.repeat(64)}`];

// ---- an invented catalog with planted defects ------------------------------------------------------------
function catalog(linkBase) {
  const row = (id, title, category, priceUsd, extra = {}) => ({
    product_id: id,
    merchant_id: 'merch_stub_1',
    title,
    brand: extra.brand || 'Stubco',
    category,
    product_type: category,
    price: priceUsd,
    currency: 'USD',
    availability: 'in_stock',
    in_stock: true,
    pivota_url: `${linkBase}/products/${id}`,
    url: `${linkBase}/products/${id}`,
    ...extra,
  });
  return [
    row('sig_stub_lip_red', 'Velvet Matte Lipstick Classic Red', 'lipstick', 14, { variants: [{ title: 'Classic Red' }, { title: 'Brick' }] }),
    row('sig_stub_lip_nude', 'Satin Lipstick Nude Rose', 'lipstick', 24, { variants: [{ title: 'Nude Rose' }] }),
    row('sig_stub_found', 'Skin Tint Foundation Warm Undertone', 'foundation', 28),
    row('sig_stub_blush', 'Cream Blush Peach', 'blush', 12),
    row('sig_stub_liner', 'Waterproof Gel Eyeliner Black', 'eyeliner', 9),
    row('sig_stub_nia', '10% Niacinamide Serum', 'serum', 11, { active_ingredients: ['Niacinamide'] }),
    row('sig_stub_ret', 'Gentle Retinol Night Cream', 'moisturizer', 32, { active_ingredients: ['Retinol'] }),
    row('sig_stub_moist', 'Fragrance-Free Daily Moisturizer', 'moisturizer', 16),
    row('sig_stub_spf', 'Mineral Sunscreen SPF 50', 'sunscreen', 18, { active_ingredients: ['Zinc Oxide'] }),
    // PLANTED: no price at all.
    row('sig_stub_noprice', 'Hydrating Toner', 'toner', null),
    // PLANTED: a malformed link.
    row('sig_stub_badlink', 'Foaming Cleanser', 'cleanser', 10, { pivota_url: `${linkBase}/products/undefined` }),
  ];
}

const NON_BEAUTY = /laptop|tires|dog food|chair|shoes|speaker|hose|coffee|phone|bicycle|asdf|qwerty|xyzzy|lorem|mercury|hydroquinone|clobetasol|kohl|injection|melanotan|tca/i;

function makeExecutor(rows, executed) {
  const tokens = (q) => String(q || '').toLowerCase().split(/[^a-z0-9%]+/).filter((t) => t.length > 2);
  const priceFor = (r, market) => {
    if (r.price == null) return { price: null, currency: null };
    // PLANTED: the SG market is served the USD number relabelled for one product (currency != market).
    if (market === 'SG') return r.product_id === 'sig_stub_lip_red' ? { price: r.price, currency: 'USD' } : { price: Math.round(r.price * 135) / 100, currency: 'SGD' };
    return { price: r.price, currency: 'USD' };
  };
  return {
    async execute(opId, params) {
      executed.push(opId);
      const p = params && params.payload ? params.payload : {};
      if (opId === 'search_catalog') {
        const s = p.search || {};
        const market = s.market || null;
        if (NON_BEAUTY.test(s.query || '')) return { status: 'success', success: true, products: [], total: 0, metadata: { strict_empty_reason: 'off_vertical' } };
        const ts = tokens(s.query);
        let hits = rows.filter((r) => ts.some((t) => `${r.title} ${r.category} ${(r.active_ingredients || []).join(' ')}`.toLowerCase().includes(t)));
        if (typeof s.price_max === 'number') hits = hits.filter((r) => r.price != null && r.price <= s.price_max);
        const products = hits.map((r) => ({ ...r, ...priceFor(r, market) }));
        // PLANTED: "blush" answers a degraded envelope that still carries hits.
        if (/blush/i.test(s.query || '')) return { status: 'failed', success: false, products, total: products.length, metadata: {} };
        return { status: 'success', success: true, products, total: products.length, metadata: products.length ? {} : { strict_empty_reason: 'no_candidates' } };
      }
      if (opId === 'get_product') {
        const id = p.product && p.product.product_id;
        const r = rows.find((x) => x.product_id === id);
        return r ? { product: { ...r, description: `${r.title}.` } } : { note: 'not found' };
      }
      if (opId === 'get_offers') {
        const r = rows.find((x) => x.product_id === p.product_id);
        if (!r || r.price == null) return { subject: { id: p.product_id }, best_offer: null, signals: [], metadata: { reason: 'no_offers' } };
        const { price, currency } = priceFor(r, p.market);
        const sig = { type: 'offer', value: { merchant_id: r.merchant_id, price, currency, in_stock: true, availability: 'in_stock', affiliate_url: `${r.url}?offer=1` } };
        return { subject: { id: r.product_id }, best_offer: sig, signals: [sig], metadata: { offer_count: 1, ...(p.market ? { market: p.market, market_currency: p.market === 'SG' ? 'SGD' : 'USD' } : {}) } };
      }
      if (opId === 'get_alternatives') {
        return { subject: { id: p.product_id }, signals: [], metadata: { reason: 'no_reviewed_alternatives' } };
      }
      if (opId === 'recommend_products') {
        const pick = rows.filter((r) => tokens(p.need).some((t) => r.title.toLowerCase().includes(t))).slice(0, 3);
        return {
          signals: pick.map((r) => ({ type: 'recommendation', value: { product: { product_id: r.product_id, title: r.title, brand: r.brand, category: r.category, price: r.price, currency: 'USD', url: r.url } } })),
          metadata: pick.length ? { confidence_basis: 'positional' } : { products_empty_reason: 'no_match' },
        };
      }
      throw new Error(`stub executor: unexpected op ${opId}`);
    },
  };
}

async function startStub({ perCallerLimit = Infinity } = {}) {
  const { createRemoteMcpAdapter } = await import('../../mcp-server/src/remoteMcpAdapter.js');
  const { createPublicReadToolSurface, formatPublicReadToolResult } = await import('../../mcp-server/src/publicReadToolSurface.js');
  const { createCommerceToolSurface } = await import('../../mcp-server/src/commerceToolSurface.js');
  const seen = { requests: [], toolCalls: [], executed: [] };
  const perCaller = new Map();
  let base = '';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      seen.requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(obj == null ? '' : JSON.stringify(obj));
      };
      if (req.method !== 'POST' || !['/public/mcp', '/mcp'].includes(req.url)) return send(404, { error: 'not_found' });
      let parsed;
      try { parsed = JSON.parse(body); } catch { return send(400, { error: 'bad json' }); }
      if (parsed.method === 'tools/call') seen.toolCalls.push({ door: req.url, name: parsed.params && parsed.params.name, key: req.headers['x-agent-api-key'] || null });
      const adapter = req.url === '/public/mcp' ? stub.publicAdapter : stub.commerceAdapter;
      if (req.url === '/mcp') {
        const key = req.headers['x-agent-api-key'];
        if (![API_KEY, ...CALLER_KEYS].includes(key)) return send(401, { error: 'UNAUTHORIZED' });
        if (parsed.method === 'tools/call') {
          const n = (perCaller.get(key) || 0) + 1;
          perCaller.set(key, n);
          if (n > perCallerLimit && key === CALLER_KEYS[1]) return send(429, { error: 'rate_limited' });
        }
      }
      const out = await adapter.handleJsonRpc({ headers: req.headers, body: parsed });
      res.writeHead(out.status, out.headers || {});
      res.end(out.body == null ? '' : JSON.stringify(out.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const rows = catalog(`${base}`);
  const executor = makeExecutor(rows, seen.executed);
  const stub = {
    base,
    seen,
    server,
    publicAdapter: createRemoteMcpAdapter(createPublicReadToolSurface(executor, {}), {
      allowUnauthenticated: true,
      serverInfo: { name: 'pivota', version: '1.0.0' },
      supportedProtocolVersions: ['2025-03-26', '2025-06-18'],
      resolveSessionContext: () => ({}),
      formatResult: formatPublicReadToolResult,
    }),
    commerceAdapter: createRemoteMcpAdapter(createCommerceToolSurface(executor, {}), {
      serverInfo: { name: 'pivota-commerce-mcp', version: '0.1.0' },
      authenticate: async () => ({ sessionContext: {} }),
      resolveSessionContext: () => ({}),
    }),
    close: () => new Promise((r) => server.close(r)),
  };
  return stub;
}

function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-e2e-'));

test('public tier: full query set end to end; planted defects are caught; nothing but /public/mcp is requested', async () => {
  const stub = await startStub();
  try {
    const out = tmp();
    const io = { out: sink(), err: sink() };
    const code = await main(['--base-url', stub.base, '--tier', 'public', '--pacing-ms', '0', '--concurrency', '4', '--out', out], {}, io);
    assert.ok([0, 1].includes(code), `exit ${code}: ${io.err.text()}`);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
    const m = report.metrics;
    assert.equal(m.run.handshake.outcome, 'ok');
    assert.equal(m.run.handshake.protocol_version, '2025-06-18');
    assert.ok(report.discovery.length >= 300, `${report.discovery.length} queries`);
    assert.equal(m.availability.availability, 1);
    // Planted: degraded envelope with hits ("blush" queries) — the public tier projects it, so this door
    // shows it only as products; the commerce test below asserts the envelope flag.
    assert.ok(m.search.empty_class.no_match > 0 || m.search.empty_class.upstream_degraded > 0);
    // Planted: SG relabelled USD price, missing price, malformed link.
    assert.ok(m.rows.search.currency_market_mismatch > 0, 'currency != market detected');
    assert.ok(m.rows_gated.price_problem_total > 0, 'missing price detected');
    // The public projection builds pivota_url from the product id (publicReadProjection pdpUrl), so the planted
    // malformed row link never reaches this tier; the commerce test asserts it is caught where it does.
    assert.equal(m.rows.search.missing_link, 0);
    assert.equal(report.slos.find((s) => s.key === 'currency_market_mismatch_max').status, 'fail');
    // Negative controls answered empty by the stub.
    assert.equal(m.negative.pass_rate, 1);
    // Public tier: get_offers / recommend_products are not advertised.
    const skipped = m.run.skipped_tools.map((s) => s.tool);
    assert.ok(skipped.includes('get_offers') && skipped.includes('recommend_products'));
    assert.ok(m.follow.products_followed > 0);
    assert.equal(m.follow.chain_resolve_rate, 1);
    assert.ok(m.consistency.sampled > 0);
    assert.equal(m.consistency.stable_rate, 1);
    // Every request went to the MCP door; no link was ever fetched.
    assert.ok(stub.seen.requests.length > 300);
    assert.ok(stub.seen.requests.every((r) => r.method === 'POST' && r.url === '/public/mcp'), 'only POST /public/mcp');
    assert.ok(stub.seen.requests.every((r) => r.headers['x-pivota-synthetic-traffic'] === 'readiness-eval'));
    for (const f of ['scorecard.md', 'scorecard.html']) assert.ok(fs.statSync(path.join(out, f)).size > 500, f);
    const md = fs.readFileSync(path.join(out, 'scorecard.md'), 'utf8');
    assert.match(md, /## SLOs/);
    assert.match(md, /By language/);
    assert.match(md, /zh-Hant/);
  } finally {
    await stub.close();
  }
});

test('commerce tier: API key auth, follow-through incl. offers + recommend, checkout tools never called, failed-with-hits counted', async () => {
  const stub = await startStub();
  try {
    const out = tmp();
    const io = { out: sink(), err: sink() };
    const code = await main(
      ['--base-url', stub.base, '--tier', 'commerce', '--pacing-ms', '0', '--concurrency', '4', '--classes', 'makeup_shade,skincare_ingredient,negative_non_beauty', '--markets', 'US,SG', '--out', out],
      { READINESS_EVAL_API_KEY: API_KEY },
      io,
    );
    assert.ok([0, 1].includes(code), `exit ${code}: ${io.err.text()}`);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
    const m = report.metrics;
    assert.ok(m.search.failed_with_hits > 0, '"failed" envelopes carrying hits are counted');
    assert.ok(m.by_tool.get_offers.calls > 0);
    assert.ok(m.by_tool.recommend_products.calls > 0);
    assert.ok(m.follow.offer_search_price_compared > 0);
    assert.ok(m.rows.offers.currency_market_mismatch > 0, 'SG offer in USD detected');
    assert.ok(m.rows.search.missing_link > 0, 'malformed link detected (the commerce door passes row links through)');
    const called = new Set(stub.seen.toolCalls.map((c) => c.name));
    for (const t of ['create_checkout_session', 'update_checkout_session', 'complete_checkout_session', 'create_payment_link', 'cancel_checkout_session', 'request_after_sales']) {
      assert.equal(called.has(t), false, `${t} must never be called`);
      assert.ok(m.run.skipped_tools.some((s) => s.tool === t), `${t} reported as skipped`);
    }
    assert.ok(stub.seen.toolCalls.every((c) => c.key === API_KEY));
    assert.ok(stub.seen.requests.every((r) => r.url === '/mcp'));
    // The raw report never carries the API key.
    assert.equal(fs.readFileSync(path.join(out, 'results.json'), 'utf8').includes(API_KEY), false);
  } finally {
    await stub.close();
  }
});

test('load mode: per-caller sessions, per-caller 429s attributed, bounded by max requests', async () => {
  const stub = await startStub({ perCallerLimit: 3 });
  try {
    const out = tmp();
    const io = { out: sink(), err: sink() };
    const code = await main(
      ['--base-url', stub.base, '--tier', 'commerce', '--journeys', 'discovery', '--limit', '2', '--pacing-ms', '0',
        '--load', '--rps-start', '20', '--rps-end', '20', '--ramp-seconds', '0', '--hold-seconds', '3', '--max-requests', '24', '--load-concurrency', '8', '--out', out],
      { READINESS_EVAL_API_KEY: API_KEY, READINESS_EVAL_CALLER_KEYS: CALLER_KEYS.join(',') },
      io,
    );
    assert.ok([0, 1].includes(code), `exit ${code}: ${io.err.text()}`);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).metrics;
    assert.equal(m.load.sent, 24);
    assert.match(m.load.stopped_by, /max requests/);
    assert.equal(m.load.per_caller.caller_1.rate_limited, 0);
    assert.ok(m.load.per_caller.caller_2.rate_limited > 0, 'the limited caller sees 429s');
    const loadKeys = new Set(stub.seen.toolCalls.slice(-24).map((c) => c.key));
    assert.deepEqual([...loadKeys].sort(), [...CALLER_KEYS].sort());
  } finally {
    await stub.close();
  }
});

test('kill switch at start: no tool is called; dry-run makes no request at all; diff runs', async () => {
  const stub = await startStub();
  try {
    const io = { out: sink(), err: sink() };
    const out = tmp();
    const code = await main(['--base-url', stub.base, '--pacing-ms', '0', '--out', out], { READINESS_EVAL_KILL: '1' }, io);
    assert.equal(code, 3);
    assert.equal(stub.seen.toolCalls.length, 0);
    const before = stub.seen.requests.length;
    const dry = { out: sink(), err: sink() };
    assert.equal(await main(['--dry-run', '--base-url', stub.base], {}, dry), 0);
    assert.equal(stub.seen.requests.length, before, 'dry-run is offline');
    assert.match(dry.out.text(), /no network calls made/);
    // Two small real runs, then diff.
    const a = tmp();
    const b = tmp();
    await main(['--base-url', stub.base, '--limit', '12', '--journeys', 'discovery', '--pacing-ms', '0', '--out', a], {}, { out: sink(), err: sink() });
    await main(['--base-url', stub.base, '--limit', '12', '--journeys', 'discovery', '--pacing-ms', '0', '--out', b, '--diff-against', path.join(a, 'results.json')], {}, { out: sink(), err: sink() });
    const diffed = JSON.parse(fs.readFileSync(path.join(b, 'results.json'), 'utf8')).diff;
    assert.ok(Array.isArray(diffed.headline) && diffed.headline.length > 5);
    assert.deepEqual(diffed.changes.became_empty, []);
    const cli = { out: sink(), err: sink() };
    assert.equal(await main(['diff', path.join(a, 'results.json'), path.join(b, 'results.json')], {}, cli), 0);
    assert.match(cli.out.text(), /headline/);
  } finally {
    await stub.close();
  }
});

test('a non-allowed host is refused before any request is made (injected throwing fetch; unresolvable name)', async () => {
  // NEVER a real hostname through main(): the refusal is asserted with a fetch that throws and counts, against
  // a name that cannot resolve. The production-hostname cases are pure classifier unit tests
  // (safety_config_queryset), which make no request at all.
  const fetchImpl = throwingFetch();
  const io = { out: sink(), err: sink() };
  const code = await main(['--base-url', 'https://prod-refusal-check.invalid', '--tier', 'public'], {}, io, { fetchImpl });
  assert.equal(code, 2);
  assert.match(io.err.text(), /REFUSED/);
  assert.equal(fetchImpl.calls.length, 0, 'the refused run made no request');
});
