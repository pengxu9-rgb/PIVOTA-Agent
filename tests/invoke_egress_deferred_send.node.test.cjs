'use strict';

// Review GD-1 / GD-2 on the legacy seed-id drop (FIX_PLAN D-06): the invoke egress holds a search response
// while it asks the database which legacy rows no lane can open.
//
// GD-1. While it waits, `res.headersSent` reads false. A handler that then answers again (its catch block, the
// error middleware) used to get ITS body to the client, and the deferred send then threw "Cannot set headers
// after they are sent" as an unhandled rejection, which kills this process (it installs no handler). These
// tests run the real sequence through express and the real installInvokeEgress + finalizeInvokeSearchBody:
// exactly one response leaves, it is the first one, and nothing rejects.
//
// GD-2. The drop asks once per page, under one total deadline that fails open, and remembers answers briefly.
// With a hung database the added latency is bounded by the deadline, and the page equals the fail-open page.
//
// All store and product names are placeholders.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

const http = require('node:http');
const {
  LEGACY_SEED_PROBE_HEADER,
  LEGACY_SEED_PROBE_HOP_HEADER,
  finalizeInvokeSearchBody,
  installInvokeEgress,
  isInvokeResponseCommitted,
  isLegacySeedProbeHop,
  legacySeedProbeHopHeaders,
} = require('../src/invokeEgress');
const {
  LEGACY_SEED_DETAIL_MATCH_CLAUSE,
  LEGACY_SEED_OPENABLE_BATCH_SQL,
  LEGACY_SEED_OPENABLE_CLAUSE,
  SERVED_SEED_CURRENCIES,
  confirmNoOpenableLegacySeeds,
  createLegacySeedProbeBackoff,
  createLegacySeedProbeCache,
  dropUnopenableLegacySeedRows,
  legacySeedProbeDeadlineMs,
  legacySeedProbeCacheTtlMs,
  legacySeedProbeFailureBackoffMs,
  legacySeedDetailDbBudgetMs,
  projectLegacySeedRows,
  __internal: legacySeedInternal,
} = require('../src/services/legacySeedIdServability');
const { seedCurrencySql } = require('../src/services/seedSearchOfferScope');

const SHARED = 'external_seed';
const legacyRow = (n) => ({
  product_id: `shop-a:${n.toString(16).padStart(16, '0')}`,
  merchant_id: SHARED,
  title: `Placeholder item ${n}`,
});
const OPEN = legacyRow(1);
const DEAD = legacyRow(2);
const SEARCH = { status: 'success', total: 2, products: [OPEN, DEAD] };

// Unhandled rejections are what kill the gateway in prod. Count them for the whole file.
const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
test.after(() => process.off('unhandledRejection', onUnhandled));

const tick = (ms = 0) => new Promise((ok) => setTimeout(ok, ms));

// The drop remembers answers and failures per process (GD-2, P3-b); each test starts with neither.
test.beforeEach(() => {
  legacySeedInternal.PROCESS_PROBE_CACHE.clear();
  legacySeedInternal.PROCESS_PROBE_BACKOFF.clear();
});

function deferred() {
  let resolve;
  const promise = new Promise((ok) => { resolve = ok; });
  return { promise, resolve };
}

// The probe the test controls: it does not answer until the test says so.
function heldProbe() {
  const gate = deferred();
  const asked = [];
  const noActiveSeeds = async (ids) => {
    asked.push(ids);
    await gate.promise;
    return new Map(ids.map((id) => [id, id === DEAD.product_id]));
  };
  return { asked, noActiveSeeds, release: () => gate.resolve() };
}

// One express app per case: the handler is the case. The egress is installed the way server.js installs it.
function appFor(handler, probe) {
  const app = express();
  app.use(express.json());
  app.post('/invoke', async (req, res, next) => {
    // As server.js installs it: the hop flag comes from the request itself.
    installInvokeEgress(res, { operation: 'find_products_multi', legacy_seed_probe_hop: isLegacySeedProbeHop(req) }, {
      finalize: (body, ctx) => finalizeInvokeSearchBody(body, ctx, {
        noActiveSeeds: probe.noActiveSeeds,
        env: {},
        cache: null,
        backoff: null,
        deadlineMs: 2000,
      }),
    });
    try {
      await handler(req, res, probe);
    } catch (err) {
      next(err);
    }
  });
  // The gateway's own global error handler shape (server.js): it guards on headersSent only.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  return app;
}

