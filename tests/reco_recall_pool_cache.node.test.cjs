'use strict';

// The reco recall lane had NO cache that survives a deploy, and this service deploys ~20 times a day.
// Worse, the fail-fast circuit could not close: its probe timeout is capped at 6000ms (default 1500ms)
// against a dependency whose COLD latency is 9-18.6s, so every probe failed, re-opened the circuit,
// and both recall AND the grounding pass were skipped for as long as traffic kept arriving.
//
// This suite covers the durable pool cache and the circuit repair. The SQL tests run the EXACT DDL the
// migration ships (read from src/db/migrations/059_reco_recall_pool_cache.sql, not retyped) against
// pg-mem, following tests/merchant_transaction_capability_sql.test.js: SQL-shape assertions let
// 3-valued-logic bugs pass, so the statements are EXECUTED and the row sets asserted.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const cacheModule = require('../src/auroraBff/recoRecallPoolCache');
const {
  RECO_RECALL_POOL_CACHE_TABLE_SQL,
  RECO_RECALL_POOL_CACHE_MAX_CANDIDATES,
  buildRecoRecallPoolCacheKey,
  sanitizeRecoRecallPoolCandidates,
  normalizeRecoRecallPoolCacheEntry,
  shouldServeRecoRecallPoolCacheEntry,
  shouldRevalidateRecoRecallPoolCacheEntry,
  createRecoRecallPoolCache,
  isRecoRecallPoolCacheEnabled,
} = cacheModule;

const MIGRATION_PATH = path.join(__dirname, '..', 'src', 'db', 'migrations', '059_reco_recall_pool_cache.sql');

function normalizeSql(sql) {
  return String(sql || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/;+$/, '');
}

// MUST await `fn` inside the try: a synchronous `finally` would restore the env before an async body
// ever ran, and the test would silently measure the DEFAULT configuration.
async function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// 1. The DDL the code ships IS the DDL the migration ships
// ---------------------------------------------------------------------------

test('the lazy ensure DDL is byte-equivalent to migration 059', () => {
  const migrationStatements = normalizeSql(fs.readFileSync(MIGRATION_PATH, 'utf8'))
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const codeStatements = RECO_RECALL_POOL_CACHE_TABLE_SQL.map(normalizeSql);
  // Mutant killed: editing one copy of the DDL and not the other. The lazy ensure exists only to
  // recover a 42P01 on a deployment whose migrations have not run; if it diverges from the migration
  // it creates a DIFFERENT table, which is the worst shape of schema drift to debug.
  assert.equal(codeStatements.length, migrationStatements.length);
  for (let i = 0; i < migrationStatements.length; i += 1) {
    assert.equal(codeStatements[i], migrationStatements[i], `statement ${i} diverged`);
  }
});

test('migration 059 is the next unused number and creates only its own table', () => {
  const dir = path.join(__dirname, '..', 'src', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f));
  const mine = files.filter((f) => f.startsWith('059_'));
  // Mutant killed: reusing an existing number. The runner applies files in lexicographic order and
  // records them by FILENAME, so a duplicate prefix is legal but the ordering becomes a coin flip.
  assert.equal(mine.length, 1, `expected exactly one 059_ migration, got ${JSON.stringify(mine)}`);
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const createdTables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(createdTables, ['reco_recall_pool_cache']);
  // Mutant killed: dropping `IF NOT EXISTS` — the runner has no rollback for a partially applied file,
  // and a re-run on an existing database would abort every later migration.
  assert.ok(/CREATE TABLE IF NOT EXISTS/i.test(sql));
  assert.ok(/CREATE INDEX IF NOT EXISTS/i.test(sql));
});

// ---------------------------------------------------------------------------
// 2. The read / write / purge statements against the SHIPPED DDL
// ---------------------------------------------------------------------------

function makePgMemCache({ now = () => Date.now() } = {}) {
  const db = newDb();
  db.public.none(fs.readFileSync(MIGRATION_PATH, 'utf8'));
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return pool.query(sql, params);
  };
  return { db, calls, cache: createRecoRecallPoolCache({ query, now }), pool };
}

