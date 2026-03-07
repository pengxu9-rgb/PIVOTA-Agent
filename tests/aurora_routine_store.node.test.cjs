const test = require('node:test');
const assert = require('node:assert/strict');

const dbModuleId = require.resolve('../src/db');
const storeModuleId = require.resolve('../src/auroraBff/routineStore');

function loadRoutineStoreWithQuery(queryImpl) {
  delete require.cache[storeModuleId];
  delete require.cache[dbModuleId];
  require.cache[dbModuleId] = {
    id: dbModuleId,
    filename: dbModuleId,
    loaded: true,
    exports: { query: queryImpl },
  };
  const store = require('../src/auroraBff/routineStore');
  return {
    store,
    cleanup() {
      delete require.cache[storeModuleId];
      delete require.cache[dbModuleId];
    },
  };
}

test('saveRoutineVersion upserts guest active routine pointer when profile row is absent', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql), params: Array.isArray(params) ? params.slice() : [] });
    return { rows: [] };
  };
  const { store, cleanup } = loadRoutineStoreWithQuery(query);

  try {
    const out = await store.saveRoutineVersion({
      auroraUid: 'guest_uid_1',
      routineId: 'routine_guest_1',
      label: 'Guest Routine',
      amSteps: [{ step: 'AM step' }],
      pmSteps: [{ step: 'PM step' }],
    });

    assert.equal(out.routine_id, 'routine_guest_1');
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /INSERT INTO aurora_routine_versions/i);
    assert.match(calls[1].sql, /INSERT INTO aurora_user_profiles/i);
    assert.match(calls[1].sql, /ON CONFLICT \(aurora_uid\)/i);
    assert.equal(calls[1].params[0], 'guest_uid_1');
    assert.equal(calls[1].params[1], 'routine_guest_1');
    assert.deepEqual(JSON.parse(calls[1].params[2]), {
      am: [{ step: 'AM step' }],
      pm: [{ step: 'PM step' }],
    });
  } finally {
    cleanup();
  }
});

test('saveRoutineVersion upserts account active routine pointer when user profile row is absent', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql), params: Array.isArray(params) ? params.slice() : [] });
    return { rows: [] };
  };
  const { store, cleanup } = loadRoutineStoreWithQuery(query);

  try {
    const out = await store.saveRoutineVersion({
      auroraUid: 'guest_uid_2',
      userId: 'user_2',
      routineId: 'routine_user_2',
      label: 'User Routine',
      amSteps: [{ step: 'Cleanser' }],
      pmSteps: [{ step: 'Moisturizer' }],
    });

    assert.equal(out.routine_id, 'routine_user_2');
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /INSERT INTO aurora_routine_versions/i);
    assert.match(calls[1].sql, /INSERT INTO aurora_account_profiles/i);
    assert.match(calls[1].sql, /ON CONFLICT \(user_id\)/i);
    assert.equal(calls[1].params[0], 'user_2');
    assert.equal(calls[1].params[1], 'routine_user_2');
    assert.deepEqual(JSON.parse(calls[1].params[2]), {
      am: [{ step: 'Cleanser' }],
      pm: [{ step: 'Moisturizer' }],
    });
  } finally {
    cleanup();
  }
});
