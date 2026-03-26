const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const STORE_MODULE = '../src/services/ingredientSignalStore';

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

function loadIngredientSignalStoreWithPgStub({ queryImpl } = {}) {
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

test('ingredient signal store: no KB env returns null without opening a DB pool', async (t) => {
  await withEnv(
    {
      DATABASE_URL: 'postgres://app-db-only',
      INGREDIENT_SIGNAL_DATABASE_URL: undefined,
      INGREDIENT_REFERENCE_DATABASE_URL: undefined,
      PIVOTA_KB_DATABASE_URL: undefined,
    },
    async () => {
      const { store, poolConfigs, queryCalls, cleanup } = loadIngredientSignalStoreWithPgStub();
      t.after(cleanup);

      const match = await store.getBestIngredientSignalMatch('AHA');
      assert.equal(match, null);
      assert.equal(poolConfigs.length, 0);
      assert.equal(queryCalls.length, 0);
    },
  );
});

test('ingredient signal store: prefers INGREDIENT_SIGNAL_DATABASE_URL and maps semicolon-delimited fields', async (t) => {
  await withEnv(
    {
      DATABASE_URL: 'postgres://app-db-only',
      INGREDIENT_SIGNAL_DATABASE_URL: 'postgres://signal-db-primary',
      INGREDIENT_REFERENCE_DATABASE_URL: 'postgres://reference-db-secondary',
      PIVOTA_KB_DATABASE_URL: 'postgres://kb-db-fallback',
    },
    async () => {
      const { store, poolConfigs, queryCalls, cleanup } = loadIngredientSignalStoreWithPgStub({
        queryImpl: async () => ({
          rows: [
            {
              signal_bucket: 'acid_family_signal',
              signal_key: 'aha',
              display_signal_name: 'AHA',
              raw_token_variants: 'AHA; Alpha Hydroxy Acids',
              normalized_token_variants: 'aha; alphahydroxyacids',
              source_packets: 'ingredient_signal_review_packet',
              source_decisions: 'approve_suggestion; approve_override',
              confidence_levels: 'high; medium',
              row_count: 2,
              total_sku_row_count: 5,
              resolution_rationales:
                'Short acid-family umbrella term; should stay out of canonical ingredient rows.; Approved as acid-family umbrella signal.',
            },
          ],
        }),
      });
      t.after(cleanup);

      const match = await store.getBestIngredientSignalMatch('Alpha Hydroxy Acids');
      assert.ok(match);
      assert.equal(poolConfigs.length, 1);
      assert.equal(poolConfigs[0].connectionString, 'postgres://signal-db-primary');
      assert.equal(queryCalls.length, 1);
      assert.equal(match.signal_key, 'aha');
      assert.deepEqual(match.raw_token_variants_list, ['AHA', 'Alpha Hydroxy Acids']);
      assert.deepEqual(match.confidence_levels_list, ['high', 'medium']);
    },
  );
});

test('ingredient signal store: matches normalized input against underscored signal_key', async (t) => {
  await withEnv(
    {
      DATABASE_URL: 'postgres://app-db-only',
      INGREDIENT_SIGNAL_DATABASE_URL: 'postgres://signal-db-primary',
    },
    async () => {
      const { store, queryCalls, cleanup } = loadIngredientSignalStoreWithPgStub({
        queryImpl: async () => ({
          rows: [
            {
              signal_bucket: 'marketing_or_blend_signal',
              signal_key: 'miracle_broth',
              display_signal_name: 'Miracle Broth (sea kelp, vitamins, minerals, and other nutrients)',
              raw_token_variants: 'Miracle Broth (sea kelp, vitamins, minerals, and other nutrients)',
              normalized_token_variants: 'miraclebrothseakelpvitaminsmineralsandothernutrients',
              confidence_levels: 'low',
            },
          ],
        }),
      });
      t.after(cleanup);

      const match = await store.getBestIngredientSignalMatch('Miracle Broth');
      assert.ok(match);
      assert.equal(match.signal_key, 'miracle_broth');
      assert.equal(queryCalls.length, 1);
      assert.equal(queryCalls[0].params[0], 'miraclebroth');
    },
  );
});

test('ingredient signal store: ignores trademark symbols during normalization', async (t) => {
  await withEnv(
    {
      DATABASE_URL: 'postgres://app-db-only',
      INGREDIENT_SIGNAL_DATABASE_URL: 'postgres://signal-db-primary',
    },
    async () => {
      const { store, queryCalls, cleanup } = loadIngredientSignalStoreWithPgStub({
        queryImpl: async () => ({
          rows: [
            {
              signal_bucket: 'marketing_or_blend_signal',
              signal_key: 'miracle_broth',
              display_signal_name: 'Miracle Broth (sea kelp, vitamins, minerals, and other nutrients)',
              raw_token_variants: 'Miracle Broth (sea kelp, vitamins, minerals, and other nutrients)',
              normalized_token_variants: 'miraclebrothseakelpvitaminsmineralsandothernutrients',
              confidence_levels: 'low',
            },
          ],
        }),
      });
      t.after(cleanup);

      const match = await store.getBestIngredientSignalMatch('Miracle Broth™');
      assert.ok(match);
      assert.equal(match.signal_key, 'miracle_broth');
      assert.equal(queryCalls.length, 1);
      assert.equal(queryCalls[0].params[0], 'miraclebroth');
    },
  );
});

test('ingredient signal store: falls back to INGREDIENT_REFERENCE_DATABASE_URL when dedicated env is absent', async (t) => {
  await withEnv(
    {
      DATABASE_URL: 'postgres://app-db-only',
      INGREDIENT_SIGNAL_DATABASE_URL: undefined,
      INGREDIENT_REFERENCE_DATABASE_URL: 'postgres://reference-db-secondary',
      PIVOTA_KB_DATABASE_URL: 'postgres://kb-db-fallback',
    },
    async () => {
      const { store, poolConfigs, cleanup } = loadIngredientSignalStoreWithPgStub();
      t.after(cleanup);

      const url = store._internals.getIngredientSignalDatabaseUrl();
      await store.lookupIngredientSignalCandidates('SPF 30');

      assert.equal(url, 'postgres://reference-db-secondary');
      assert.equal(poolConfigs.length, 1);
      assert.equal(poolConfigs[0].connectionString, 'postgres://reference-db-secondary');
    },
  );
});