test('write then read round-trips a pool through the shipped table', async () => {
  const { cache } = makePgMemCache();
  const key = buildRecoRecallPoolCacheKey({ queries: ['gentle cleanser'], stepFamily: 'cleanser', lang: 'EN' });
  assert.ok(key);
  assert.equal(await cache.write(key, {
    pool: [{ product_id: 'p1', merchant_id: 'm1', name: 'Gentle Cleanser', price: 24 }],
    stepFamily: 'cleanser',
    lang: 'EN',
    catalogSurface: 'beauty',
    plannerMode: 'step_aware',
  }), true);

  const entry = await cache.read(key);
  assert.ok(entry, 'expected a cache entry');
  assert.equal(entry.pool.length, 1);
  assert.equal(entry.pool[0].product_id, 'p1');
  assert.equal(entry.pool[0].price, 24);
  assert.ok(entry.age_ms >= 0);
});

test('a second write to the same key UPSERTS rather than erroring or duplicating', async () => {
  const { cache, db } = makePgMemCache();
  const key = buildRecoRecallPoolCacheKey({ queries: ['toner'], stepFamily: 'toner', lang: 'EN' });
  await cache.write(key, { pool: [{ product_id: 'p1' }], stepFamily: 'toner' });
  await cache.write(key, { pool: [{ product_id: 'p2' }, { product_id: 'p3' }], stepFamily: 'toner' });
  const rows = db.public.many('SELECT cache_key, candidate_count, payload FROM reco_recall_pool_cache');
  // Mutant killed: dropping ON CONFLICT (the second write would raise a unique violation), or writing
  // to a non-PRIMARY-KEY column set (rows would accumulate and the read would pick one at random).
  assert.equal(rows.length, 1);
  assert.equal(rows[0].candidate_count, 2);
  assert.deepEqual(rows[0].payload.map((p) => p.product_id), ['p2', 'p3']);
});

test('reading a key that was never written returns null, not a throw', async () => {
  const { cache } = makePgMemCache();
  assert.equal(await cache.read('deadbeef'), null);
});

test('purgeExpired deletes only rows past the serve window', async () => {
  const { cache, db } = makePgMemCache();
  const fresh = buildRecoRecallPoolCacheKey({ queries: ['fresh'], stepFamily: 'serum' });
  await cache.write(fresh, { pool: [{ product_id: 'p1' }] });
  db.public.none(
    "INSERT INTO reco_recall_pool_cache (cache_key, candidate_count, payload, refreshed_at)"
    + " VALUES ('stale', 1, '[{\"product_id\":\"old\"}]'::jsonb, now() - interval '30 days')",
  );
  assert.equal(db.public.many('SELECT cache_key FROM reco_recall_pool_cache').length, 2);
  const deleted = await cache.purgeExpired({ maxRows: 100 });
  const remaining = db.public.many('SELECT cache_key FROM reco_recall_pool_cache').map((r) => r.cache_key);
  // Mutant killed: an inverted comparison (`>=` instead of `<=`) would delete exactly the live rows —
  // a change that a SQL-shape assertion could never catch.
  assert.equal(deleted, 1);
  assert.deepEqual(remaining, [fresh]);
});

test('NO_DATABASE and 42P01 are swallowed, so a database-less deployment behaves as it does today', async () => {
  const noDbErr = Object.assign(new Error('DATABASE_URL not configured or pg driver unavailable'), {
    code: 'NO_DATABASE',
  });
  const cache = createRecoRecallPoolCache({
    query: async () => {
      throw noDbErr;
    },
  });
  // Mutant killed: letting the error propagate. This cache sits on the reco request path; a store
  // that throws when DATABASE_URL is unset would turn an optional optimisation into an outage.
  assert.equal(await cache.read('k'), null);
  assert.equal(await cache.write('k', { pool: [] }), false);
  assert.equal(await cache.purgeExpired(), 0);
});

// ---------------------------------------------------------------------------
// 3. Key safety: bounded, hashed, no free text
// ---------------------------------------------------------------------------

test('the cache key is a bounded hash, never the caller text', () => {
  const need = 'A Gentle   Exfoliant For SENSITIVE Skin '.repeat(50);
  const key = buildRecoRecallPoolCacheKey({ queries: [need], stepFamily: 'treatment', lang: 'EN' });
  // Mutant killed: using the raw query as the key. It would put caller free text in a shared table
  // AND make the key length caller-controlled.
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes('exfoliant'));
});

