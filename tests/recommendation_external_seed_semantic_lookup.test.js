// loadExternalSeedSemanticRecord's seed_data fallback must be able to use
// migration 040's partial indexes (`WHERE status = 'active' AND seed_data ? 'k'`).
// Unguarded `->> = $n OR …` arms cannot, and seq-scan every active seed on a miss.

jest.mock('../src/db', () => ({ query: jest.fn() }));

const ORIGINAL_ENV = process.env;
const norm = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();

describe('loadExternalSeedSemanticRecord', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test('every seed_data arm carries its guard, and every ORDER BY ends in an id tiebreak', async () => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, DATABASE_URL: 'postgres://test' };
    const db = require('../src/db');
    const sent = [];
    db.query.mockImplementation(async (sql) => {
      sent.push(norm(sql));
      return { rows: [] };
    });
    const { _internals } = require('../src/services/RecommendationEngine');

    await expect(
      _internals.loadExternalSeedSemanticRecord({ product_id: 'ext_a', external_product_id: 'dom-com:1' }),
    ).resolves.toBeNull();

    const fallback = sent.find((sql) => sql.includes("seed_data->>'product_id'"));
    expect(fallback).toBeTruthy();
    for (const bind of ['$1', '$2']) {
      expect(fallback).toContain(`(seed_data ? 'external_product_id' AND seed_data->>'external_product_id' = ${bind})`);
      expect(fallback).toContain(`(seed_data ? 'product_id' AND seed_data->>'product_id' = ${bind})`);
    }
    // No unguarded arm in the WHERE clause (the SELECT projection reads seed_data freely).
    const where = fallback.slice(fallback.lastIndexOf('FROM external_product_seeds WHERE'));
    expect(where).not.toMatch(/\( ?seed_data->>/);
    expect(where).not.toMatch(/OR seed_data->>/);
    for (const sql of sent.filter((s) => s.includes('ORDER BY'))) {
      expect(sql).toMatch(/created_at DESC NULLS LAST, id LIMIT 1$/);
    }
  });
});
