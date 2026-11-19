const {
  backfillCatalogServingIndex,
  buildCatalogServingBackfillDocs,
  buildCatalogServingDoc,
  _internals: { buildCatalogServingGroupInput, filterLocalCatalogServingDocs },
} = require('../../src/services/catalogServingIndex');

const FLAG = 'CATALOG_SERVING_INDEX_NO_DEFAULT_MARKET_ENABLED';
const base = { product_id: 'p1', merchant_id: 'm1', title: 'Tinted Balm', currency: 'SGD', price: 12 };

describe('catalog serving index never defaults a market (flag)', () => {
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  test('flag off: an unstated market is stamped US, as today', () => {
    delete process.env[FLAG];
    const doc = buildCatalogServingDoc({ ...base });
    expect(doc.market).toBe('US');
    expect(doc).not.toHaveProperty('market_state');
  });

  test('flag on: an unstated market stays null and is labelled unstated', () => {
    process.env[FLAG] = 'true';
    const doc = buildCatalogServingDoc({ ...base });
    expect(doc.market).toBeNull();
    expect(doc.market_state).toBe('unstated');
  });

  test.each([
    [{ market: 'SG' }, {}, 'SG'],
    [{ region: 'GB' }, {}, 'GB'],
    [{}, { market: 'DE' }, 'DE'],
    [{ market: 'US' }, {}, 'US'],
  ])('flag on: a stated market is kept (%j / %j)', (input, options, market) => {
    process.env[FLAG] = 'true';
    const doc = buildCatalogServingDoc({ ...base, ...input }, options);
    expect(doc.market).toBe(market);
    expect(doc.market_state).toBe('stated');
  });

  test('flag on: the group input does not invent a market; a caller-named one is kept', () => {
    process.env[FLAG] = 'true';
    const entries = [{ product: { ...base } }];
    expect(buildCatalogServingGroupInput(entries).market).toBeNull();
    expect(buildCatalogServingGroupInput(entries, { market: 'SG' }).market).toBe('SG');
    expect(buildCatalogServingGroupInput([{ product: { ...base, market: 'GB' } }]).market).toBe('GB');
    delete process.env[FLAG];
    expect(buildCatalogServingGroupInput(entries).market).toBe('US');
  });

  test('flag on: a doc with no market never matches a US (or any) local query', () => {
    const docs = [
      { doc_id: 'a', publish_state: 'public', market: null, title: 'x' },
      { doc_id: 'b', publish_state: 'public', market: 'US', title: 'x' },
      { doc_id: 'c', publish_state: 'public', market: 'SG', title: 'x' },
    ];
    process.env[FLAG] = 'true';
    expect(filterLocalCatalogServingDocs(docs, { market: 'US' }).map((d) => d.doc_id)).toEqual(['b']);
    expect(filterLocalCatalogServingDocs(docs, { market: 'SG' }).map((d) => d.doc_id)).toEqual(['c']);
    delete process.env[FLAG];
    expect(filterLocalCatalogServingDocs(docs, { market: 'US' }).map((d) => d.doc_id)).toEqual(['a', 'b']);
  });

  test('nothing but the market fields changes (currency, price, everything else)', () => {
    delete process.env[FLAG];
    const off = buildCatalogServingDoc({ ...base, market: 'SG' });
    process.env[FLAG] = 'true';
    const on = buildCatalogServingDoc({ ...base, market: 'SG' });
    delete on.market_state;
    expect(on).toEqual(off);
  });

  const row = (id, market) => ({
    merchant_id: 'external_seed',
    product_id: id,
    source_kind: 'external_seed',
    product: { product_id: id, title: `Item ${id}`, brand: 'Example Brand', price: 10,
               offers: [{ offer_id: `o_${id}`, merchant_id: 'external_seed', price: { amount: 10, currency: 'USD' } }] },
    ...(market ? { source_meta: { market } } : {}),
  });

  test.each([
    ['US', 'SG'], ['US', 'GB'], ['US', 'DE'], ['SG', 'US'],
  ])('flag on: a backfill scoped to %s never relabels a source that states %s (skip + count)', (scope, stated) => {
    process.env[FLAG] = 'true';
    const stats = {};
    const docs = buildCatalogServingBackfillDocs([row('a', stated), row('b', scope)],
      { includeNonPublic: true, market: scope, stats });
    expect(docs.map((d) => d.market)).toEqual([scope]);
    expect(stats.market_conflict_skipped).toBe(1);
  });

  test('flag on: an unstated source is published unstated, never stamped with the scope', () => {
    process.env[FLAG] = 'true';
    const stats = {};
    const docs = buildCatalogServingBackfillDocs([row('a')], { includeNonPublic: true, market: 'US', stats });
    expect(docs).toHaveLength(1);
    expect(docs[0].market).toBeNull();
    expect(docs[0].market_state).toBe('unstated');
    expect(stats.market_conflict_skipped).toBe(0);
  });

  test('flag off: the backfill keeps today\'s labels (scope fills in, no conflict skip)', () => {
    delete process.env[FLAG];
    const docs = buildCatalogServingBackfillDocs([row('a'), row('b', 'SG')], { includeNonPublic: true, market: 'US' });
    expect(docs.map((d) => d.market).sort()).toEqual(['SG', 'US']);
  });

  test('flag on: a backfill run without an explicit market refuses by name before any read', async () => {
    process.env[FLAG] = 'true';
    const fetchBackfillProductsFn = jest.fn(async () => []);
    for (const market of [undefined, null, '']) {
      await expect(backfillCatalogServingIndex({ market, dryRun: true }, { fetchBackfillProductsFn }))
        .rejects.toMatchObject({ code: 'catalog_serving_backfill_market_required' });
    }
    expect(fetchBackfillProductsFn).not.toHaveBeenCalled();
    delete process.env[FLAG];
    const result = await backfillCatalogServingIndex({ dryRun: true }, {
      fetchBackfillProductsFn, identityRowsResolverFn: async () => [], productIntelSummariesResolverFn: async () => new Map() });
    expect(result.dry_run).toBe(true);
  });

  test("flag on: '*' scopes nothing; each doc keeps its source's market or none", () => {
    process.env[FLAG] = 'true';
    const stats = {};
    const docs = buildCatalogServingBackfillDocs([row('a', 'SG'), row('b', 'US'), row('c')],
      { includeNonPublic: true, market: '*', stats });
    expect(docs.map((d) => d.market).sort()).toEqual(['SG', 'US', null].sort());
    expect(stats.market_conflict_skipped).toBe(0);
  });

  test('flag on: in a direct build the source market wins over a caller market', () => {
    process.env[FLAG] = 'true';
    expect(buildCatalogServingDoc({ ...base, market: 'SG' }, { market: 'US' }).market).toBe('SG');
    expect(buildCatalogServingDoc({ ...base }, { market: 'US' }).market).toBe('US');
  });

  test('flag on: a PUBLIC unstated source is published unstated, never with the scope market', () => {
    process.env[FLAG] = 'true';
    const r = { ...row('pub'), serving_eligible: true };
    const identityRows = [{ source_listing_ref: 'external_seed:pub', sellable_item_group_id: 'sig_pub',
                            identity_status: 'approved', live_read_enabled: true }];
    const docs = buildCatalogServingBackfillDocs([r], { identityRows, includeNonPublic: false, market: 'US' });
    expect(docs).toHaveLength(1);
    expect(docs[0].publish_state).toBe('public');
    expect(docs[0].market).toBeNull();
  });
});

