// One card per shade line (src/services/shadeLineCardCollapse.js). Invented stores and brands.

describe('shade line card collapse', () => {
  const ORIGINAL_ENV = process.env;
  const FLAG = 'SHADE_LINE_CARD_COLLAPSE_ENABLED';
  const LINE = 'pl_aaaaaaaaaaaaaaaaaaaaaaaa';
  const OTHER_LINE = 'pl_bbbbbbbbbbbbbbbbbbbbbbbb';
  const approved = (lineId) => ({ rule_version: 'shade_line_v2', status: 'approved', product_line_id: lineId });
  const ON = { [FLAG]: 'true' };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test' };
    delete process.env[FLAG];
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // A discovery candidate after applyIdentityGraphDiscoveryDedupe stamped its identity row: the
  // stored line on raw.identity_graph, the row's shade-line decision on candidate.identityShadeLine.
  function candidate(productId, {
    lineId = LINE,
    decision = 'approved',
    price = 30,
    currency = 'SGD',
    inStock = true,
    sellable = `sig_${productId}`,
  } = {}) {
    const shadeLine =
      decision === 'approved'
        ? approved(lineId)
        : decision === 'proposed'
          ? { rule_version: 'shade_line_v2', status: 'proposed', proposed_product_line_id: 'pl_cccccccccccccccccccccccc' }
          : decision === 'refused'
            ? { rule_version: 'shade_line_v2', status: 'refused', reason: 'price_outlier' }
            : null;
    return {
      key: `merch_obs_shopone::${productId}`,
      merchantId: 'merch_obs_shopone',
      productId,
      ...(lineId && shadeLine ? { identityShadeLine: shadeLine } : {}),
      raw: {
        merchant_id: 'merch_obs_shopone',
        product_id: productId,
        title: `BRANDA AURA ${productId.toUpperCase()}`,
        price,
        currency,
        ...(inStock ? { in_stock: true } : { in_stock: false, availability: 'out_of_stock' }),
        ...(lineId
          ? {
              product_line_id: lineId,
              sellable_item_group_id: sellable,
              match_basis: ['official_url:https://shop-one.example/products/x'],
              identity_graph: { product_line_id: lineId, sellable_item_group_id: sellable },
            }
          : {}),
      },
    };
  }

  function lineMemberRow(productId, { lineId = LINE, price = 30, currency = 'SGD', inStock = true, decision = 'approved' } = {}) {
    return {
      source_listing_ref: `merch_obs_shopone:${productId}`,
      merchant_id: 'merch_obs_shopone',
      product_id: productId,
      sellable_item_group_id: `sig_${productId}`,
      product_line_id: lineId,
      shade_line: decision === 'approved' ? approved(lineId) : null,
      // As listLiveShadeLineMembers builds it from the current seed columns.
      card_facts: {
        ...(price ? { price, currency } : {}),
        ...(inStock ? {} : { availability: 'sold out' }),
      },
    };
  }

  const discovery = () => require('../../src/services/shadeLineCardCollapse').collapseDiscoveryCandidatesByShadeLine;

  test('flag off (the default): the same array comes back and nothing is read', async () => {
    const resolver = jest.fn();
    const input = [candidate('k2207'), candidate('t415')];
    const result = await discovery()(input, { servingCurrency: 'SGD', lineMembersResolverFn: resolver, env: {} });
    expect(result.candidates).toBe(input);
    expect(result.stats).toMatchObject({ applied: false, reason: 'flag_off' });
    expect(resolver).not.toHaveBeenCalled();
  });

  test('flag on: one line becomes one card at its best-ranked slot, with an in-stock representative', async () => {
    const input = [
      candidate('k2207', { inStock: false, price: 20 }),
      candidate('unrelated', { lineId: null }),
      candidate('t415', { price: 30 }),
      candidate('p380', { price: 34 }),
    ];
    const result = await discovery()(input, { servingCurrency: 'SGD', env: ON });
    expect(result.candidates.map((entry) => entry.productId)).toEqual(['t415', 'unrelated']);
    const summary = result.candidates[0].raw.shade_line;
    expect(summary).toEqual({
      product_line_id: LINE,
      rule_version: 'shade_line_v2',
      shade_count: 3,
      in_stock_shade_count: 2,
      // The out-of-stock 20.00 shade is not a "from" price.
      from_price: { amount: 30, currency: 'SGD' },
      currency: 'SGD',
      collapsed_card_count: 3,
    });
    // No member refs in the public payload.
    expect(JSON.stringify(summary)).not.toMatch(/merch_obs|member_refs|representative/);
    expect(result.candidates[0].raw.shade_count).toBe(3);
    expect(result.stats).toMatchObject({ applied: true, lines_collapsed: 1, cards_dropped: 2, line_cards: 1 });
  });

  test('every member out of stock: the top-ranked one represents the line and no "from" price is quoted', async () => {
    const input = [candidate('k2207', { inStock: false }), candidate('t415', { inStock: false })];
    const result = await discovery()(input, { servingCurrency: 'SGD', env: ON });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].productId).toBe('k2207');
    expect(result.candidates[0].raw.shade_line.from_price).toBeNull();
    expect(result.candidates[0].raw.shade_line.in_stock_shade_count).toBe(0);
  });

  test('the line\'s other public members count toward the shades and the "from" price, from current seed prices only', async () => {
    const resolver = jest.fn(async ({ productLineIds }) => {
      expect(productLineIds).toEqual([LINE]);
      return [
        lineMemberRow('t415'), // already a card: counted once
        lineMemberRow('b220', { price: 26 }),
        lineMemberRow('b221', { price: 9, inStock: false }),
        lineMemberRow('b222', { price: 8, currency: 'USD' }), // another market: not a member here
        lineMemberRow('b223', { price: 0 }), // no current seed price: left out
        lineMemberRow('b224', { lineId: OTHER_LINE, price: 1 }), // another line
      ];
    });
    const input = [candidate('k2207'), candidate('t415')];
    const result = await discovery()(input, { servingCurrency: 'SGD', lineMembersResolverFn: resolver, env: ON });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].raw.shade_line).toMatchObject({
      shade_count: 4,
      in_stock_shade_count: 3,
      from_price: { amount: 26, currency: 'SGD' },
    });
  });

  test('a single recalled shade of a larger line is labelled, not dropped', async () => {
    const resolver = async () => [lineMemberRow('k2207'), lineMemberRow('t415'), lineMemberRow('p380')];
    const result = await discovery()([candidate('k2207')], { servingCurrency: 'SGD', lineMembersResolverFn: resolver, env: ON });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].raw.shade_line.shade_count).toBe(3);
    expect(result.stats).toMatchObject({ lines_collapsed: 0, cards_dropped: 0, line_cards: 1 });
  });

  test('buyer market first: a member priced in another currency is never folded into the card', async () => {
    const input = [candidate('k2207'), candidate('t415'), candidate('x900', { currency: 'USD', price: 5 })];
    const sgd = await discovery()(input, { servingCurrency: 'SGD', env: ON });
    expect(sgd.candidates.map((entry) => entry.productId)).toEqual(['k2207', 'x900']);
    expect(sgd.candidates[0].raw.shade_line).toMatchObject({ shade_count: 2, from_price: { amount: 30, currency: 'SGD' } });
    expect(sgd.candidates[1].raw.shade_line).toBeUndefined();

    const usd = await discovery()(input, { servingCurrency: 'USD', env: ON });
    expect(usd.candidates).toHaveLength(3);
    expect(usd.candidates.every((entry) => !entry.raw.shade_line)).toBe(true);
  });

  test('no serving currency (a market nothing is priced for): nothing collapses', async () => {
    const input = [candidate('k2207'), candidate('t415')];
    const result = await discovery()(input, { servingCurrency: null, env: ON });
    expect(result.candidates).toEqual(input);
    expect(result.stats.reason).toBe('no_serving_currency');
  });

  test('a line no row approves (only proposed or other-rule decisions) is never collapsed', async () => {
    const input = [candidate('k2207', { decision: 'proposed' }), candidate('t415', { decision: null })];
    const resolver = jest.fn(async () => [lineMemberRow('k2207', { decision: null }), lineMemberRow('t415', { decision: null })]);
    const result = await discovery()(input, { servingCurrency: 'SGD', lineMembersResolverFn: resolver, env: ON });
    expect(result.candidates).toBe(input);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  test('a member refused on a later rebuild keeps its stored line: it folds into the line card, never beside it', async () => {
    const input = [candidate('k2207'), candidate('t415', { decision: 'refused' }), candidate('p380')];
    const result = await discovery()(input, { servingCurrency: 'SGD', env: ON });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].raw.shade_line.shade_count).toBe(3);
  });

  test('a line verified only by its other members still folds the recalled cards', async () => {
    const input = [candidate('k2207', { decision: 'refused' }), candidate('t415', { decision: 'refused' })];
    const resolver = async () => [lineMemberRow('k2207', { decision: null }), lineMemberRow('p380')];
    const result = await discovery()(input, { servingCurrency: 'SGD', lineMembersResolverFn: resolver, env: ON });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].raw.shade_line.shade_count).toBe(3);
  });

  test('two lines collapse separately', async () => {
    const input = [
      candidate('k2207'),
      candidate('n001', { lineId: OTHER_LINE }),
      candidate('t415'),
      candidate('n002', { lineId: OTHER_LINE }),
    ];
    const result = await discovery()(input, { servingCurrency: 'SGD', env: ON });
    expect(result.candidates.map((entry) => [entry.productId, entry.raw.shade_line.product_line_id])).toEqual([
      ['k2207', LINE],
      ['n001', OTHER_LINE],
    ]);
  });

  test('respects the same-item dedupe: cards of one sellable item are one shade, and a second pass changes nothing', async () => {
    const input = [
      candidate('k2207', { sellable: 'sig_same' }),
      candidate('k2207-mirror', { sellable: 'sig_same' }),
      candidate('t415'),
    ];
    const once = await discovery()(input, { servingCurrency: 'SGD', env: ON });
    expect(once.candidates).toHaveLength(1);
    expect(once.candidates[0].raw.shade_line.shade_count).toBe(2);
    const twice = await discovery()(once.candidates, { servingCurrency: 'SGD', env: ON });
    expect(twice.candidates).toHaveLength(1);
    expect(twice.candidates[0].raw.shade_line).toMatchObject({ shade_count: 2, from_price: { amount: 30, currency: 'SGD' } });
  });

  test('a later pass that sees the line card beside another shade keeps the whole-line count', async () => {
    const resolver = async () => [lineMemberRow('k2207'), lineMemberRow('t415'), lineMemberRow('b220'), lineMemberRow('b221')];
    const first = await discovery()([candidate('k2207'), candidate('t415')], {
      servingCurrency: 'SGD',
      lineMembersResolverFn: resolver,
      env: ON,
    });
    expect(first.candidates[0].raw.shade_line.shade_count).toBe(4);
    const second = await discovery()([first.candidates[0], candidate('b220')], { servingCurrency: 'SGD', env: ON });
    expect(second.candidates).toHaveLength(1);
    expect(second.candidates[0].raw.shade_line).toMatchObject({ shade_count: 4, in_stock_shade_count: 4 });
  });

  describe('search response body', () => {
    function product(productId, { price = 30, currency = 'SGD', inStock = true } = {}) {
      return {
        merchant_id: 'merch_obs_shopone',
        product_id: productId,
        title: `BRANDA AURA ${productId.toUpperCase()}`,
        price,
        currency,
        ...(inStock ? {} : { availability: 'out_of_stock' }),
      };
    }
    const identityRow = (productId, lineId = LINE, decision = approved(lineId)) => ({
      source_listing_ref: `merch_obs_shopone:${productId}`,
      sellable_item_group_id: `sig_${productId}`,
      product_line_id: lineId,
      match_basis: [],
      shade_line: decision,
    });

    test('flag off: the body object itself is returned and no identity row is read', async () => {
      const { collapseSearchResponseBodyByShadeLine } = require('../../src/services/shadeLineCardCollapse');
      const body = { products: [product('k2207'), product('t415')], total: 2 };
      const resolver = jest.fn();
      const out = await collapseSearchResponseBodyByShadeLine({ body, servingCurrency: 'SGD', identityRowsResolverFn: resolver });
      expect(out).toBe(body);
      expect(resolver).not.toHaveBeenCalled();
    });

    test('flag on: products, results and data.products are collapsed together and total shrinks', async () => {
      process.env[FLAG] = 'true';
      const { collapseSearchResponseBodyByShadeLine } = require('../../src/services/shadeLineCardCollapse');
      const products = [product('k2207', { inStock: false, price: 20 }), product('other'), product('t415', { price: 33 }), product('p380', { price: 31 })];
      const body = { products, results: products, data: { products }, total: 40, metadata: { query_source: 'x' } };
      const identityRowsResolverFn = jest.fn(async ({ sourceListingRefs }) => {
        expect(sourceListingRefs).toEqual([
          'merch_obs_shopone:k2207',
          'merch_obs_shopone:other',
          'merch_obs_shopone:t415',
          'merch_obs_shopone:p380',
        ]);
        return [identityRow('k2207'), identityRow('t415'), identityRow('p380'), identityRow('other', OTHER_LINE, null)];
      });
      const out = await collapseSearchResponseBodyByShadeLine({ body, servingCurrency: 'SGD', identityRowsResolverFn });
      expect(out.products.map((entry) => entry.product_id)).toEqual(['t415', 'other']);
      expect(out.results).toBe(out.products);
      expect(out.data.products).toBe(out.products);
      expect(out.total).toBe(38);
      expect(out.products[0]).toMatchObject({
        product_line_id: LINE,
        shade_count: 3,
        shade_line: { from_price: { amount: 31, currency: 'SGD' }, in_stock_shade_count: 2 },
      });
      expect(out.metadata).toMatchObject({ query_source: 'x', shade_line_collapse: { lines_collapsed: 1, cards_dropped: 2 } });
    });

    test('flag on but no card is in an approved line: the body is returned untouched', async () => {
      process.env[FLAG] = '1';
      const { collapseSearchResponseBodyByShadeLine } = require('../../src/services/shadeLineCardCollapse');
      const body = { products: [product('k2207'), product('t415')] };
      const out = await collapseSearchResponseBodyByShadeLine({
        body,
        servingCurrency: 'SGD',
        identityRowsResolverFn: async () => [identityRow('k2207', LINE, null), identityRow('t415', LINE, null)],
      });
      expect(out).toBe(body);
    });
  });

  describe('listLiveShadeLineMembers', () => {
    test('prices from current seed columns, deterministic order, a per-line cap, no source_payload read', async () => {
      process.env.DATABASE_URL = 'postgres://test';
      const { listLiveShadeLineMembers } = require('../../src/services/pdpIdentityGraph');
      const queryFn = jest.fn(async () => ({
        rows: [
          { source_listing_ref: 'm:a', product_line_id: LINE, sellable_item_group_id: 'sig_a', shade_line: approved(LINE), price_amount: '30.00', price_currency: 'sgd', availability: 'in_stock' },
          { source_listing_ref: 'm:b', product_line_id: LINE, sellable_item_group_id: 'sig_b', shade_line: null, price_amount: null, price_currency: null, availability: null },
        ],
      }));
      const rows = await listLiveShadeLineMembers({ productLineIds: [LINE], perLineLimit: 50, queryFn });
      const [sql, params] = queryFn.mock.calls[0];
      expect(sql).toMatch(/row_number\(\) OVER \(\s*PARTITION BY pil\.product_line_id\s*ORDER BY pil\.source_listing_ref\s*\)/);
      expect(sql).toMatch(/WHERE ranked\.line_rank <= \$2/);
      expect(sql).toMatch(/ORDER BY ranked\.product_line_id, ranked\.source_listing_ref/);
      expect(sql).toMatch(/FROM external_product_seeds e/);
      expect(sql).toMatch(/serving_decision = 'public'/);
      expect(sql).not.toMatch(/source_payload/);
      expect(params).toEqual([[LINE], 50]);
      expect(rows[0].card_facts).toEqual({ price: 30, currency: 'SGD', availability: 'in_stock' });
      expect(rows[1].card_facts).toEqual({});
    });
  });
});
