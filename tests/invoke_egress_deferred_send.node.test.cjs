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

const {
  LEGACY_SEED_PROBE_HEADER,
  finalizeInvokeSearchBody,
  installInvokeEgress,
  isInvokeResponseCommitted,
} = require('../src/invokeEgress');
const {
  createLegacySeedProbeCache,
  dropUnopenableLegacySeedRows,
  legacySeedProbeDeadlineMs,
  legacySeedProbeCacheTtlMs,
  projectLegacySeedRows,
} = require('../src/services/legacySeedIdServability');
const {
  confirmNoActiveSeedMatchesBatch,
  __internal: { ACTIVE_SEED_MATCH_BATCH_SQL, ACTIVE_SEED_MATCH_BRANCHES },
} = require('../src/services/signatureSeedNotActive');

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
    installInvokeEgress(res, { operation: 'find_products_multi' }, {
      finalize: (body, ctx) => finalizeInvokeSearchBody(body, ctx, {
        noActiveSeeds: probe.noActiveSeeds,
        env: {},
        cache: null,
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
  assert.equal(res.headers[LEGACY_SEED_PROBE_HEADER.toLowerCase()], '1');
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
    res.status(503).end('written elsewhere');
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
      deadlineMs: 120,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(calls, 1, 'one statement for the whole page');
    assert.ok(elapsed < 120 + 150, `bounded by the deadline: ${elapsed}ms`);
    const failOpen = await dropUnopenableLegacySeedRows(body, {
      noActiveSeeds: async () => { throw new Error('no database'); },
      env: {},
      cache: createLegacySeedProbeCache(),
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

test('GD-2: the batch statement is the per-id match set, one row per requested id', async () => {
  const sql = ACTIVE_SEED_MATCH_BATCH_SQL;
  assert.match(sql, /FROM unnest\(\$1::text\[\]\) AS req\(id\)/);
  assert.doesNotMatch(sql, /\$1\b(?!::text\[\])/, '$1 is the array only; every branch is bound to req.id');
  for (const [name, clause] of ACTIVE_SEED_MATCH_BRANCHES) {
    assert.ok(sql.includes(`${clause.replace(/\$1\b/g, 'req.id')}) AS ${name}`), name);
  }
  const calls = [];
  const row = (id, hit) => ({ product_id: id, ...Object.fromEntries(ACTIVE_SEED_MATCH_BRANCHES.map(([n]) => [n, n === 'seed_id' && hit])) });
  const answers = await confirmNoActiveSeedMatchesBatch([OPEN.product_id, DEAD.product_id, OPEN.product_id, ''], {
    queryFn: async (text, params) => {
      calls.push(params);
      return { rows: [row(OPEN.product_id, true), row(DEAD.product_id, false)] };
    },
  });
  assert.deepEqual(calls, [[[OPEN.product_id, DEAD.product_id]]], 'deduplicated, blanks dropped, one call');
  assert.equal(answers.get(OPEN.product_id), false, 'any branch active: not dead');
  assert.equal(answers.get(DEAD.product_id), true);
  await assert.rejects(confirmNoActiveSeedMatchesBatch([OPEN.product_id], { queryFn: async () => ({ rows: [{ product_id: OPEN.product_id }] }) }));
  await assert.rejects(confirmNoActiveSeedMatchesBatch([OPEN.product_id], { queryFn: async () => ({ rows: [row('other', false)] }) }));
  await assert.rejects(confirmNoActiveSeedMatchesBatch([OPEN.product_id], { queryFn: async () => null }));
  await assert.rejects(confirmNoActiveSeedMatchesBatch([OPEN.product_id], {}));
  const partial = await confirmNoActiveSeedMatchesBatch([OPEN.product_id, DEAD.product_id], {
    queryFn: async () => ({ rows: [row(DEAD.product_id, false)] }),
  });
  assert.equal(partial.has(OPEN.product_id), false, 'an id with no answer row is unknown');
});
