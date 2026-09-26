const { Client } = require('pg');

// The activity store now pages aurora_activity_events with a keyset predicate in SQL:
//
//   WHERE … AND (occurred_at_ms < $ts OR (occurred_at_ms = $ts AND activity_id COLLATE "C" < $id))
//   ORDER BY occurred_at_ms DESC, activity_id COLLATE "C" DESC  LIMIT n+1
//
// and merges in-memory rows ordered by a JS comparator. The two only page correctly if they order
// ties IDENTICALLY — otherwise a page boundary inside a same-millisecond tie skips or repeats rows.
// Nothing about that is visible to the in-memory route suite, which never issues this SQL, so it is
// pinned here against real PostgreSQL, with activity_id values in every format production writes
// plus the ones that make collations disagree.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

// Real formats: memoryStore's `act_<base36 millis>_<rand>`, this store's `act_<uuid>`, 028's
// backfill `act_<md5>`. Plus the characters that split byte order from en_US / ICU ordering:
// '_' vs '-', case, and a non-ASCII id (activity_id is client-influenced text).
const TIE_IDS = [
  'act_mf2x9k1a_3kd9s0a1',
  'act_mf2x9k1a-3kd9s0a1',
  'act_1f0e5c9a-7b2d-4e11-9c3a-5b6d7e8f9a0b',
  'act_1f0e5c9a_7b2d_4e11_9c3a_5b6d7e8f9a0b',
  'act_9b2f4c6d8e0a1b3c5d7e9f1a',
  'act_ABCDEF',
  'act_abcdef',
  'act_é_accented',
  'act_z',
  'act_',
  'act_Z',
];

