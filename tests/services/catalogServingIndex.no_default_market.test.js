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
    [{ market: 'US' }, {}, 'US'],
    [{ market: 'SG' }, { market: 'US' }, 'SG'],
  ])('flag on: a stated market is kept (%j / %j)', (input, options, market) => {
    process.env[FLAG] = 'true';
    const doc = buildCatalogServingDoc({ ...base, ...input }, options);
    expect(doc.market).toBe(market);
    expect(doc.market_state).toBe('stated');
  });

  test("flag on: no source market + a caller market = that market, labelled 'scoped' (never 'stated')", () => {
    process.env[FLAG] = 'true';
    const doc = buildCatalogServingDoc({ ...base }, { market: 'DE' });
    expect(doc.market).toBe('DE');
    expect(doc.market_state).toBe('scoped');
    expect(buildCatalogServingDoc({ ...base }, { market: '*' })).toMatchObject({ market: null, market_state: 'unstated' });
  });

  test.each([
    ['1', false], ['yes', false], ['on', false], ['TRUE1', false], ['', false],
    ['true', true], [' TRUE ', true], ['True', true],
  ])('flag value %j turns the flag on: %s', (value, on) => {
    process.env[FLAG] = value;
    const doc = buildCatalogServingDoc({ ...base });
    if (on) {
      expect(doc).toMatchObject({ market: null, market_state: 'unstated' });
    } else {
      expect(doc.market).toBe('US');
      expect(doc).not.toHaveProperty('market_state');
    }
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
    expect(buildCatalogServingDoc({ ...base }, { market: 'US' })).toMatchObject({ market: 'US', market_state: 'scoped' });
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
  const grouped = (id, market) => ({ ...row(id, market), serving_eligible: true });
  const groupIdentity = (ids) => ids.map((id) => ({ source_listing_ref: `external_seed:${id}`,
    sellable_item_group_id: 'sig_shared', identity_status: 'approved', live_read_enabled: true }));

  test.each([
    ['*', ['a', 'US'], ['b', 'SG']],
    ['*', ['b', 'SG'], ['a', 'US']],
    ['US', ['a', 'US'], ['b', 'SG']],
    ['US', ['b', 'SG'], ['a', 'US']],
    ['SG', ['a', 'US'], ['b', 'SG']],
    ['SG', ['b', 'SG'], ['a', 'US']],
  ])('flag on: scope %s, a group whose entries state US and SG is skipped and counted (order %j, %j)',
    (scope, first, second) => {
      process.env[FLAG] = 'true';
      for (const includeNonPublic of [true, false]) {
        const stats = {};
        const docs = buildCatalogServingBackfillDocs([grouped(...first), grouped(...second)],
          { identityRows: groupIdentity(['a', 'b']), includeNonPublic, market: scope, stats });
        expect(docs).toEqual([]);
        expect(stats.market_group_conflict_skipped).toBe(1);
        expect(stats.market_conflict_skipped).toBe(0);
      }
    });

  test('flag on: a group that agrees (or adds an unstated entry) is one doc with that market', () => {
    process.env[FLAG] = 'true';
    const stats = {};
    const docs = buildCatalogServingBackfillDocs([grouped('a', 'sg'), grouped('b', 'SG'), grouped('c')],
      { identityRows: groupIdentity(['a', 'b', 'c']), includeNonPublic: true, market: '*', stats });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ market: 'SG', market_state: 'stated' });
    expect(stats.market_group_conflict_skipped).toBe(0);
  });

  test('flag off: a disagreeing group is built as today (no group skip, no counter)', () => {
    delete process.env[FLAG];
    const stats = {};
    const docs = buildCatalogServingBackfillDocs([grouped('a', 'US'), grouped('b', 'SG')],
      { identityRows: groupIdentity(['a', 'b']), includeNonPublic: true, market: 'US', stats });
    expect(docs).toHaveLength(1);
    expect(stats).not.toHaveProperty('market_group_conflict_skipped');
  });

  test('flag on: the backfill result reports the group-conflict count', async () => {
    process.env[FLAG] = 'true';
    const result = await backfillCatalogServingIndex({ market: '*', dryRun: true }, {
      fetchBackfillProductsFn: async () => [grouped('a', 'US'), grouped('b', 'SG')],
      identityRowsResolverFn: async () => groupIdentity(['a', 'b']),
      productIntelSummariesResolverFn: async () => new Map(),
    });
    expect(result).toMatchObject({ market_conflict_skipped: 0, market_group_conflict_skipped: 1,
      market_offer_conflict_skipped: 0, market_payload_column_conflict_skipped: 0 });
    delete process.env[FLAG];
    const off = await backfillCatalogServingIndex({ market: 'US', dryRun: true }, {
      fetchBackfillProductsFn: async () => [grouped('a', 'US'), grouped('b', 'SG')],
      identityRowsResolverFn: async () => groupIdentity(['a', 'b']),
      productIntelSummariesResolverFn: async () => new Map(),
    });
    expect(off).not.toHaveProperty('market_group_conflict_skipped');
    expect(off).not.toHaveProperty('market_conflict_skipped');
    expect(off).not.toHaveProperty('market_payload_column_conflict_skipped');
  });
  test('flag on: the backfill result counts a payload-vs-column conflict', async () => {
    process.env[FLAG] = 'true';
    const conflicted = { ...row('pc'), product: { ...row('pc').product,
      offers: [{ offer_id: 'o_pc', price: { amount: 10, currency: 'USD' }, market: 'US', column_market: 'SG' }] } };
    const result = await backfillCatalogServingIndex({ market: '*', dryRun: true }, {
      fetchBackfillProductsFn: async () => [conflicted],
      identityRowsResolverFn: async () => [],
      productIntelSummariesResolverFn: async () => new Map(),
    });
    expect(result).toMatchObject({ market_payload_column_conflict_skipped: 1, market_offer_conflict_skipped: 0 });
  });
  // Review P2: serving docs carry no currency, so a USD price must never land in an SG doc. Seed-lane shape
  // (pdpIdentityGraph.fetchBackfillProducts: source_meta.market = the seed's market).
  const seedRow = (id, product) => ({ merchant_id: 'external_seed', product_id: id, source_kind: 'external_seed',
    source_meta: { market: 'SG' }, product: { product_id: id, title: `Item ${id}`, brand: 'Example Brand', ...product } });
  const ZERO_CCY = { market_currency_conflict_skipped: 0, market_currency_group_skipped: 0 };

  test('flag on: the reviewed case -- an SG seed priced 19 USD (assumed-US offer) is not published [SG, 19]', () => {
    process.env[FLAG] = 'true';
    const rows = [seedRow('r1', { price: 19, currency: 'USD',
      offers: [{ offer_id: 'o_r1', price: { amount: 19, currency: 'USD' }, column_market: 'US' }] })];
    const stats = {};
    expect(buildCatalogServingBackfillDocs(rows, { includeNonPublic: true, market: '*', stats })).toEqual([]);
    expect(stats).toMatchObject({ market_currency_conflict_skipped: 2, market_currency_group_skipped: 1,
      market_offer_conflict_skipped: 0, market_payload_column_conflict_skipped: 0 });
    delete process.env[FLAG];
    const [off] = buildCatalogServingBackfillDocs(rows, { includeNonPublic: true, market: 'US' });
    expect(off).toMatchObject({ market: 'SG', price_min: 19 });
  });

  test('flag on: an SG seed priced 25 SGD next to an assumed-US offer at 19 USD -> SG doc priced 25 only', () => {
    process.env[FLAG] = 'true';
    const rows = [seedRow('r2', { price: 25, currency: 'SGD', default_offer_id: 'o_r2_usd',
      offers: [{ offer_id: 'o_r2_usd', price: { amount: 19, currency: 'USD' }, column_market: 'US' },
               { offer_id: 'o_r2_sgd', price: { amount: 25, currency: 'SGD' } }] })];
    const stats = {};
    const docs = buildCatalogServingBackfillDocs(rows, { includeNonPublic: true, market: '*', stats });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ market: 'SG', market_state: 'stated', price_min: 25, price_max: 25,
      default_offer_id: 'o_r2_sgd' });
    expect(stats).toMatchObject({ ...ZERO_CCY, market_currency_conflict_skipped: 1 });
  });

  test('flag on: a price that states no currency is kept; a market the gateway does not price is not checked', () => {
    process.env[FLAG] = 'true';
    const stats = {};
    const docs = buildCatalogServingBackfillDocs([
      seedRow('r3', { price: 12, offers: [{ offer_id: 'o_r3', price: { amount: 12 } }] }),
      { ...seedRow('r4', { price: 30, currency: 'USD', offers: [] }), source_meta: { market: 'DE' } },
    ], { includeNonPublic: true, market: '*', stats });
    expect(docs.map((d) => [d.market, d.price_min]).sort()).toEqual([['DE', 30], ['SG', 12]]);
    expect(stats).toMatchObject(ZERO_CCY);
  });

  test('flag on: the backfill result carries both currency counters', async () => {
    process.env[FLAG] = 'true';
    const result = await backfillCatalogServingIndex({ market: '*', dryRun: true }, {
      fetchBackfillProductsFn: async () => [seedRow('r5', { price: 19, currency: 'USD', offers: [] })],
      identityRowsResolverFn: async () => [],
      productIntelSummariesResolverFn: async () => new Map(),
    });
    expect(result).toMatchObject({ market_currency_conflict_skipped: 1, market_currency_group_skipped: 1 });
  });
});

