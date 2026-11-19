// The drain is prod's real backfill invocation: it must never be the run that refuses for want of a market.
jest.mock('../../src/db', () => ({ query: jest.fn(), closePool: jest.fn(async () => {}) }));
jest.mock('../../src/services/catalogServingIndex', () => ({
  backfillCatalogServingIndex: jest.fn(),
  getCatalogServingIndexConfig: jest.fn(() => ({ enabled: true, base_url: 'https://index.example', index_name: 'i' })),
}));

const { query } = require('../../src/db');
const { backfillCatalogServingIndex } = require('../../src/services/catalogServingIndex');
const drain = require('../../scripts/drain-commerce-index-search-index');

const FLAG = 'CATALOG_SERVING_INDEX_NO_DEFAULT_MARKET_ENABLED';

function fakeQuery(sql) {
  const text = String(sql);
  if (text.includes('SKIP LOCKED')) return { rows: [{ job_id: 'j1', scope_json: { entity_type: 'product', entity_id: 'pk1' } }] };
  if (text.includes('UNION')) return { rows: [{ product_key: 'pk1' }] };
  if (text.includes('AS source_ref')) return { rows: [] };
  if (text.includes('affected_products')) {
    return { rows: [{ product_key: 'pk1', merchant_id: 'm1', source_product_id: '1', title: 'Item', offers: [] }] };
  }
  if (text.includes('UPDATE commerce_index_publication_jobs')) return { rows: [{ job_id: 'j1' }] };
  return { rows: [], rowCount: 0 };
}

describe('drain -> backfill market', () => {
  const saved = { flag: process.env[FLAG], apply: process.env[drain.APPLY_ENV] };
  beforeEach(() => {
    query.mockReset().mockImplementation(async (sql) => fakeQuery(sql));
    backfillCatalogServingIndex.mockReset().mockImplementation(async (options) => {
      // the real refusal, so a flag-on call without a market fails here exactly as it would in prod
      if (String(process.env[FLAG] || '').trim().toLowerCase() === 'true' && !options.market) {
        const error = new Error('catalog serving backfill needs an explicit market');
        error.code = 'catalog_serving_backfill_market_required';
        throw error;
      }
      return { source: 'opensearch_compatible', indexed: 1, document_memberships: [] };
    });
    process.env[drain.APPLY_ENV] = 'true';
  });
  afterEach(() => {
    for (const [key, value] of [[FLAG, saved.flag], [drain.APPLY_ENV, saved.apply]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  test('flag off: called exactly as today (no market argument)', async () => {
    delete process.env[FLAG];
    await drain.main(['--limit', '5']);
    expect(backfillCatalogServingIndex).toHaveBeenCalledTimes(1);
    const [options] = backfillCatalogServingIndex.mock.calls[0];
    expect(options).toEqual({ limit: 1, includeNonPublic: true, refresh: true });
    expect(options).not.toHaveProperty('market');
  });

  test("flag on: called with '*' and never refused for want of a market", async () => {
    process.env[FLAG] = 'true';
    await expect(drain.main(['--limit', '5'])).resolves.toMatchObject({ claimed: 1 });
    const [options] = backfillCatalogServingIndex.mock.calls[0];
    expect(options).toEqual({ limit: 1, includeNonPublic: true, refresh: true, market: '*' });
  });
});