test('case and whitespace fold to the same key; different meaning does not', () => {
  const a = buildRecoRecallPoolCacheKey({ queries: ['Gentle  Cleanser '], stepFamily: 'cleanser', lang: 'EN' });
  const b = buildRecoRecallPoolCacheKey({ queries: ['gentle cleanser'], stepFamily: 'cleanser', lang: 'EN' });
  // Mutant killed: dropping the case/whitespace fold. A trailing space alone is already known to
  // change search behaviour on this stack; the cache must not multiply that into distinct keys.
  assert.equal(a, b);
  assert.notEqual(a, buildRecoRecallPoolCacheKey({ queries: ['gentle cleanser'], stepFamily: 'toner', lang: 'EN' }));
  assert.notEqual(a, buildRecoRecallPoolCacheKey({ queries: ['gentle cleanser'], stepFamily: 'cleanser', lang: 'CN' }));
  assert.notEqual(a, buildRecoRecallPoolCacheKey({ queries: ['gentle toner'], stepFamily: 'cleanser', lang: 'EN' }));
  assert.notEqual(
    a,
    buildRecoRecallPoolCacheKey({ queries: ['gentle cleanser'], stepFamily: 'cleanser', lang: 'EN', catalogSurface: 'agent_api' }),
  );
});

test('the key is bounded in BOTH the number of query parts and their length', () => {
  const many = Array.from({ length: 40 }, (_, i) => `query ${i}`);
  const capped = buildRecoRecallPoolCacheKey({ queries: many, stepFamily: 'serum' });
  const first8 = buildRecoRecallPoolCacheKey({ queries: many.slice(0, 8), stepFamily: 'serum' });
  // Mutant killed: an unbounded key. Query count is plan-controlled and each query can carry caller
  // text; without both caps a single request could produce an arbitrarily large key.
  assert.equal(capped, first8);

  const longA = `${'a'.repeat(300)}X`;
  const longB = `${'a'.repeat(300)}Y`;
  assert.equal(
    buildRecoRecallPoolCacheKey({ queries: [longA], stepFamily: 'serum' }),
    buildRecoRecallPoolCacheKey({ queries: [longB], stepFamily: 'serum' }),
  );
});

test('an empty query list yields no key, so nothing is cached', () => {
  // Mutant killed: returning a key for an empty plan — every empty-plan request in the fleet would
  // then share one row.
  assert.equal(buildRecoRecallPoolCacheKey({ queries: [], stepFamily: 'serum' }), null);
  assert.equal(buildRecoRecallPoolCacheKey({ queries: ['', '  '], stepFamily: 'serum' }), null);
  assert.equal(buildRecoRecallPoolCacheKey({}), null);
});

// ---------------------------------------------------------------------------
// 4. Payload safety: catalog fields only, bounded
// ---------------------------------------------------------------------------

test('the payload is an ALLOWLIST: caller-scoped fields never enter a shared cache', () => {
  const sanitized = sanitizeRecoRecallPoolCandidates([
    {
      product_id: 'p1',
      name: 'Cleanser',
      price: 20,
      // none of the below may survive
      aurora_uid: 'uid_123',
      user_message: 'my skin is awful lately',
      session_id: 's_1',
      backend_auth_headers: { authorization: 'Bearer secret' },
      profile: { email: 'a@b.c' },
      notes: ['internal'],
    },
  ]);
  assert.equal(sanitized.length, 1);
  const keys = Object.keys(sanitized[0]).sort();
  // Mutant killed: a denylist, or a spread of the whole candidate. A field added upstream would then
  // be persisted into a GLOBAL cache by default.
  assert.deepEqual(keys, ['name', 'price', 'product_id']);
});

test('the payload is capped at the existing pool cap and drops empty candidates', () => {
  const big = Array.from({ length: 100 }, (_, i) => ({ product_id: `p${i}` }));
  assert.equal(sanitizeRecoRecallPoolCandidates(big).length, RECO_RECALL_POOL_CACHE_MAX_CANDIDATES);
  assert.equal(RECO_RECALL_POOL_CACHE_MAX_CANDIDATES, 24);
  // Mutant killed: removing the cap — a jsonb column with no bound is a memory and storage hazard.
  assert.deepEqual(sanitizeRecoRecallPoolCandidates([{}, null, 'x', { aurora_uid: 'u' }]), []);
  assert.deepEqual(sanitizeRecoRecallPoolCandidates(null), []);
});