async function expectOneSearchResponse(handler) {
  const probe = heldProbe();
  const before = unhandled.length;
  const pending = supertest(appFor(handler, probe)).post('/invoke').send({});
  const settled = pending.then((r) => r);
  await tick(30);
  assert.equal(probe.asked.length, 1, 'the search is waiting on its probe');
  probe.release();
  const res = await settled;
  await tick(30);
  assert.equal(unhandled.length, before, `no unhandled rejection: ${unhandled.slice(before).map(String).join('; ')}`);
  assert.equal(res.status, 200, `the FIRST answer (the search) is what the client gets: ${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body.products.map((p) => p.product_id), [OPEN.product_id], 'and it is the dropped page');
  assert.equal(res.headers[LEGACY_SEED_PROBE_HEADER.toLowerCase()], undefined, 'an outside caller never gets the hop marker');
  return res;
}

test('GD-1: the handler sends the search, then its catch sends a 500 while the probe is pending: one response, no rejection', async () => {
  await expectOneSearchResponse(async (req, res) => {
    try {
      res.json(SEARCH);
      throw new Error('a later step failed');
    } catch (_) {
      // The guard every catch in handleInvokeRequest uses.
      if (isInvokeResponseCommitted(res)) return;
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });
});

test('GD-1: a catch that guards on res.headersSent alone (the old guard) still cannot produce a second response', async () => {
  const seen = {};
  await expectOneSearchResponse(async (req, res) => {
    res.json(SEARCH);
    seen.headersSent = res.headersSent;
    seen.committed = isInvokeResponseCommitted(res);
    if (!res.headersSent) res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  assert.equal(seen.headersSent, false, 'the deferred send had not happened yet');
  assert.equal(seen.committed, true, 'but the response was committed, and a guard can read that');
});

test('GD-1: an error thrown to the express error handler while the probe is pending: one response, no rejection', async () => {
  await expectOneSearchResponse(async (req, res) => {
    res.json(SEARCH);
    throw new Error('thrown after the search was handed to the egress');
  });
});

test('GD-1: something writes the socket directly while the probe is pending: the deferred send stands down', async () => {
  const probe = heldProbe();
  const before = unhandled.length;
  const logger = require('../src/logger');
  const warned = [];
  const originalWarn = logger.warn;
  logger.warn = function captureWarn(fields, message) {
    warned.push(String(message || ''));
    return originalWarn.apply(this, arguments);
  };
  test.after(() => { logger.warn = originalWarn; });
  const settled = supertest(appFor(async (req, res) => {
    res.json(SEARCH);
    // Around the response object: the one writer the egress cannot hold (P3-a).
    res.statusCode = 503;
    http.ServerResponse.prototype.end.call(res, 'written elsewhere');
  }, probe)).post('/invoke').send({}).then((r) => r);
  await tick(30);
  probe.release();
  const res = await settled;
  await tick(30);
  assert.equal(unhandled.length, before, `no unhandled rejection: ${unhandled.slice(before).map(String).join('; ')}`);
  assert.equal(res.status, 503);
  assert.equal(res.text, 'written elsewhere', 'exactly one body reached the client');
  logger.warn = originalWarn;
  assert.ok(warned.some((m) => m.includes('not sent twice')), `it stood down rather than trying: ${warned.join(' | ')}`);
  assert.ok(!warned.some((m) => m.includes('failed to send')), 'it never tried to write a sent response');
});

test('P3-a: after a commit, res.json again, res.send, res.end, res.write, res.redirect, res.sendStatus and next(err) to the default handler: the first answer wins', async () => {
  const cases = {
    json: (req, res) => res.json(SEARCH),
    send: (req, res) => res.status(502).send('text answer'),
    end: (req, res) => { res.statusCode = 204; res.end(); },
    write: (req, res) => { res.write('partial'); res.end('rest'); },
    redirect: (req, res) => res.redirect('https://elsewhere.example/'),
    sendStatus: (req, res) => res.sendStatus(503),
  };
  for (const [name, after] of Object.entries(cases)) {
    const r = await expectOneSearchResponse(async (req, res) => {
      res.json(SEARCH);
      after(req, res);
    });
    assert.equal(r.headers.location, undefined, `${name}: the later step's headers are not merged in`);
    assert.match(String(r.headers['content-type']), /application\/json/, name);
  }
  // Express's own finalhandler (no app error handler): it writes with res.end.
  const probe = heldProbe();
  const before = unhandled.length;
  const app = express();
  app.post('/invoke', (req, res, next) => {
    installInvokeEgress(res, { operation: 'find_products_multi' }, {
      finalize: (body, ctx) => finalizeInvokeSearchBody(body, ctx, { noActiveSeeds: probe.noActiveSeeds, env: {}, cache: null, backoff: null }),
    });
    res.json(SEARCH);
    next(new Error('after the commit'));
  });
  const settled = supertest(app).post('/invoke').send({}).then((r) => r);
  await tick(30);
  probe.release();
  const res = await settled;
  await tick(30);
  assert.equal(unhandled.length, before);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.deepEqual(res.body.products.map((p) => p.product_id), [OPEN.product_id]);
});

