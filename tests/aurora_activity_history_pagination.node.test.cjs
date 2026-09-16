// GET /v1/activity must page through the WHOLE history, not the newest 100 items.
//
// The route used to call listActivityForIdentity with a large limit and NO cursor, then apply the
// cursor itself in JS. listActivityForIdentity clamps any limit to 100, so the route only ever saw
// the newest 100 explicit events: paging past them returned an empty page with next_cursor: null,
// i.e. the client was told history had ENDED. Measured on main before the fix, persistence off:
//   logged=150 -> paged out 100 · logged=250 -> 100 · logged=400 -> 100 (90 -> 90).
//
// These run the real route and the real activity store (in-memory persistence, as the existing
// activity API suite does). Diagnosis artifacts are injected so their timestamps can be interleaved
// with events — which is the only way to put a synthetic item and the explicit event that should
// hide it on DIFFERENT pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

process.env.AURORA_BFF_RETENTION_DAYS = '0';
delete process.env.DATABASE_URL;

const { mountActivityRoutes } = require('../src/auroraBff/routes/activityRoutes');

let uidSeq = 0;
function freshUid(label) {
  uidSeq += 1;
  return `hist_${label}_${process.pid}_${Date.now()}_${uidSeq}`;
}

function buildApp({ artifactsByUid = {} } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountActivityRoutes(app, {
    logger: null,
    requireAuroraUid: (ctx) => {
      if (!ctx || !ctx.aurora_uid) {
        const err = new Error('missing uid');
        err.status = 400;
        throw err;
      }
    },
    resolveIdentity: async (req) => ({
      auroraUid: req.get('X-Aurora-UID') || null,
      userId: req.get('X-User-ID') || null,
    }),
    classifyStorageError: () => ({}),
    listDiagnosisArtifactsForIdentity: async ({ auroraUid }) => artifactsByUid[auroraUid] || [],
  });
  return app;
}

const headersFor = (uid) => ({ 'X-Aurora-UID': uid, 'X-Trace-ID': `t_${uid}`, 'X-Brief-ID': `b_${uid}`, 'X-Lang': 'EN' });

async function log(app, uid, body) {
  const res = await supertest(app).post('/v1/activity/log').set(headersFor(uid)).send(body);
  assert.equal(res.status, 200, `log failed: ${JSON.stringify(res.body)}`);
  return res.body.activity_id;
}

// Follows next_cursor to the end. Returns every item in the order served, plus the page count.
async function pageAll(app, uid, { limit, types } = {}) {
  const items = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (types) qs.set('types', types);
    if (cursor) qs.set('cursor', cursor);
    const res = await supertest(app).get(`/v1/activity?${qs}`).set(headersFor(uid));
    assert.equal(res.status, 200, `list failed: ${JSON.stringify(res.body)}`);
    pages += 1;
    items.push(...res.body.items);
    // A page may only be short when it is the last one.
    if (res.body.next_cursor) assert.equal(res.body.items.length, limit, 'a non-final page came back short');
    cursor = res.body.next_cursor;
    if (!cursor) break;
    assert.ok(pages < 500, 'pagination did not terminate');
  }
  return { items, pages };
}

// The order the store and route must agree on: newest first, then activity_id in UTF-8 BYTE order
// descending — the same order PostgreSQL gives `activity_id COLLATE "C" DESC`.
function byteOrderDesc(a, b) {
  if (a.occurred_at_ms !== b.occurred_at_ms) return b.occurred_at_ms - a.occurred_at_ms;
  return Buffer.compare(Buffer.from(String(b.activity_id), 'utf8'), Buffer.from(String(a.activity_id), 'utf8'));
}

function assertExactlyOnceInOrder(items, expectedCount) {
  const ids = items.map((item) => item.activity_id);
  assert.equal(new Set(ids).size, ids.length, 'an item was served on more than one page');
  assert.equal(ids.length, expectedCount, `expected ${expectedCount} items across all pages, got ${ids.length}`);
  const sorted = [...items].sort(byteOrderDesc).map((item) => item.activity_id);
  assert.deepEqual(ids, sorted, 'items were not served in (occurred_at_ms, activity_id) order');
}

test('history past 100 events is reachable, exactly once, in order', async () => {
  const app = buildApp();
  const uid = freshUid('deep');
  for (let i = 1; i <= 250; i += 1) {
    await log(app, uid, { event_type: 'chat_started', occurred_at_ms: 1_000_000 + i, payload: { n: i } });
  }
  const { items, pages } = await pageAll(app, uid, { limit: 50 });
  assertExactlyOnceInOrder(items, 250);
  assert.equal(pages, 5);
  assert.equal(items[items.length - 1].occurred_at_ms, 1_000_001, 'the OLDEST event must be reachable');
});

test('an odd page size walks the whole history without gaps at page boundaries', async () => {
  const app = buildApp();
  const uid = freshUid('odd');
  for (let i = 1; i <= 130; i += 1) {
    await log(app, uid, { event_type: 'tracker_logged', occurred_at_ms: 2_000_000 + i, payload: { n: i } });
  }
  const { items, pages } = await pageAll(app, uid, { limit: 7 });
  assertExactlyOnceInOrder(items, 130);
  assert.equal(pages, Math.ceil(130 / 7));
});