test('long string fields are truncated rather than stored whole', () => {
  const sanitized = sanitizeRecoRecallPoolCandidates([{ product_id: 'p', name: 'n'.repeat(5000) }]);
  assert.equal(sanitized[0].name.length, 512);
});

// LIVE REGRESSION (2026-08-21): the lane's price is an OBJECT ({amount, currency, unknown}) built by
// extractCatalogCandidatePrice, and v1's scalar-only sanitizer silently dropped it — every pool served
// from cache produced grounded products with NO price, which the price gate then honestly reported as
// "not verified: no catalog price" on all of them. The object must round-trip as the scalar fields the
// SAME extractor reads back (price_amount + currency are both extractor seeds).
test('an OBJECT price round-trips as price_amount + currency — a cached pool never loses prices', () => {
  const sanitized = sanitizeRecoRecallPoolCandidates([
    { product_id: 'p1', name: 'Murad Deep Relief', price: { amount: 45, currency: 'USD', unknown: false } },
    { product_id: 'p2', name: 'lowercase currency', price: { amount: 17.5, currency: 'usd' } },
    // amount <= 0 is a broken offer row: no price is stored, never a fabricated zero
    { product_id: 'p3', name: 'broken offer', price: { amount: 0, currency: 'USD' } },
    { product_id: 'p4', name: 'negative', price: { amount: -3, currency: 'USD' } },
    // an explicit scalar price_amount is never overwritten by the object
    { product_id: 'p5', name: 'scalar wins', price_amount: 30, price: { amount: 99, currency: 'EUR' } },
  ]);
  // Mutant killed: reverting to the scalar-only sanitizer — p1 loses its price entirely.
  assert.equal(sanitized[0].price_amount, 45);
  assert.equal(sanitized[0].currency, 'USD');
  assert.equal(sanitized[1].price_amount, 17.5);
  assert.equal(sanitized[1].currency, 'USD', 'currency is upcased so the reader compares like-for-like');
  assert.equal(sanitized[2].price_amount, undefined, 'a zero amount is a broken row, not a price');
  assert.equal(sanitized[3].price_amount, undefined);
  assert.equal(sanitized[4].price_amount, 30, 'an explicit scalar is authoritative');
  // and no raw object ever reaches the payload
  for (const c of sanitized) assert.notEqual(typeof c.price, 'object');
});

test('the version bump orphans every price-less v1 row — no v1 key can ever be read again', () => {
  const key = buildRecoRecallPoolCacheKey({
    queries: ['cleanser'], stepFamily: 'cleanser', lang: 'en', catalogSurface: 'beauty', plannerMode: 'step_aware',
  });
  // The RECORDED v1 key for these exact dims. Mutant killed: leaving the version at v1 — the deployed
  // table is full of price-less v1 payloads with 24h serve windows, and without the bump the fixed
  // reader would keep serving them for a day.
  assert.notEqual(key, 'df91032da2eecf5bf73b4784e4b457d8f51f63801a321b7be33ed120ae4d70b9');
  // The RECORDED v4 key for the same dims, measured against origin/main before ADR-024 Phase 1 added
  // the `region` dimension. Same argument one version on: every v4 row was written by a REGION-BLIND
  // writer, so it carries no honest region attribution and must never be served as if it were US.
  // Mutant killed: adding the region dimension without bumping the version — the dims object changes,
  // but a reviewer cannot tell from the version string that the table went cold on purpose.
  assert.notEqual(key, '8db46b29f150dce7aca04c9eb0ce7c7fb46a14215bdf9c893a9f269c9865fa64');
});

// ---------------------------------------------------------------------------
// 5. Stale-while-revalidate semantics
// ---------------------------------------------------------------------------

function entryAged(ageMs, poolLength = 3) {
  return {
    pool: Array.from({ length: poolLength }, (_, i) => ({ product_id: `p${i}` })),
    age_ms: ageMs,
    refreshed_at_ms: Date.now() - ageMs,
  };
}