test('P3-c: the probe marker goes ONLY to this process\'s own loopback hop', async () => {
  const run = async (headers) => {
    const probe = heldProbe();
    let r = supertest(appFor(async (req, res) => { res.json(SEARCH); }, probe)).post('/invoke');
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    const settled = r.send({}).then((x) => x);
    await tick(20);
    probe.release();
    return settled;
  };
  const hop = await run(legacySeedProbeHopHeaders());
  assert.equal(hop.headers[LEGACY_SEED_PROBE_HEADER.toLowerCase()], '1', 'the loopback hop is told');
  const outside = await run({});
  assert.equal(outside.headers[LEGACY_SEED_PROBE_HEADER.toLowerCase()], undefined, 'a caller without the token is not');
  const forwarded = await run({ ...legacySeedProbeHopHeaders(), 'X-Forwarded-For': '203.0.113.7' });
  assert.equal(forwarded.headers[LEGACY_SEED_PROBE_HEADER.toLowerCase()], undefined, 'nor one routed in from outside');
  const forged = await run({ [LEGACY_SEED_PROBE_HOP_HEADER]: 'f'.repeat(48) });
  assert.equal(forged.headers[LEGACY_SEED_PROBE_HEADER.toLowerCase()], undefined, 'nor a guessed token');
  for (const body of [hop.body, outside.body]) {
    assert.deepEqual(body.products.map((p) => p.product_id), [OPEN.product_id], 'the page is the same either way');
  }
  assert.equal(isLegacySeedProbeHop({ headers: legacySeedProbeHopHeaders(), socket: { remoteAddress: '203.0.113.9' } }), false);
  assert.equal(isLegacySeedProbeHop(null), false);
});

test('GD-1: a deferred body that cannot be serialised is a 500, not a rejection', async () => {
  const before = unhandled.length;
  const app = express();
  app.post('/invoke', (req, res) => {
    installInvokeEgress(res, { operation: 'find_products_multi' }, {
      finalize: () => Promise.resolve().then(() => {
        const circular = { products: [] };
        circular.self = circular;
        return circular;
      }),
    });
    res.json(SEARCH);
  });
  const res = await supertest(app).post('/invoke').send({});
  await tick(30);
  assert.equal(unhandled.length, before);
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'INTERNAL_ERROR');
});

test('GD-1: a synchronous response is unchanged: not committed by the egress, sent at once', () => {
  const sent = [];
  const res = { statusCode: 200, json(body) { sent.push(body); return this; }, status() { return this; }, setHeader() {} };
  installInvokeEgress(res, { operation: 'get_product_detail' }, { finalize: () => null });
  res.json({ product: { id: 'p1' } });
  assert.equal(sent.length, 1);
  assert.equal(isInvokeResponseCommitted(res), false, 'the sync path keeps express semantics');
  res.json({ second: true });
  assert.equal(sent.length, 2, 'a second sync send reaches express exactly as before');
});

// ---- GD-2 -----------------------------------------------------------------------------------------------

