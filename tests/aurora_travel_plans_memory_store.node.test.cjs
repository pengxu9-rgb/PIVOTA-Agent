const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const MEMORY_STORE_MODULE = '../src/auroraBff/memoryStore';

function parseJsonParam(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;
  const first = text[0];
  if (first !== '{' && first !== '[' && first !== '"') return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function loadMemoryStoreWithDbStub() {
  const originalLoad = Module._load;
  const previousRetention = process.env.AURORA_BFF_RETENTION_DAYS;
  process.env.AURORA_BFF_RETENTION_DAYS = '30';

  const guestRows = new Map();
  const accountRows = new Map();
  const sqlCalls = [];

  const query = async (sqlRaw, params = []) => {
    const sql = normalizeSql(sqlRaw);
    sqlCalls.push(sql);

    if (
      sql.includes('INSERT INTO aurora_user_profiles (aurora_uid)') &&
      sql.includes('ON CONFLICT (aurora_uid) DO NOTHING')
    ) {
      const uid = String(params[0] || '').trim();
      if (uid && !guestRows.has(uid)) guestRows.set(uid, { aurora_uid: uid });
      return { rows: [] };
    }

    if (
      sql.includes('INSERT INTO aurora_account_profiles (user_id)') &&
      sql.includes('ON CONFLICT (user_id) DO NOTHING')
    ) {
      const userId = String(params[0] || '').trim();
      if (userId && !accountRows.has(userId)) accountRows.set(userId, { user_id: userId });
      return { rows: [] };
    }

    if (
      sql.includes('SELECT * FROM aurora_user_profiles') &&
      sql.includes('WHERE aurora_uid = $1')
    ) {
      const uid = String(params[0] || '').trim();
      const row = uid ? guestRows.get(uid) : null;
      return { rows: row ? [row] : [] };
    }

    if (
      sql.includes('SELECT * FROM aurora_account_profiles') &&
      sql.includes('WHERE user_id = $1')
    ) {
      const userId = String(params[0] || '').trim();
      const row = userId ? accountRows.get(userId) : null;
      return { rows: row ? [row] : [] };
    }

    if (
      sql.includes('INSERT INTO aurora_user_profiles (') &&
      sql.includes('ON CONFLICT (aurora_uid) DO UPDATE SET')
    ) {
      const uid = String(params[0] || '').trim();
      const row = {
        ...(guestRows.get(uid) || { aurora_uid: uid }),
        skin_type: params[1] ?? null,
        sensitivity: params[2] ?? null,
        barrier_status: params[3] ?? null,
        goals: parseJsonParam(params[4]),
        region: params[5] ?? null,
        budget_tier: params[6] ?? null,
        current_routine: parseJsonParam(params[7]),
        itinerary: parseJsonParam(params[8]),
        travel_plan: parseJsonParam(params[9]),
        travel_plans: parseJsonParam(params[10]),
        contraindications: parseJsonParam(params[11]),
        chat_context: parseJsonParam(params[12]),
        safety_prompt_state: parseJsonParam(params[13]),
        lang_pref: params[14] ?? null,
      };
      guestRows.set(uid, row);
      return { rows: [] };
    }

    if (
      sql.includes('INSERT INTO aurora_account_profiles (') &&
      sql.includes('ON CONFLICT (user_id) DO UPDATE SET')
    ) {
      const userId = String(params[0] || '').trim();
      const row = {
        ...(accountRows.get(userId) || { user_id: userId }),
        skin_type: params[1] ?? null,
        sensitivity: params[2] ?? null,
        barrier_status: params[3] ?? null,
        goals: parseJsonParam(params[4]),
        region: params[5] ?? null,
        budget_tier: params[6] ?? null,
        current_routine: parseJsonParam(params[7]),
        itinerary: parseJsonParam(params[8]),
        travel_plan: parseJsonParam(params[9]),
        travel_plans: parseJsonParam(params[10]),
        contraindications: parseJsonParam(params[11]),
        chat_context: parseJsonParam(params[12]),
        safety_prompt_state: parseJsonParam(params[13]),
        lang_pref: params[14] ?? null,
      };
      accountRows.set(userId, row);
      return { rows: [] };
    }

    throw new Error(`Unhandled SQL in test stub: ${sql}`);
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (
      request === '../db' &&
      parent &&
      typeof parent.filename === 'string' &&
      parent.filename.endsWith('/src/auroraBff/memoryStore.js')
    ) {
      return { query };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const moduleId = require.resolve(MEMORY_STORE_MODULE);
  delete require.cache[moduleId];
  const memoryStore = require(MEMORY_STORE_MODULE);

  const cleanup = () => {
    Module._load = originalLoad;
    delete require.cache[moduleId];
    if (previousRetention === undefined) delete process.env.AURORA_BFF_RETENTION_DAYS;
    else process.env.AURORA_BFF_RETENTION_DAYS = previousRetention;
  };

  return { memoryStore, sqlCalls, cleanup };
}

test('memoryStore persists travel plan fields for guest identity', async (t) => {
  const { memoryStore, sqlCalls, cleanup } = loadMemoryStoreWithDbStub();
  t.after(cleanup);

  const auroraUid = `guest_${Date.now()}`;
  await memoryStore.upsertProfileForIdentity(
    { auroraUid, userId: null },
    {
      travel_plans: [
        {
          destination: 'Tokyo',
          start_date: '2099-03-01',
          end_date: '2099-03-05',
          itinerary: 'Mostly outdoor daytime and one red-eye flight.',
        },
      ],
    },
  );

  const first = await memoryStore.getProfileForIdentity({ auroraUid, userId: null });
  assert.ok(first);
  assert.ok(Array.isArray(first.travel_plans));
  assert.equal(first.travel_plans.length, 1);
  assert.equal(first.travel_plans[0].destination, 'Tokyo');
  assert.equal(typeof first.travel_plans[0].trip_id, 'string');
  assert.ok(first.travel_plans[0].trip_id.length > 0);
  assert.ok(first.travel_plan && first.travel_plan.destination);

  await memoryStore.upsertProfileForIdentity(
    { auroraUid, userId: null },
    {
      travel_plans: [
        {
          destination: 'Paris',
          start_date: '2099-04-10',
          end_date: '2099-04-14',
        },
      ],
    },
  );

  const second = await memoryStore.getProfileForIdentity({ auroraUid, userId: null });
  assert.ok(second);
  assert.ok(Array.isArray(second.travel_plans));
  assert.equal(second.travel_plans.length, 2);
  const destinations = second.travel_plans.map((item) => item.destination).sort();
  assert.deepEqual(destinations, ['Paris', 'Tokyo']);
  assert.ok(second.travel_plan && typeof second.travel_plan === 'object');

  const userUpsertSql = sqlCalls.find((sql) => sql.includes('INSERT INTO aurora_user_profiles (') && sql.includes('skin_type'));
  assert.ok(userUpsertSql, 'expected user profile upsert SQL to be called');
  assert.match(userUpsertSql, /\btravel_plan\b/);
  assert.match(userUpsertSql, /\btravel_plans\b/);
});

test('memoryStore persists travel plan fields for account identity', async (t) => {
  const { memoryStore, sqlCalls, cleanup } = loadMemoryStoreWithDbStub();
  t.after(cleanup);

  const userId = `acct_${Date.now()}`;
  await memoryStore.upsertProfileForIdentity(
    { auroraUid: null, userId },
    {
      travel_plans: [
        {
          destination: 'Seoul',
          start_date: '2099-06-01',
          end_date: '2099-06-04',
        },
      ],
    },
  );

  const profile = await memoryStore.getProfileForIdentity({ auroraUid: null, userId });
  assert.ok(profile);
  assert.ok(Array.isArray(profile.travel_plans));
  assert.equal(profile.travel_plans.length, 1);
  assert.equal(profile.travel_plans[0].destination, 'Seoul');
  assert.ok(profile.travel_plan && profile.travel_plan.destination);

  const accountUpsertSql = sqlCalls.find((sql) =>
    sql.includes('INSERT INTO aurora_account_profiles (') && sql.includes('skin_type'),
  );
  assert.ok(accountUpsertSql, 'expected account profile upsert SQL to be called');
  assert.match(accountUpsertSql, /\btravel_plan\b/);
  assert.match(accountUpsertSql, /\btravel_plans\b/);
});