test('a non-empty entry is served for 24h and revalidated after 10min', () => {
  assert.equal(shouldServeRecoRecallPoolCacheEntry(entryAged(0)), true);
  assert.equal(shouldServeRecoRecallPoolCacheEntry(entryAged(60 * 60 * 1000)), true);
  assert.equal(shouldServeRecoRecallPoolCacheEntry(entryAged(24 * 60 * 60 * 1000)), true);
  // Mutant killed: an unbounded serve window — a pool from last week would be served forever.
  assert.equal(shouldServeRecoRecallPoolCacheEntry(entryAged(24 * 60 * 60 * 1000 + 1)), false);

  assert.equal(shouldRevalidateRecoRecallPoolCacheEntry(entryAged(60 * 1000)), false);
  // Mutant killed: never revalidating — the cache would freeze the catalog at first write.
  assert.equal(shouldRevalidateRecoRecallPoolCacheEntry(entryAged(10 * 60 * 1000 + 1)), true);
});

test('an EMPTY pool is never fresh for more than the negative lease', () => {
  // Mutant killed: treating an empty pool like a full one. "No products matched" is exactly the
  // answer this whole workstream exists to stop shipping; pinning it for 24h would be a regression
  // dressed as a cache hit.
  assert.equal(shouldServeRecoRecallPoolCacheEntry(entryAged(0, 0)), true);
  assert.equal(shouldServeRecoRecallPoolCacheEntry(entryAged(60 * 1000, 0)), true);
  assert.equal(shouldServeRecoRecallPoolCacheEntry(entryAged(60 * 1000 + 1, 0)), false);
  assert.equal(shouldServeRecoRecallPoolCacheEntry(entryAged(10 * 60 * 1000, 0)), false);
});

test('a malformed row normalizes to null instead of a half-built entry', () => {
  assert.equal(normalizeRecoRecallPoolCacheEntry(null), null);
  assert.equal(normalizeRecoRecallPoolCacheEntry({ payload: [] }), null);
  assert.equal(normalizeRecoRecallPoolCacheEntry({ refreshed_at: 'not a date', payload: [] }), null);
  const ok = normalizeRecoRecallPoolCacheEntry({ refreshed_at: new Date().toISOString(), payload: null });
  assert.deepEqual(ok.pool, []);
});

test('the kill switch disables every path', async () => {
  await withEnv({ AURORA_BFF_RECO_RECALL_POOL_CACHE_ENABLED: 'false' }, async () => {
    assert.equal(isRecoRecallPoolCacheEnabled(), false);
    const { cache, calls } = makePgMemCache();
    assert.equal(await cache.read('k'), null);
    assert.equal(await cache.write('k', { pool: [{ product_id: 'p' }] }), false);
    assert.equal(await cache.purgeExpired(), 0);
    // Mutant killed: checking the flag at module load instead of per call, or on only one of the
    // three paths. Ops must be able to turn the whole thing off without a deploy.
    assert.equal(calls.length, 0, 'no SQL may be issued while the cache is off');
  });
  assert.equal(isRecoRecallPoolCacheEnabled(), true, 'default is ON');
});

// ---------------------------------------------------------------------------
// 6. Circuit repair + routes integration
// ---------------------------------------------------------------------------

const dbModule = require('../src/db');
const { __internal } = require('../src/auroraBff/routes');

function resetCircuit() {
  __internal.markRecoCatalogFailFastSuccess();
  const state = __internal.recoCatalogFailFastState;
  if (state.off_request_probe_timer) {
    clearTimeout(state.off_request_probe_timer);
    state.off_request_probe_timer = null;
  }
  state.off_request_probe_in_flight = false;
  state.last_off_request_probe_ok_at = 0;
  state.last_off_request_probe_failed_at = 0;
}

