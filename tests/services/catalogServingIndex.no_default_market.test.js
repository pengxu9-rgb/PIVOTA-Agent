const {
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
});