const pageOf = (n) => ({ status: 'success', total: n, products: Array.from({ length: n }, (_, i) => legacyRow(100 + i)) });
const hung = () => new Promise(() => {});

for (const n of [4, 20, 50]) {
  test(`GD-2: a hung database adds at most the deadline to a page of ${n} legacy rows, and the page is the fail-open page`, async () => {
    const body = pageOf(n);
    let calls = 0;
    const startedAt = Date.now();
    const r = await dropUnopenableLegacySeedRows(body, {
      noActiveSeeds: () => { calls += 1; return hung(); },
      env: {},
      cache: createLegacySeedProbeCache(),
      backoff: createLegacySeedProbeBackoff(),
      deadlineMs: 120,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(calls, 1, 'one statement for the whole page');
    assert.ok(elapsed < 120 + 150, `bounded by the deadline: ${elapsed}ms`);
    const failOpen = await dropUnopenableLegacySeedRows(body, {
      noActiveSeeds: async () => { throw new Error('no database'); },
      env: {},
      cache: createLegacySeedProbeCache(),
      backoff: createLegacySeedProbeBackoff(),
    });
    assert.equal(JSON.stringify(r.body), JSON.stringify(failOpen.body), 'the hung page equals the fail-open page');
    assert.equal(r.body, body, 'and that is the page as sent with no check');
    assert.equal(r.failedOpenCount, n);
  });
}

test('GD-2: through the egress with a hung probe, the client waits about the deadline and gets the fail-open page', async () => {
  const body = pageOf(50);
  const app = express();
  app.post('/invoke', (req, res) => {
    installInvokeEgress(res, { operation: 'find_products_multi' }, {
      finalize: (b, ctx) => finalizeInvokeSearchBody(b, ctx, {
        noActiveSeeds: hung,
        env: {},
        cache: createLegacySeedProbeCache(),
        deadlineMs: 150,
      }),
    });
    res.json(body);
  });
  const startedAt = Date.now();
  const res = await supertest(app).post('/invoke').send({});
  const elapsed = Date.now() - startedAt;
  assert.equal(res.status, 200);
  assert.ok(elapsed < 150 + 250, `bounded by the deadline: ${elapsed}ms`);
  assert.deepEqual(res.body, projectLegacySeedRows(body).body, 'the fail-open page (the sync projection, nothing dropped)');
});

test('GD-2: the default deadline is short, and both knobs are clamped', () => {
  assert.equal(legacySeedProbeDeadlineMs({}), 250);
  assert.equal(legacySeedProbeDeadlineMs({ SEARCH_LEGACY_SEED_PROBE_DEADLINE_MS: '5' }), 20);
  assert.equal(legacySeedProbeDeadlineMs({ SEARCH_LEGACY_SEED_PROBE_DEADLINE_MS: '99999' }), 2000);
  assert.equal(legacySeedProbeDeadlineMs({ SEARCH_LEGACY_SEED_PROBE_DEADLINE_MS: 'soon' }), 250);
  assert.equal(legacySeedProbeCacheTtlMs({}), 30000);
  assert.equal(legacySeedProbeCacheTtlMs({ SEARCH_LEGACY_SEED_PROBE_CACHE_TTL_MS: '0' }), 0);
  assert.equal(legacySeedProbeCacheTtlMs({ SEARCH_LEGACY_SEED_PROBE_CACHE_TTL_MS: '-1' }), 0);
  assert.equal(legacySeedProbeCacheTtlMs({ SEARCH_LEGACY_SEED_PROBE_CACHE_TTL_MS: '9999999' }), 300000);
});

test('GD-2: answers are remembered for the TTL; the next page asks only about ids it has not seen', async () => {
  let clock = 1000;
  const cache = createLegacySeedProbeCache({ now: () => clock });
  const asked = [];
  const noActiveSeeds = async (ids) => {
    asked.push([...ids]);
    return new Map(ids.map((id) => [id, id === DEAD.product_id]));
  };
  const first = await dropUnopenableLegacySeedRows(SEARCH, { noActiveSeeds, env: {}, cache, cacheTtlMs: 5000 });
  assert.deepEqual(first.droppedIds, [DEAD.product_id]);
  const NEW = legacyRow(3);
  const second = await dropUnopenableLegacySeedRows({ products: [DEAD, OPEN, NEW] }, { noActiveSeeds, env: {}, cache, cacheTtlMs: 5000 });
  assert.deepEqual(asked, [[OPEN.product_id, DEAD.product_id], [NEW.product_id]]);
  assert.deepEqual(second.droppedIds, [DEAD.product_id], 'a cached "no active seed" still drops');
  assert.equal(second.cachedCount, 2);
  clock += 5001;
  await dropUnopenableLegacySeedRows({ products: [DEAD] }, { noActiveSeeds, env: {}, cache, cacheTtlMs: 5000 });
  assert.deepEqual(asked[2], [DEAD.product_id], 'an expired answer is asked again');
  const failed = createLegacySeedProbeCache();
  await dropUnopenableLegacySeedRows({ products: [DEAD] }, { noActiveSeeds: async () => { throw new Error('down'); }, env: {}, cache: failed });
  assert.equal(failed.size, 0, 'a failure is never remembered');
});

test('GD-2: the cache is bounded', () => {
  const cache = createLegacySeedProbeCache({ maxEntries: 3 });
  for (let i = 0; i < 5; i += 1) cache.set(`id-${i}`, true, 60000);
  assert.equal(cache.size, 3);
  assert.equal(cache.get('id-0'), undefined, 'the oldest go first');
  assert.equal(cache.get('id-4'), true);
  cache.set('id-x', 'yes', 60000);
  assert.equal(cache.get('id-x'), undefined, 'only a boolean answer is stored');
});

test('GD-2: an id the database did not answer is kept; only a literal true drops', async () => {
  const r = await dropUnopenableLegacySeedRows(SEARCH, {
    noActiveSeeds: async () => new Map([[DEAD.product_id, 'true']]),
    env: {},
    cache: null,
  });
  assert.equal(r.body, SEARCH);
  assert.equal(r.failedOpenCount, 2);
});

test('P2-N1: the drop statement is the route\'s own gate, one row per id, any served currency in place of the buyer\'s', async () => {
  const sql = LEGACY_SEED_OPENABLE_BATCH_SQL;
  assert.match(sql, /FROM unnest\(\$1::text\[\]\) AS req\(id\)/);
  assert.doesNotMatch(sql, /\$1\b(?!::text\[\])|\$2/, '$1 is the array only; every term is bound to req.id');
  // The SAME clause as the route, with only the id and the currency term substituted.
  const currencyEq = `AND ${seedCurrencySql('external_product_seeds')} = $2`;
  assert.ok(LEGACY_SEED_DETAIL_MATCH_CLAUSE.includes(currencyEq));
  const served = `AND ${seedCurrencySql('external_product_seeds')} IN (${SERVED_SEED_CURRENCIES.map((c) => `'${c}'`).join(', ')})`;
  const expected = LEGACY_SEED_DETAIL_MATCH_CLAUSE.replace('external_product_id = $1', 'external_product_id = req.id').replace(currencyEq, served);
  assert.equal(LEGACY_SEED_OPENABLE_CLAUSE, expected);
  assert.ok(sql.includes(`EXISTS (SELECT 1 FROM external_product_seeds WHERE status = 'active' AND ${LEGACY_SEED_OPENABLE_CLAUSE}) AS openable`));
  assert.ok(SERVED_SEED_CURRENCIES.includes('USD') && SERVED_SEED_CURRENCIES.includes('SGD'));

  const calls = [];
  const answers = await confirmNoOpenableLegacySeeds([OPEN.product_id, DEAD.product_id, OPEN.product_id, ''], {
    queryFn: async (text, params) => {
      calls.push(params);
      return { rows: [{ product_id: OPEN.product_id, openable: true }, { product_id: DEAD.product_id, openable: false }] };
    },
  });
  assert.deepEqual(calls, [[[OPEN.product_id, DEAD.product_id]]], 'deduplicated, blanks dropped, one call');
  assert.equal(answers.get(OPEN.product_id), false, 'openable: not dead');
  assert.equal(answers.get(DEAD.product_id), true);
  await assert.rejects(confirmNoOpenableLegacySeeds([OPEN.product_id], { queryFn: async () => ({ rows: [{ product_id: OPEN.product_id }] }) }));
  await assert.rejects(confirmNoOpenableLegacySeeds([OPEN.product_id], { queryFn: async () => ({ rows: [{ product_id: OPEN.product_id, openable: 'false' }] }) }));
  await assert.rejects(confirmNoOpenableLegacySeeds([OPEN.product_id], { queryFn: async () => ({ rows: [{ product_id: 'other', openable: false }] }) }));
  await assert.rejects(confirmNoOpenableLegacySeeds([OPEN.product_id], { queryFn: async () => null }));
  await assert.rejects(confirmNoOpenableLegacySeeds([OPEN.product_id], {}));
  const partial = await confirmNoOpenableLegacySeeds([OPEN.product_id, DEAD.product_id], {
    queryFn: async () => ({ rows: [{ product_id: DEAD.product_id, openable: false }] }),
  });
  assert.equal(partial.has(OPEN.product_id), false, 'an id with no answer row is unknown');
});

test('P3-b: a failed ask backs off: the next pages do not ask, keep their rows, then ask again', async () => {
  let clock = 1000;
  const backoff = createLegacySeedProbeBackoff({ now: () => clock });
  let calls = 0;
  const failing = async () => { calls += 1; throw new Error('deadline'); };
  const answering = async (ids) => { calls += 1; return new Map(ids.map((id) => [id, id === DEAD.product_id])); };
  const opts = { env: {}, cache: null, backoff, backoffMs: 5000 };
  const first = await dropUnopenableLegacySeedRows(SEARCH, { ...opts, noActiveSeeds: failing });
  assert.equal(first.body, SEARCH);
  assert.equal(calls, 1);
  const during = await dropUnopenableLegacySeedRows(SEARCH, { ...opts, noActiveSeeds: answering });
  assert.equal(calls, 1, 'nothing is asked while backing off');
  assert.equal(during.body, SEARCH, 'the page is the fail-open page');
  assert.equal(during.backedOff, true);
  clock += 5001;
  const after = await dropUnopenableLegacySeedRows(SEARCH, { ...opts, noActiveSeeds: answering });
  assert.equal(calls, 2, 'asked again once the backoff is over');
  assert.deepEqual(after.droppedIds, [DEAD.product_id]);
  // A hung probe trips it too (the deadline is a failure).
  const hungBackoff = createLegacySeedProbeBackoff();
  await dropUnopenableLegacySeedRows(SEARCH, { env: {}, cache: null, backoff: hungBackoff, backoffMs: 5000, deadlineMs: 20, noActiveSeeds: hung });
  assert.equal(hungBackoff.active(), true);
  // Cached answers still apply while backing off.
  const cache = createLegacySeedProbeCache();
  cache.set(DEAD.product_id, true, 60000);
  const cachedDuring = await dropUnopenableLegacySeedRows(SEARCH, { env: {}, cache, cacheTtlMs: 60000, backoff: hungBackoff, noActiveSeeds: answering });
  assert.deepEqual(cachedDuring.droppedIds, [DEAD.product_id]);
  // 0 turns it off.
  const off = createLegacySeedProbeBackoff();
  await dropUnopenableLegacySeedRows(SEARCH, { env: {}, cache: null, backoff: off, backoffMs: 0, noActiveSeeds: failing });
  assert.equal(off.active(), false);
});

test('P3-b / P3-f: the knobs and their clamps', () => {
  assert.equal(legacySeedProbeFailureBackoffMs({}), 5000);
  assert.equal(legacySeedProbeFailureBackoffMs({ SEARCH_LEGACY_SEED_PROBE_FAILURE_BACKOFF_MS: '0' }), 0);
  assert.equal(legacySeedProbeFailureBackoffMs({ SEARCH_LEGACY_SEED_PROBE_FAILURE_BACKOFF_MS: '999999' }), 60000);
  assert.equal(legacySeedDetailDbBudgetMs({}), 800);
  assert.equal(legacySeedDetailDbBudgetMs({ LEGACY_SEED_DETAIL_DB_BUDGET_MS: '1' }), 50);
  assert.equal(legacySeedDetailDbBudgetMs({ LEGACY_SEED_DETAIL_DB_BUDGET_MS: '99999' }), 5000);
});