test('stale-pool revalidation is SINGLE-FLIGHT per key — a popular key never fans out', () => {
  // REVIEW FINDING (2026-08-20): the hit_stale path scheduled one runLiveRecall PER REQUEST with no
  // coalescing. N concurrent requests on one stale popular key = N full live-search fan-outs against
  // the exact dependency this cache shields — the ensure_database_ready wedge shape. Mutant killed:
  // removing the begin/end guard makes the second begin() return true and this test fails.
  const key = 'k_' + Math.random().toString(36).slice(2);
  assert.equal(__internal.beginRecoRecallPoolRevalidation(key), true, 'first caller owns the refresh');
  assert.equal(__internal.beginRecoRecallPoolRevalidation(key), false, 'second caller coalesces');
  __internal.endRecoRecallPoolRevalidation(key);
  assert.equal(__internal.beginRecoRecallPoolRevalidation(key), true, 'after settle the key is free again');
  __internal.endRecoRecallPoolRevalidation(key);
  // the backstop cap refuses new keys rather than growing without bound
  const opened = [];
  for (let i = 0; i < 200; i += 1) {
    const k = `cap_${i}`;
    if (__internal.beginRecoRecallPoolRevalidation(k)) opened.push(k);
  }
  assert.ok(opened.length <= 64, `at most 64 concurrent refreshes, got ${opened.length}`);
  for (const k of opened) __internal.endRecoRecallPoolRevalidation(k);
  // an empty key is never registered
  assert.equal(__internal.beginRecoRecallPoolRevalidation(''), false);
});

test('a REQUEST is never conscripted as a circuit probe once off-request probing is on', () => {
  resetCircuit();
  const now = Date.now();
  // Drive the circuit open the way production does: threshold consecutive transient failures.
  for (let i = 0; i < 3; i += 1) __internal.markRecoCatalogFailFastFailure('all_queries_failed', now);
  const snapshot = __internal.getRecoCatalogFailFastSnapshot(now + 6000);
  assert.equal(snapshot.open, true, 'circuit should be open after the threshold');
  assert.equal(snapshot.can_probe_while_open, true, 'the probe interval has elapsed');
  // Mutant killed: leaving the on-request probe enabled. Its timeout is capped at 6000ms against a
  // 9-18.6s cold search, so it can only ever fail -- and it makes a real caller pay for that failure
  // while re-opening the circuit for another cooldown. This is the metastable loop.
  assert.equal(__internal.beginRecoCatalogFailFastProbe(now + 6000), false);
  resetCircuit();
});

test('opening the circuit schedules an OFF-REQUEST probe, and only one', () => {
  resetCircuit();
  const state = __internal.recoCatalogFailFastState;
  assert.equal(state.off_request_probe_timer, null);
  for (let i = 0; i < 3; i += 1) __internal.markRecoCatalogFailFastFailure('all_queries_failed');
  // Mutant killed: not scheduling a probe at all -- the circuit would then only close if a request
  // happened to succeed, but no request is allowed to try while it is open.
  assert.ok(state.off_request_probe_timer, 'a probe timer must be pending');
  const first = state.off_request_probe_timer;
  // Mutant killed: scheduling one probe per failure / per request -- a timer storm against a
  // dependency that is already struggling.
  assert.equal(__internal.scheduleRecoCatalogFailFastOffRequestProbe(), false);
  assert.equal(state.off_request_probe_timer, first);
  resetCircuit();
});

test('the off-request probe timer is unref\'d so it cannot hold the process open', () => {
  resetCircuit();
  for (let i = 0; i < 3; i += 1) __internal.markRecoCatalogFailFastFailure('all_queries_failed');
  const timer = __internal.recoCatalogFailFastState.off_request_probe_timer;
  assert.ok(timer);
  // Mutant killed: dropping .unref(). node --test would then hang on this file instead of exiting,
  // and in production a shutdown would wait on a probe.
  assert.equal(timer.hasRef(), false);
  resetCircuit();
});

test('the off-request probe uses a timeout that can actually clear a cold search', () => {
  resetCircuit();
  for (let i = 0; i < 3; i += 1) __internal.markRecoCatalogFailFastFailure('all_queries_failed');
  const snapshot = __internal.getRecoCatalogFailFastSnapshot();
  assert.equal(snapshot.off_request_probe_enabled, true);
  // Mutant killed: reusing RECO_CATALOG_FAIL_FAST_PROBE_SEARCH_TIMEOUT_MS (max 6000). Measured cold
  // latency on this dependency is 9-18.6s, so any probe under it is guaranteed to fail.
  assert.ok(
    snapshot.off_request_probe_timeout_ms >= 9000,
    `probe timeout ${snapshot.off_request_probe_timeout_ms}ms cannot clear a 9-18.6s cold search`,
  );
  resetCircuit();
});

