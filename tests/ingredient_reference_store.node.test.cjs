const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const STORE_MODULE = '../src/services/ingredientReferenceStore';

async function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides || {})) {
    previous.set(key, process.env[key]);
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }

  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    return await fn();
  } finally {
    restore();
  }
}

function loadIngredientReferenceStoreWithPgStub({ queryImpl } = {}) {
  const originalLoad = Module._load;
  const poolConfigs = [];
  const queryCalls = [];

  class PoolStub {
    constructor(config) {
      this.config = config;
      poolConfigs.push(config);
    }

    async query(sql, params = []) {
      queryCalls.push({
        sql: String(sql || '').replace(/\s+/g, ' ').trim(),
        params,
      });
      if (typeof queryImpl === 'function') {
        return queryImpl({ sql, params, config: this.config });
      }
      return { rows: [] };
    }

    async end() {
      return undefined;
    }
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'pg') {
      return { Pool: PoolStub };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const moduleId = require.resolve(STORE_MODULE);
  delete require.cache[moduleId];
  const store = require(STORE_MODULE);

  const cleanup = () => {
    if (store && store._internals && typeof store._internals.resetForTest === 'function') {
      store._internals.resetForTest();
    }
    Module._load = originalLoad;
    delete require.cache[moduleId];
  };

  return { store, poolConfigs, queryCalls, cleanup };
}

test('ingredient reference store: no dedicated KB env returns null without opening a DB pool', async (t) => {
  await withEnv(
    {
      DATABASE_URL: 'postgres://app-db-only',
      INGREDIENT_REFERENCE_DATABASE_URL: undefined,
      PIVOTA_KB_DATABASE_URL: undefined,
    },
    async () => {
      const { store, poolConfigs, queryCalls, cleanup } = loadIngredientReferenceStoreWithPgStub();
      t.after(cleanup);

      const match = await store.getBestIngredientReferenceMatch('MCI');
      assert.equal(match, null);
      assert.equal(poolConfigs.length, 0);
      assert.equal(queryCalls.length, 0);
    },
  );
});

test('ingredient reference store: prefers INGREDIENT_REFERENCE_DATABASE_URL over app DATABASE_URL', async (t) => {
  await withEnv(
    {
      DATABASE_URL: 'postgres://app-db-only',
      INGREDIENT_REFERENCE_DATABASE_URL: 'postgres://kb-db-primary',
      PIVOTA_KB_DATABASE_URL: 'postgres://kb-db-fallback',
    },
    async () => {
      const { store, poolConfigs, queryCalls, cleanup } = loadIngredientReferenceStoreWithPgStub({
        queryImpl: async () => ({
          rows: [
            {
              record_id: 'ING-0400',
              normalized_key: 'methylchloroisothiazolinone',
              canonical_inci_name: 'Methylchloroisothiazolinone',
              canonical_display_name: 'Methylchloroisothiazolinone',
              ingredient_family: 'preservative',
              primary_bucket: 'preservative',
              aliases_common_list: ['MCI'],
              parser_variants_list: ['Methylchloroisothiazolinone', 'MCI'],
              lookup_terms: ['MCI'],
              lookup_terms_normalized: ['mci'],
              confidence_rank: 2,
              is_preservative_bool: true,
            },
          ],
        }),
      });
      t.after(cleanup);

      const match = await store.getBestIngredientReferenceMatch('MCI');
      assert.ok(match);
      assert.equal(poolConfigs.length, 1);
      assert.equal(poolConfigs[0].connectionString, 'postgres://kb-db-primary');
      assert.equal(queryCalls.length, 1);
      assert.equal(match.canonical_inci_name, 'Methylchloroisothiazolinone');
      assert.equal(match.aliases_common_list.includes('MCI'), true);
      assert.equal(match.flags.is_preservative, true);
    },
  );
});

test('ingredient reference store: falls back to PIVOTA_KB_DATABASE_URL when primary env is absent', async (t) => {
  await withEnv(
    {
      DATABASE_URL: 'postgres://app-db-only',
      INGREDIENT_REFERENCE_DATABASE_URL: undefined,
      PIVOTA_KB_DATABASE_URL: 'postgres://kb-db-fallback',
    },
    async () => {
      const { store, poolConfigs, cleanup } = loadIngredientReferenceStoreWithPgStub();
      t.after(cleanup);

      const url = store._internals.getIngredientReferenceDatabaseUrl();
      await store.lookupIngredientReferenceCandidates('Vitamin A');

      assert.equal(url, 'postgres://kb-db-fallback');
      assert.equal(poolConfigs.length, 1);
      assert.equal(poolConfigs[0].connectionString, 'postgres://kb-db-fallback');
    },
  );
});