test('events sharing one timestamp are served exactly once across page boundaries', async () => {
  // Every event on the same millisecond, so EVERY page boundary falls inside a tie and only the
  // activity_id tiebreak separates "already served" from "not yet served". A tiebreak that orders
  // one way and filters another skips or repeats rows here.
  const app = buildApp();
  const uid = freshUid('ties');
  for (let i = 1; i <= 120; i += 1) {
    await log(app, uid, { event_type: 'profile_updated', occurred_at_ms: 3_000_000, payload: { n: i } });
  }
  const { items } = await pageAll(app, uid, { limit: 13 });
  assertExactlyOnceInOrder(items, 120);
});

test('a type filter pages through every matching event, not the newest 100 of all types', async () => {
  const app = buildApp();
  const uid = freshUid('types');
  for (let i = 1; i <= 120; i += 1) {
    await log(app, uid, { event_type: 'tracker_logged', occurred_at_ms: 4_000_000 + i * 2, payload: { n: i } });
    await log(app, uid, { event_type: 'chat_started', occurred_at_ms: 4_000_000 + i * 2 + 1, payload: { n: i } });
  }
  const { items } = await pageAll(app, uid, { limit: 25, types: 'tracker_logged' });
  assertExactlyOnceInOrder(items, 120);
  assert.ok(items.every((item) => item.event_type === 'tracker_logged'));
});

test('synthetic artifact items page correctly, and stay hidden when their explicit event is on another page', async () => {
  const uid = freshUid('artifacts');
  const base = 5_000_000_000;
  // 40 diagnosis artifacts interleaved with 150 events, one artifact every ~4 events.
  const artifacts = Array.from({ length: 40 }, (_, i) => ({
    artifact_id: `art_${String(i).padStart(3, '0')}`,
    session_id: `sess_${i}`,
    created_at: new Date(base + i * 4 * 1000 + 500).toISOString(),
    artifact_json: { analysis_context: { analysis_source: 'photo' } },
  }));
  const app = buildApp({ artifactsByUid: { [uid]: artifacts } });
  for (let i = 0; i < 150; i += 1) {
    await log(app, uid, { event_type: 'chat_started', occurred_at_ms: base + i * 1000, payload: { n: i } });
  }
  // Explicit skin_analysis events for the 10 NEWEST artifacts, logged at timestamps OLDER than every
  // other item — so each explicit event is served on the LAST page while its artifact would have
  // been on an early one. Deduping only against the page being built cannot see them.
  const referenced = artifacts.slice(30).map((art) => art.artifact_id);
  for (let i = 0; i < referenced.length; i += 1) {
    await log(app, uid, {
      event_type: 'skin_analysis',
      occurred_at_ms: base - 100_000 - i,
      payload: { artifact_id: referenced[i] },
    });
  }

  const { items } = await pageAll(app, uid, { limit: 20 });
  const syntheticIds = items.filter((item) => String(item.activity_id).startsWith('artifact:'));
  const servedArtifactIds = new Set(syntheticIds.map((item) => String(item.activity_id).slice('artifact:'.length)));

  // 150 chat events + 10 explicit skin_analysis events + the 30 UNreferenced artifacts.
  assertExactlyOnceInOrder(items, 150 + 10 + 30);
  for (const id of referenced) {
    assert.ok(!servedArtifactIds.has(id), `artifact ${id} was served as a synthetic duplicate of its explicit event`);
  }
  assert.equal(servedArtifactIds.size, 30);
});

test('a tie mixing explicit events and synthetic ids that split byte order from localeCompare pages exactly once', async () => {
  // The route-generated ids above are all `act_<uuid>`, where localeCompare and byte order happen to
  // agree — so a route that still sorted or filtered with localeCompare would pass them. Artifact ids
  // are chosen here ('_' vs '-', case, non-ASCII), and every item shares ONE timestamp with the
  // explicit events, so every page boundary lands inside a tie that the two orders disagree on.
  const uid = freshUid('mixedtie');
  const T = 6_000_000_000;
  const artifactIds = ['a_b', 'a-b', 'A1', 'a1', 'Z', 'z', 'é', 'e_', 'e-'];
  const artifacts = artifactIds.map((id, i) => ({
    artifact_id: id,
    session_id: `sess_mixed_${i}`,
    created_at: new Date(T).toISOString(),
    artifact_json: { analysis_context: { analysis_source: 'photo' } },
  }));
  const syntheticIds = artifactIds.map((id) => `artifact:${id}`);
  assert.notDeepEqual(
    [...syntheticIds].sort((a, b) => b.localeCompare(a)),
    [...syntheticIds].sort((a, b) => Buffer.compare(Buffer.from(b), Buffer.from(a))),
    'control: these ids must order differently under localeCompare and byte order',
  );
  const app = buildApp({ artifactsByUid: { [uid]: artifacts } });
  for (let i = 0; i < 20; i += 1) {
    await log(app, uid, { event_type: 'chat_started', occurred_at_ms: T, payload: { n: i } });
  }
  for (const limit of [1, 3, 4]) {
    const { items } = await pageAll(app, uid, { limit });
    assertExactlyOnceInOrder(items, 20 + artifactIds.length);
  }
});