test('a FAILING off-request probe does not extend the cooldown', async () => {
  resetCircuit();
  const openedAt = Date.now();
  for (let i = 0; i < 3; i += 1) __internal.markRecoCatalogFailFastFailure('all_queries_failed', openedAt);
  const before = __internal.getRecoCatalogFailFastSnapshot(openedAt);
  const failuresBefore = before.consecutive_failures;
  clearTimeout(__internal.recoCatalogFailFastState.off_request_probe_timer);
  __internal.recoCatalogFailFastState.off_request_probe_timer = null;

  // PIVOTA_BACKEND_BASE_URL points at a .test host that never resolves, so the probe fails for real.
  await __internal.runRecoCatalogFailFastOffRequestProbe();

  const after = __internal.getRecoCatalogFailFastSnapshot(openedAt);
  // Mutant killed: calling markRecoCatalogFailFastFailure from the probe. Each failed probe would
  // push open_until_ms forward by another full cooldown, so the circuit could never close on its own
  // -- exactly the metastable state this change exists to remove.
  assert.equal(after.consecutive_failures, failuresBefore, 'a probe failure is not request evidence');
  assert.equal(after.open_until_ms, before.open_until_ms, 'the cooldown must not move');
  assert.ok(__internal.recoCatalogFailFastState.last_off_request_probe_failed_at > 0);
  resetCircuit();
});

test('collectRecoRecallPlanQueryTexts prefers plan entries and falls back to query levels', () => {
  assert.deepEqual(
    __internal.collectRecoRecallPlanQueryTexts({
      recallPlan: { entries: [{ query: 'cleanser' }, { query: ' gentle cleanser ' }, { query: '' }] },
      queryLevels: [{ queries: [{ query: 'ignored' }] }],
    }),
    ['cleanser', 'gentle cleanser'],
  );
  // Mutant killed: reading only one of the two shapes. The generic ladder has no recallPlan and the
  // step-aware path has no useful queryLevels; keying off the wrong one silently disables the cache
  // for half the lane.
  assert.deepEqual(
    __internal.collectRecoRecallPlanQueryTexts({
      recallPlan: null,
      queryLevels: [{ queries: [{ query: 'moisturizer' }] }, { queries: [{ query: 'sunscreen' }] }],
    }),
    ['moisturizer', 'sunscreen'],
  );
  assert.deepEqual(__internal.collectRecoRecallPlanQueryTexts({}), []);
});

test('a cached pool is re-SELECTED against this request, not replayed as a ranking', () => {
  const pool = [
    { product_id: 'p1', merchant_id: 'm1', name: 'Gentle Cleanser', product_type: 'cleanser' },
    { product_id: 'p2', merchant_id: 'm1', name: 'Hydrating Toner', product_type: 'toner' },
  ];
  const collected = __internal.buildRecoCollectedFromCachedPool(pool, {
    targetContext: { step_aware_intent: true, resolved_target_step: 'cleanser', framework_roles: [] },
  });
  // Mutant killed: returning the cached pool as `candidateState` verbatim. Only RECALL is cacheable;
  // SELECTION depends on this request's target context and must be recomputed. A replayed pool would
  // surface the toner for a cleanser request, and would carry none of the finalizer's own fields --
  // so assert the step filtering actually happened, not merely that some object exists.
  assert.equal(collected.rawCandidates.length, 2);
  const state = collected.candidateState;
  assert.ok(state, 'a candidate state must be computed, not inherited');
  assert.equal(state.raw_candidate_count, 2, 'the finalizer must have seen both cached candidates');
  assert.equal(state.exact_step_viable_count, 1, 'only the cleanser matches the declared step');
  assert.equal(state.selected_recommendations.length, 1);
  assert.equal(state.selected_recommendations[0].product_id, 'p1');
  assert.equal(typeof state.candidate_pool_signature, 'string');
  assert.equal(typeof state.reco_policy_version, 'string');

  // The same cached pool under a DIFFERENT declared step must select differently.
  const asToner = __internal.buildRecoCollectedFromCachedPool(pool, {
    targetContext: { step_aware_intent: true, resolved_target_step: 'toner', framework_roles: [] },
  });
  assert.equal(asToner.candidateState.selected_recommendations[0].product_id, 'p2');

  assert.equal(collected.transportPolicyMode, 'pool_cache');
  assert.deepEqual(collected.searchResults, []);
  assert.equal(collected.executedQueryCount, 0);
});

