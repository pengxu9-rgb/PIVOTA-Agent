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
// market is nested at product_payload.external_seed.market, each offer's at offer_payload.market, and (flag on) the
// catalog_offers.market column comes back as column_market. Never top-level.
describe('drain-shaped mirror rows -> serving docs (real builder)', () => {
  const real = jest.requireActual('../../src/services/catalogServingIndex');
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved;
  });

  const offer = (id, payloadMarket, columnMarket, currency = (payloadMarket || columnMarket) === 'SG' ? 'SGD' : 'USD',
    amount = '12.00') => ({
    offer_id: `offer:external_seed:${id}`, sku_key: `pk_${id}::canonical`, offer_mode: 'external_referral',
    availability: 'in_stock', inventory_quantity: null, currency, list_price: amount, merchant_effective_price: amount,
    offer_payload: { external_seed_id: `seed_${id}`, ...(payloadMarket ? { market: payloadMarket } : {}) },
    ...(columnMarket ? { column_market: columnMarket } : {}),
  });
  const mirrorRow = (id, seedMarket, offers) => ({
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
      external_seed: { id: `seed_${id}`, external_product_id: id, ...(seedMarket ? { market: seedMarket } : {}) },
      seed_data: {},
    },
    content_key: null,
    pivota_signature_id: null,
    updated_at: '2026-11-19T00:00:00Z',
    offers,
  });
  const build = (rows, market, identityRows = []) => {
    const stats = {};
    const docs = real.buildCatalogServingBackfillDocs(drain.buildSourceRows(rows),
      { identityRows, includeNonPublic: true, market, stats });
    return { docs, stats };
  };
  const ZERO = { market_conflict_skipped: 0, market_group_conflict_skipped: 0, market_offer_conflict_skipped: 0,
    market_payload_column_conflict_skipped: 0, market_currency_conflict_skipped: 0, market_currency_group_skipped: 0 };

  // The census shapes (offer_payload.market x catalog_offers.market), no seed market.
  test.each([
    [null, 'US', 'US', 'assumed'],
    [null, 'SG', 'SG', 'stated'],
    ['US', 'US', 'US', 'stated'],
    ['SG', 'SG', 'SG', 'stated'],
    ['SG', 'US', 'SG', 'stated'], // a column 'US' may be the default: never a conflict
  ])("flag on, '*': payload %s + column %s -> %s/%s", (payloadMarket, columnMarket, market, state) => {
    process.env[FLAG] = 'true';
    const { docs, stats } = build([mirrorRow('a1', null, [offer('a1', payloadMarket, columnMarket)])], '*');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ market, market_state: state });
    expect(stats).toEqual(ZERO);
  });

  test("flag on: payload US + column SG is a conflict: skipped and counted, under '*' and scoped", () => {
    process.env[FLAG] = 'true';
    for (const scope of ['*', 'US', 'SG']) {
      const { docs, stats } = build([mirrorRow('c1', null, [offer('c1', 'US', 'SG')])], scope);
      expect(docs).toEqual([]);
      expect(stats).toEqual({ ...ZERO, market_payload_column_conflict_skipped: 1 });
    }
  });

  test.each([
    ['US', 'US', 'US', 'stated'],
    ['SG', 'SG', 'SG', 'stated'],
    ['SG', null, 'SG', 'stated'],
  ])("flag on, '*': seed %s with offer payload %s -> %s/%s", (seedMarket, payloadMarket, market, state) => {
    process.env[FLAG] = 'true';
    const { docs } = build([mirrorRow('s1', seedMarket, [offer('s1', payloadMarket, null)])], '*');
    expect(docs[0]).toMatchObject({ market, market_state: state });
  });

  test("flag on: an 'assumed' US offer (column US only) next to a stated SG seed is no conflict: SG/stated", () => {
    process.env[FLAG] = 'true';
    const { docs, stats } = build([mirrorRow('s2', 'SG', [offer('s2', null, 'US', 'SGD')])], '*');
    expect(docs[0]).toMatchObject({ market: 'SG', market_state: 'stated' });
    expect(stats).toEqual(ZERO);
  });

  test('flag on: the seed and an offer payload disagree (SG seed, US payload) -> skipped, counted', () => {
    process.env[FLAG] = 'true';
    const { docs, stats } = build([mirrorRow('s3', 'SG', [offer('s3', 'US', 'US')])], '*');
    expect(docs).toEqual([]);
    expect(stats).toEqual({ ...ZERO, market_offer_conflict_skipped: 1 });
  });

  test('flag on: one product whose offers state several payload markets -> skipped, counted', () => {
    process.env[FLAG] = 'true';
    const { docs, stats } = build([mirrorRow('m1', null, [offer('m1a', 'US', 'US'), offer('m1b', 'SG', 'SG')])], '*');
    expect(docs).toEqual([]);
    expect(stats).toEqual({ ...ZERO, market_offer_conflict_skipped: 1 });
  });

  const identity = (ids) => ids.map((id) => ({ source_listing_ref: `mirror_merchant_a:${id}`,
    sellable_item_group_id: 'sig_shared', identity_status: 'approved', live_read_enabled: true }));

  test.each([[['g1', 'g2']], [['g2', 'g1']]])('flag on: a group whose listings state US and SG payloads -> skipped (order %j)', (order) => {
    process.env[FLAG] = 'true';
    const rows = { g1: mirrorRow('g1', null, [offer('g1', 'US', 'US')]), g2: mirrorRow('g2', null, [offer('g2', 'SG', 'SG')]) };
    const { docs, stats } = build(order.map((id) => rows[id]), '*', identity(['g1', 'g2']));
    expect(docs).toEqual([]);
    expect(stats).toEqual({ ...ZERO, market_group_conflict_skipped: 1 });
  });

  test.each([[['g3', 'g4']], [['g4', 'g3']]])("flag on: an 'assumed' US listing grouped with a stated SG one -> SG/stated (order %j)", (order) => {
    process.env[FLAG] = 'true';
    const rows = { g3: mirrorRow('g3', null, [offer('g3', null, 'US')]), g4: mirrorRow('g4', null, [offer('g4', 'SG', 'SG')]) };
    const { docs, stats } = build(order.map((id) => rows[id]), '*', identity(['g3', 'g4']));
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ market: 'SG', market_state: 'stated' });
    expect(stats).toEqual(ZERO);
  });

  test("flag on: scoped 'US' keeps the US seed and skips (counts) the SG seed", () => {
    process.env[FLAG] = 'true';
    const { docs, stats } = build([mirrorRow('u1', 'US', [offer('u1', 'US', 'US')]),
      mirrorRow('s4', 'SG', [offer('s4', 'SG', 'SG', 'SGD')])], 'US');
    expect(docs.map((d) => [d.market, d.market_state])).toEqual([['US', 'stated']]);
    expect(stats.market_conflict_skipped).toBe(1);
  });

  test("flag on: an 'assumed' US doc is served to a US query (local filter and search body)", () => {
    process.env[FLAG] = 'true';
    const { docs } = build([mirrorRow('a9', null, [offer('a9', null, 'US')])], '*');
    const doc = { ...docs[0], publish_state: 'public' };
    expect(doc).toMatchObject({ market: 'US', market_state: 'assumed' });
    const { filterLocalCatalogServingDocs } = real._internals;
    const { buildCatalogServingSearchBody } = real;
    expect(filterLocalCatalogServingDocs([doc], { market: 'US' })).toHaveLength(1);
    expect(filterLocalCatalogServingDocs([doc], { market: 'SG' })).toHaveLength(0);
    const body = JSON.stringify(buildCatalogServingSearchBody({ market: 'US' }));
    expect(body).toContain('{"term":{"market":"US"}}');
    expect(body).not.toContain('market_state');
  });

  test('flag off: the same rows build exactly as today (stamped US, no market_state, no column_market)', () => {
    delete process.env[FLAG];
    const { docs, stats } = build([mirrorRow('u1', 'US', [offer('u1', 'US', 'US')]),
      mirrorRow('s5', 'SG', [offer('s5', 'US', 'SG', 'SGD')])], 'US');
    expect(docs.map((d) => d.market)).toEqual(['US', 'US']);
    for (const doc of docs) expect(doc).not.toHaveProperty('market_state');
    expect(JSON.stringify(docs)).not.toContain('column_market');
    expect(stats).toEqual({ market_conflict_skipped: 0 });
    const keys = Object.keys(docs[0]);
    expect(keys.indexOf('market')).toBe(keys.indexOf('category_paths') + 1);
  });

  test('the drain group SELECT reads catalog_offers.market only with the flag on; off it is the same text minus that', async () => {
    const sqlFor = async (flag) => {
      if (flag === undefined) delete process.env[FLAG]; else process.env[FLAG] = flag;
      query.mockReset().mockResolvedValue({ rows: [] });
      await drain.resolveGroupProductRows(['pk1']);
      return String(query.mock.calls[0][0]);
    };
    const off = await sqlFor(undefined);
    const on = await sqlFor('true');
    expect(off).not.toMatch(/co\.market/);
    expect(off).toContain("'offer_payload', co.offer_payload\n");
    expect(on).toContain("'offer_payload', co.offer_payload, 'column_market', co.market\n");
    expect(on.replace(", 'column_market', co.market", '')).toBe(off);
    expect(await sqlFor('1')).toBe(off);
  });
});
