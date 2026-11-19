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

// Rows exactly as the drain's resolveGroupProductRows SELECT returns them, in the backend mirror's shape: the seed's
// market is nested at product_payload.external_seed.market and on each offer's offer_payload.market, never top-level.
describe('drain-shaped mirror rows -> serving docs (real builder)', () => {
  const real = jest.requireActual('../../src/services/catalogServingIndex');
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved;
  });

  const mirrorRow = (id, seedMarket, offerMarket, currency) => ({
    product_key: `pk_${id}`,
    merchant_id: 'mirror_merchant_a',
    platform: 'external_seed',
    source_product_id: id,
    title: `Example Item ${id}`,
    description: null,
    brand: 'Example Brand',
    product_type: null,
    category: null,
    canonical_url: `https://shop.example/${id}`,
    image_url: null,
    product_payload: {
      external_seed: { id: `seed_${id}`, external_product_id: id, market: seedMarket, price_currency: currency },
      seed_data: {},
    },
    content_key: null,
    pivota_signature_id: null,
    updated_at: '2026-11-19T00:00:00Z',
    offers: [{
      offer_id: `offer:external_seed:${id}`, sku_key: `pk_${id}::canonical`, offer_mode: 'external_referral',
      availability: 'in_stock', inventory_quantity: null, currency, list_price: '12.00', merchant_effective_price: '12.00',
      offer_payload: { external_seed_id: `seed_${id}`, market: offerMarket },
    }],
  });
  const build = (rows, market) => {
    const stats = {};
    const docs = real.buildCatalogServingBackfillDocs(drain.buildSourceRows(rows), { includeNonPublic: true, market, stats });
    return { docs, stats };
  };

  test.each([
    ['US', 'US', 'USD', 'US'],
    ['SG', 'SG', 'SGD', 'SG'],
    ['SG', 'US', 'USD', 'SG'], // an SG seed priced in USD: the seed's partition wins over the currency's market
  ])("flag on, '*': seed %s (offer %s, %s) -> market %s, stated", (seedMarket, offerMarket, currency, expected) => {
    process.env[FLAG] = 'true';
    const { docs, stats } = build([mirrorRow('a1', seedMarket, offerMarket, currency)], '*');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ market: expected, market_state: 'stated' });
    expect(stats).toMatchObject({ market_conflict_skipped: 0, market_group_conflict_skipped: 0 });
  });

  test("flag on: only the offer payload states a market -> that market, stated", () => {
    process.env[FLAG] = 'true';
    const row = mirrorRow('a2', null, 'SG', 'SGD');
    delete row.product_payload.external_seed.market;
    const { docs } = build([row], '*');
    expect(docs[0]).toMatchObject({ market: 'SG', market_state: 'stated' });
  });

  test("flag on: scoped 'US' keeps the US seed and skips (counts) the SG seed", () => {
    process.env[FLAG] = 'true';
    const { docs, stats } = build([mirrorRow('u1', 'US', 'US', 'USD'), mirrorRow('s1', 'SG', 'SG', 'SGD')], 'US');
    expect(docs.map((d) => [d.market, d.market_state])).toEqual([['US', 'stated']]);
    expect(stats.market_conflict_skipped).toBe(1);
  });

  test('flag off: the same rows build exactly as today (stamped US, no market_state)', () => {
    delete process.env[FLAG];
    const { docs, stats } = build([mirrorRow('u1', 'US', 'US', 'USD'), mirrorRow('s1', 'SG', 'SG', 'SGD')], 'US');
    expect(docs.map((d) => d.market)).toEqual(['US', 'US']);
    for (const doc of docs) expect(doc).not.toHaveProperty('market_state');
    expect(stats).not.toHaveProperty('market_group_conflict_skipped');
    const keys = Object.keys(docs[0]);
    expect(keys.indexOf('market')).toBe(keys.indexOf('category_paths') + 1);
  });

  test.each([[undefined], ['true']])('flag %s: the drain group SELECT reads no catalog_offers.market column', async (flag) => {
    if (flag === undefined) delete process.env[FLAG]; else process.env[FLAG] = flag;
    query.mockReset().mockResolvedValue({ rows: [] });
    await drain.resolveGroupProductRows(['pk1']);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).not.toMatch(/co\.market/);
    expect(sql).toContain("'offer_payload', co.offer_payload");
  });
});