suite('activity store keyset pagination on PostgreSQL', () => {
  let db;
  let schema;
  let calls;
  let priorEnv;

  const insert = async ({ activityId, auroraUid = 'guest_1', userId = null, eventType = 'chat_started', occurredAtMs, payload = {} }) => {
    await db.query(
      `INSERT INTO aurora_activity_events (activity_id, aurora_uid, user_id, event_type, payload, occurred_at_ms)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [activityId, auroraUid, userId, eventType, JSON.stringify(payload), occurredAtMs],
    );
  };

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `act_keyset_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    // 027's table shape.
    await db.query(`
      CREATE TABLE aurora_activity_events (
        id BIGSERIAL PRIMARY KEY,
        activity_id TEXT NOT NULL UNIQUE,
        aurora_uid TEXT,
        user_id TEXT,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        deeplink TEXT,
        source TEXT,
        occurred_at_ms BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
  }, 60000);

  afterAll(async () => {
    if (db) {
      try {
        await db.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await db.end();
      }
    }
  });

  beforeEach(async () => {
    priorEnv = { ...process.env };
    process.env.AURORA_BFF_RETENTION_DAYS = '30'; // persistence ON: the SQL path is the subject
    calls = [];
    jest.resetModules(); // a fresh in-memory store per test
    jest.doMock('../../src/db', () => ({
      query: async (sql, params) => {
        calls.push({ sql, params });
        return db.query(sql, params);
      },
      withClient: async (fn) => fn({ query: (sql, params) => db.query(sql, params) }),
    }));
    await db.query('TRUNCATE aurora_activity_events');
  });

  afterEach(() => {
    process.env = priorEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
  });

  const store = () => require('../../src/auroraBff/activityStore');

  // Every page, following the store's own cursor token.
  const pageAll = async (args, limit) => {
    const { listActivityForIdentity } = store();
    const out = [];
    let cursor = null;
    for (let guard = 0; guard < 500; guard += 1) {
      const page = await listActivityForIdentity({ ...args, limit, cursor });
      out.push(...page.items);
      if (page.next_cursor) expect(page.items).toHaveLength(limit);
      if (!page.next_cursor) return out;
      cursor = page.next_cursor;
    }
    throw new Error('pagination did not terminate');
  };

  test('the collation choice is load-bearing: default order disagrees with byte order on these ids', async () => {
    // The control. If the database's default collation happened to order these ids like bytes, the
    // COLLATE "C" in the query would be untested decoration.
    const { compareActivityIdBytes } = store().__internal;
    for (const id of TIE_IDS) await insert({ activityId: id, occurredAtMs: 1000 });
    const byDefault = (await db.query('SELECT activity_id FROM aurora_activity_events ORDER BY activity_id DESC'))
      .rows.map((r) => r.activity_id);
    const byC = (await db.query('SELECT activity_id FROM aurora_activity_events ORDER BY activity_id COLLATE "C" DESC'))
      .rows.map((r) => r.activity_id);
    const byJsBytes = [...TIE_IDS].sort((a, b) => compareActivityIdBytes(b, a));
    const byLocaleCompare = [...TIE_IDS].sort((a, b) => b.localeCompare(a));

    expect(byC).toEqual(byJsBytes); // the two sides the fix relies on agree exactly
    expect(byDefault).not.toEqual(byC); // ...and the database's default would not have
    expect(byLocaleCompare).not.toEqual(byJsBytes); // ...nor would the old localeCompare
  });

  test('every page size walks a tie group exactly once, in byte order', async () => {
    const { compareEventsDesc } = store().__internal;
    // One large tie group, plus distinct timestamps on both sides of it.
    for (const id of TIE_IDS) await insert({ activityId: id, occurredAtMs: 5000 });
    for (let i = 0; i < 9; i += 1) {
      await insert({ activityId: `act_before_${i}`, occurredAtMs: 4000 + i });
      await insert({ activityId: `act_after_${i}`, occurredAtMs: 6000 + i });
    }
    const expected = (await db.query(
      `SELECT activity_id, occurred_at_ms FROM aurora_activity_events
        ORDER BY occurred_at_ms DESC, activity_id COLLATE "C" DESC`,
    )).rows.map((r) => r.activity_id);

    for (const limit of [1, 2, 3, 5, 7, 11]) {
      const items = await pageAll({ auroraUid: 'guest_1' }, limit);
      const ids = items.map((item) => item.activity_id);
      expect([limit, ids]).toEqual([limit, expected]);
      expect([...items].sort(compareEventsDesc).map((item) => item.activity_id)).toEqual(ids);
    }
  }, 60000);

  test('the cursor is applied in SQL, and each query fetches one page plus one row', async () => {
    for (let i = 0; i < 30; i += 1) await insert({ activityId: `act_row_${String(i).padStart(2, '0')}`, occurredAtMs: 7000 + i });
    const { listActivityForIdentity } = store();
    const first = await listActivityForIdentity({ auroraUid: 'guest_1', limit: 10 });
    calls.length = 0;
    const second = await listActivityForIdentity({ auroraUid: 'guest_1', limit: 10, cursor: first.next_cursor });
    const listCall = calls.find((call) => call.sql.includes('FROM aurora_activity_events'));
    expect(listCall.sql).toContain('activity_id COLLATE "C" <');
    expect(listCall.sql).toContain('ORDER BY occurred_at_ms DESC, activity_id COLLATE "C" DESC');
    expect(listCall.params[listCall.params.length - 1]).toBe(11);
    expect(second.items.map((item) => item.occurred_at_ms)).toEqual(
      Array.from({ length: 10 }, (_, i) => 7019 - i),
    );
  });

  test('a decoded cursor object pages exactly like the encoded token', async () => {
    // The route passes its own already-decoded cursor; the store must treat it identically.
    for (const id of TIE_IDS) await insert({ activityId: id, occurredAtMs: 8000 });
    const { listActivityForIdentity, __internal } = store();
    const first = await listActivityForIdentity({ auroraUid: 'guest_1', limit: 4 });
    const viaToken = await listActivityForIdentity({ auroraUid: 'guest_1', limit: 4, cursor: first.next_cursor });
    const viaObject = await listActivityForIdentity({
      auroraUid: 'guest_1',
      limit: 4,
      cursor: __internal.decodeCursor(first.next_cursor),
    });
    expect(viaObject.items.map((i) => i.activity_id)).toEqual(viaToken.items.map((i) => i.activity_id));
    expect(viaObject.next_cursor).toEqual(viaToken.next_cursor);
  });

  test('a signed-in identity pages across its user_id AND its guest aurora_uid rows', async () => {
    for (let i = 0; i < 12; i += 1) {
      await insert({ activityId: `act_user_${i}`, userId: 'user_1', auroraUid: null, occurredAtMs: 9000 + i * 2 });
      await insert({ activityId: `act_guest_${i}`, auroraUid: 'guest_1', occurredAtMs: 9000 + i * 2 + 1 });
    }
    await insert({ activityId: 'act_someone_else', auroraUid: 'guest_2', occurredAtMs: 9500 });
    const ids = (await pageAll({ userId: 'user_1', auroraUid: 'guest_1' }, 5)).map((i) => i.activity_id);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
    expect(ids).not.toContain('act_someone_else');
  });

  test('a type filter pages through all matching rows', async () => {
    for (let i = 0; i < 40; i += 1) {
      await insert({ activityId: `act_t_${i}`, eventType: i % 2 ? 'tracker_logged' : 'chat_started', occurredAtMs: 10000 + i });
    }
    const items = await pageAll({ auroraUid: 'guest_1', eventTypes: ['tracker_logged'] }, 6);
    expect(items).toHaveLength(20);
    expect(items.every((i) => i.event_type === 'tracker_logged')).toBe(true);
  });

  test('in-memory rows merge with database rows exactly once across pages', async () => {
    // appendActivityForIdentity writes BOTH the in-memory store and the table, so every row it makes
    // is present twice; rows inserted directly exist only in the table.
    const { appendActivityForIdentity } = store();
    for (let i = 0; i < 15; i += 1) {
      await appendActivityForIdentity({ auroraUid: 'guest_1', eventType: 'chat_started', occurredAtMs: 11000 + i * 2 });
      await insert({ activityId: `act_db_only_${i}`, occurredAtMs: 11000 + i * 2 + 1 });
    }
    const ids = (await pageAll({ auroraUid: 'guest_1' }, 4)).map((i) => i.activity_id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });

  test('the lookup searches a signed-in identity\u2019s user_id rows AND its guest rows', async () => {
    // A signed-in history is split across both ids. An explicit event stored under user_id only must
    // still be found when the caller carries both, or its synthetic twin is shown a second time.
    await insert({ activityId: 'act_user_only', auroraUid: null, userId: 'user_9', eventType: 'skin_analysis', occurredAtMs: 1, payload: { artifact_id: 'art_user' } });
    await insert({ activityId: 'act_guest_only', auroraUid: 'guest_9', eventType: 'skin_analysis', occurredAtMs: 2, payload: { artifact_id: 'art_guest' } });
    const { listExplicitArtifactIdsForIdentity } = store();
    const both = await listExplicitArtifactIdsForIdentity({ userId: 'user_9', auroraUid: 'guest_9', artifactIds: ['art_user', 'art_guest'] });
    expect([...both].sort()).toEqual(['art_guest', 'art_user']);
    // Control: the guest id alone cannot see the user_id row, so the assertion above depends on userId.
    const guestOnly = await listExplicitArtifactIdsForIdentity({ auroraUid: 'guest_9', artifactIds: ['art_user', 'art_guest'] });
    expect([...guestOnly]).toEqual(['art_guest']);
  });

  test('PostgreSQL rejects the cursors the route must refuse — so the route guard is load-bearing', async () => {
    // The route turns these into 400s before the store. Called directly, the store binds them and
    // PostgreSQL raises; through the route that error would be reported as 503 DB_UNAVAILABLE.
    await insert({ activityId: 'act_guard', occurredAtMs: 5 });
    const { listActivityForIdentity } = store();
    await expect(
      listActivityForIdentity({ auroraUid: 'guest_1', limit: 5, cursor: { occurred_at_ms: 1e19, activity_id: 'act_x' } }),
    ).rejects.toMatchObject({ code: '22003' });
    await expect(
      listActivityForIdentity({ auroraUid: 'guest_1', limit: 5, cursor: { occurred_at_ms: 5, activity_id: `act${String.fromCharCode(0)}x` } }),
    ).rejects.toMatchObject({ code: '22021' });
  });

  test('explicit artifact references are found across the whole history, scoped to the identity', async () => {
    await insert({ activityId: 'act_ref_1', eventType: 'skin_analysis', occurredAtMs: 1, payload: { artifact_id: 'art_1' } });
    await insert({ activityId: 'act_ref_2', eventType: 'skin_analysis', occurredAtMs: 99999, payload: { artifact_id: ' art_2 ' } });
    await insert({ activityId: 'act_wrong_type', eventType: 'chat_started', occurredAtMs: 2, payload: { artifact_id: 'art_3' } });
    await insert({ activityId: 'act_other_ident', auroraUid: 'guest_2', eventType: 'skin_analysis', occurredAtMs: 3, payload: { artifact_id: 'art_4' } });
    const { listExplicitArtifactIdsForIdentity } = store();
    const found = await listExplicitArtifactIdsForIdentity({
      auroraUid: 'guest_1',
      artifactIds: ['art_1', 'art_2', 'art_3', 'art_4', 'art_missing'],
    });
    // art_2 is stored with surrounding whitespace, which the route trims before comparing.
    expect([...found].sort()).toEqual(['art_1', 'art_2']);
  });
});