test('a recall whose every result failed is NOT written to the durable cache', () => {
  // Mutant killed: writing unconditionally. A pool assembled from timeouts would pin a transient
  // dependency failure into a store that outlives the deploy -- the exact opposite of the goal.
  assert.equal(
    __internal.extractRecoRecallPoolForCache({
      searchResults: [{ ok: false, reason: 'upstream_timeout' }, { ok: false, reason: 'upstream_error' }],
      rawCandidates: [],
    }),
    null,
  );
  // A successful search that legitimately found nothing IS written (it earns the 60s negative lease).
  assert.deepEqual(
    __internal.extractRecoRecallPoolForCache({ searchResults: [{ ok: true, products: [] }], rawCandidates: [] }),
    [],
  );
  const many = Array.from({ length: 100 }, (_, i) => ({ product_id: `p${i}` }));
  assert.equal(
    __internal.extractRecoRecallPoolForCache({ searchResults: [{ ok: true }], rawCandidates: many }).length,
    24,
  );
  assert.equal(__internal.extractRecoRecallPoolForCache(null), null);
});

test('while the circuit is OPEN the grounding pass serves the pool instead of being skipped', async () => {
  resetCircuit();
  const originalQuery = dbModule.query;
  const poolRow = {
    payload: [
      { product_id: 'p1', merchant_id: 'm1', name: 'Gentle Cleanser', product_type: 'cleanser', price: 22 },
    ],
    refreshed_at: new Date().toISOString(),
  };
  dbModule.query = async (sql) => (/SELECT payload/.test(sql) ? { rows: [poolRow] } : { rows: [], rowCount: 0 });
  try {
    for (let i = 0; i < 3; i += 1) __internal.markRecoCatalogFailFastFailure('all_queries_failed');
    assert.equal(__internal.getRecoCatalogFailFastSnapshot().open, true);

    const out = await __internal.groundRecoRecommendationsFromCatalog({
      recommendations: [{ name: 'A gentle cleanser', step: 'cleanser', product_type: 'cleanser' }],
      ctx: { lang: 'EN' },
      logger: null,
      defaultTargetContext: null,
    });
    // Mutant killed: restoring the wholesale `catalog_skipped_fail_fast` early return. That is what
    // turns a 15-second dependency blip into "every recommendation is an archetype" -- the grounding
    // pass was skipped for the entire cooldown even though a usable pool was sitting in Postgres.
    assert.notEqual(out.mainline_status, 'catalog_skipped_fail_fast');
    assert.equal(out.catalog_skip_reason, 'fail_fast_open_served_from_pool_cache');
    assert.equal(out.debug.fail_fast_open, true);
    assert.equal(out.debug.pool_cache_served_item_count, 1);
  } finally {
    dbModule.query = originalQuery;
    resetCircuit();
  }
});

test('with the circuit open and NO cached pool, the item stays ungrounded rather than throwing', async () => {
  resetCircuit();
  const originalQuery = dbModule.query;
  dbModule.query = async () => ({ rows: [], rowCount: 0 });
  try {
    for (let i = 0; i < 3; i += 1) __internal.markRecoCatalogFailFastFailure('all_queries_failed');
    const out = await __internal.groundRecoRecommendationsFromCatalog({
      recommendations: [{ name: 'A gentle cleanser', step: 'cleanser', product_type: 'cleanser' }],
      ctx: { lang: 'EN' },
      logger: null,
      defaultTargetContext: null,
    });
    // Mutant killed: falling through to a live search while the circuit is open -- that is the
    // stampede the circuit exists to prevent.
    assert.equal(out.recommendations.length, 1);
    assert.equal(out.grounded_count, 0);
    assert.equal(out.debug.pool_cache_served_item_count, 0);
    assert.equal(out.debug.query_count, 0, 'no upstream query may be issued while the circuit is open');
  } finally {
    dbModule.query = originalQuery;
    resetCircuit();
  }
});
