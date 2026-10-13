// One card per shade line per store (src/services/shadeLineCardCollapse.js). Invented stores and brands.

describe('shade line card collapse', () => {
  const ORIGINAL_ENV = process.env;
  const FLAG = 'SHADE_LINE_CARD_COLLAPSE_ENABLED';
  const LINE = 'pl_aaaaaaaaaaaaaaaaaaaaaaaa';
  const OTHER_LINE = 'pl_bbbbbbbbbbbbbbbbbbbbbbbb';
  const STORE = 'merch_obs_shopone@shop-one.example';
  const OTHER_STORE = 'merch_obs_shoptwo@shop-two.example';
  const approved = (lineId, store = STORE) => ({ rule_version: 'shade_line_v2', status: 'approved', product_line_id: lineId, store });
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
  // stored line on raw.identity_graph, the row's own shade-line decision on candidate.identityShadeLine.
  function candidate(productId, {
    lineId = LINE,
    decision = 'approved',
    store = STORE,
    price = 30,
    currency = 'SGD',
    inStock = true,
    sellable = `sig_${productId}`,
  } = {}) {
    const shadeLine =
      decision === 'approved'
        ? approved(lineId, store)
        : decision === 'proposed'
          ? { rule_version: 'shade_line_v2', status: 'proposed', proposed_product_line_id: 'pl_cccccccccccccccccccccccc', store }
          : decision === 'refused'
            ? { rule_version: 'shade_line_v2', status: 'refused', reason: 'size_mismatch' }
            : null;
    return {
      key: `merch::${productId}`,
      merchantId: store.split('@')[0],
      productId,
      ...(lineId && shadeLine ? { identityShadeLine: shadeLine } : {}),
      raw: {
        merchant_id: store.split('@')[0],
        product_id: productId,
        title: `BRANDA AURA ${productId.toUpperCase()}`,
        price,
        currency,
        ...(inStock ? { in_stock: true } : { in_stock: false, availability: 'out_of_stock' }),
        ...(lineId
          ? {
              product_line_id: lineId,
              sellable_item_group_id: sellable,
              identity_graph: { product_line_id: lineId, sellable_item_group_id: sellable },
            }
          : {}),
      },
    };
  }

  function lineMemberRow(productId, { lineId = LINE, store = STORE, currency = 'SGD', price = 30, inStock = true, decision = 'approved' } = {}) {
    return {
      source_listing_ref: `${store.split('@')[0]}:${productId}`,
      sellable_item_group_id: `sig_${productId}`,
      product_line_id: lineId,
      shade_line: decision === 'approved' ? approved(lineId, store) : null,
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

  test('flag on: one store\'s accepted shades become one card at its in-stock representative\'s own rank, with no borrowed price', async () => {
    const input = [
      candidate('k2207', { inStock: false, price: 20 }),
      candidate('unrelated', { lineId: null }),
      candidate('t415', { price: 33 }),
      candidate('p380', { price: 31 }),
    ];
    const result = await discovery()(input, { servingCurrency: 'SGD', env: ON });
    // The out-of-stock top member does not lift the card above "unrelated", which outranked t415.
    expect(result.candidates.map((entry) => entry.productId)).toEqual(['unrelated', 't415']);
    const card = result.candidates[1].raw;
    expect(card.shade_line).toEqual({
      product_line_id: LINE,
      rule_version: 'shade_line_v2',
      shade_count: 3,
      in_stock_shade_count: 2,
      currency: 'SGD',
      collapsed_card_count: 3,
    });
    // The card's price is its own listing's (the #2416 rule): no "from" price from another shade.
    expect(card.price).toBe(33);
    expect(JSON.stringify(card.shade_line)).not.toMatch(/from_price|merch_obs|member_refs|representative/);
    expect(result.stats).toMatchObject({ applied: true, lines_collapsed: 1, cards_dropped: 2, line_cards: 1 });
  });

  test('never folds a member without its own approval: a v1 sibling, a refused or a proposed member stays its own card', async () => {
    const input = [
      candidate('k2207'),
      candidate('v1-sibling', { decision: null }),
      candidate('refused', { decision: 'refused' }),
      candidate('proposed', { decision: 'proposed' }),
      candidate('t415'),
    ];
    const result = await discovery()(input, { servingCurrency: 'SGD', env: ON });
    expect(result.candidates.map((entry) => entry.productId)).toEqual(['k2207', 'v1-sibling', 'refused', 'proposed']);
    expect(result.candidates[0].raw.shade_line.shade_count).toBe(2);
    expect(result.candidates.slice(1).every((entry) => !entry.raw.shade_line)).toBe(true);
  });

  test('never folds another merchant\'s listings: buckets are per store, and the representative is its own store\'s', async () => {
    const input = [
      candidate('two-a', { store: OTHER_STORE }),
      candidate('k2207'),
      candidate('two-b', { store: OTHER_STORE }),
      candidate('t415'),
    ];
    const result = await discovery()(input, { servingCurrency: 'SGD', env: ON });
    expect(result.candidates.map((entry) => entry.productId)).toEqual(['two-a', 'k2207']);
    expect(result.candidates.map((entry) => entry.raw.shade_line.shade_count)).toEqual([2, 2]);
    expect(result.candidates[0].raw.merchant_id).toBe('merch_obs_shoptwo');
    expect(result.candidates[1].raw.merchant_id).toBe('merch_obs_shopone');
  });

  test('a decision with no store never folds', async () => {
    const noStore = (id) => ({ ...candidate(id), identityShadeLine: { rule_version: 'shade_line_v2', status: 'approved', product_line_id: LINE } });
    const input = [noStore('k2207'), noStore('t415')];
    const result = await discovery()(input, { servingCurrency: 'SGD', env: ON });
    expect(result.candidates).toBe(input);
  });

  test('every member out of stock: the top-ranked one represents the line', async () => {
    const input = [candidate('k2207', { inStock: false }), candidate('t415', { inStock: false })];
    const result = await discovery()(input, { servingCurrency: 'SGD', env: ON });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].productId).toBe('k2207');
    expect(result.candidates[0].raw.shade_line.in_stock_shade_count).toBe(0);
  });

  test('the line\'s other ACCEPTED members of the SAME store, priced in the buyer currency, count toward the shades', async () => {
    const resolver = jest.fn(async ({ productLineIds }) => {
      expect(productLineIds).toEqual([LINE]);
      return [
        lineMemberRow('t415'), // already a card: counted once
        lineMemberRow('b220'),
        lineMemberRow('b221', { inStock: false }),
        lineMemberRow('b222', { currency: 'USD' }), // another market
        lineMemberRow('b223', { price: 0 }), // no current seed price
        lineMemberRow('b224', { store: OTHER_STORE }), // another store
        lineMemberRow('b225', { decision: null }), // no approval of its own
      ];
    });
    const input = [candidate('k2207'), candidate('t415')];
    const result = await discovery()(input, { servingCurrency: 'SGD', lineMembersResolverFn: resolver, env: ON });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].raw.shade_line).toMatchObject({ shade_count: 4, in_stock_shade_count: 3 });
  });

  test('members are read only for lines a card is an accepted member of', async () => {
    const resolver = jest.fn(async () => []);
    const input = [candidate('k2207', { decision: 'refused' }), candidate('t415', { decision: null }), candidate('n1', { lineId: OTHER_LINE })];
    await discovery()(input, { servingCurrency: 'SGD', lineMembersResolverFn: resolver, env: ON });
    expect(resolver).toHaveBeenCalledWith({ productLineIds: [OTHER_LINE] });
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
    expect(sgd.candidates[0].raw.shade_line.shade_count).toBe(2);
    expect(sgd.candidates[1].raw.shade_line).toBeUndefined();

    const usd = await discovery()(input, { servingCurrency: 'USD', env: ON });
    expect(usd.candidates).toHaveLength(3);
    expect(usd.candidates.every((entry) => !entry.raw.shade_line)).toBe(true);
  });

  test('no serving currency (a market nothing is priced for): nothing folds', async () => {
    const input = [candidate('k2207'), candidate('t415')];
    const result = await discovery()(input, { servingCurrency: null, env: ON });
    expect(result.candidates).toEqual(input);
    expect(result.stats.reason).toBe('no_serving_currency');
  });

  test('two lines fold separately', async () => {
    const input = [candidate('k2207'), candidate('n001', { lineId: OTHER_LINE }), candidate('t415'), candidate('n002', { lineId: OTHER_LINE })];
    const result = await discovery()(input, { servingCurrency: 'SGD', env: ON });
    expect(result.candidates.map((entry) => [entry.productId, entry.raw.shade_line.product_line_id])).toEqual([
      ['k2207', LINE],
      ['n001', OTHER_LINE],
    ]);
  });

  test('respects the same-item dedupe, and a second pass changes nothing', async () => {
    const input = [candidate('k2207', { sellable: 'sig_same' }), candidate('k2207-mirror', { sellable: 'sig_same' }), candidate('t415')];
    const once = await discovery()(input, { servingCurrency: 'SGD', env: ON });
    expect(once.candidates).toHaveLength(1);
    expect(once.candidates[0].raw.shade_line.shade_count).toBe(2);
    const twice = await discovery()(once.candidates, { servingCurrency: 'SGD', env: ON });
    expect(twice.candidates).toHaveLength(1);
    expect(twice.candidates[0].raw.shade_line.shade_count).toBe(2);
  });

  test('a later pass that sees the line card beside another shade keeps the whole-line count', async () => {
    const resolver = async () => [lineMemberRow('k2207'), lineMemberRow('t415'), lineMemberRow('b220'), lineMemberRow('b221')];
    const first = await discovery()([candidate('k2207'), candidate('t415')], { servingCurrency: 'SGD', lineMembersResolverFn: resolver, env: ON });
    expect(first.candidates[0].raw.shade_line.shade_count).toBe(4);
    const second = await discovery()([first.candidates[0], candidate('b220')], { servingCurrency: 'SGD', env: ON });
    expect(second.candidates).toHaveLength(1);
    expect(second.candidates[0].raw.shade_line).toMatchObject({ shade_count: 4, in_stock_shade_count: 4 });
  });

  describe('search response body', () => {
    function product(productId, { price = 30, currency = 'SGD', inStock = true, merchantId = 'merch_obs_shopone' } = {}) {
      return {
        merchant_id: merchantId,
        product_id: productId,
        title: `BRANDA AURA ${productId.toUpperCase()}`,
        price,
        currency,
        ...(inStock ? {} : { availability: 'out_of_stock' }),
      };
    }
    const identityRow = (productId, { lineId = LINE, decision = approved(LINE), merchantId = 'merch_obs_shopone' } = {}) => ({
      source_listing_ref: `${merchantId}:${productId}`,
      sellable_item_group_id: `sig_${productId}`,
      product_line_id: lineId,
      match_basis: [],
      shade_line: decision,
    });
    const lineRows = async () => [identityRow('k2207'), identityRow('t415'), identityRow('p380'), identityRow('other', { lineId: OTHER_LINE, decision: null })];
    const pool = () => [product('k2207', { inStock: false, price: 20 }), product('other'), product('t415', { price: 33 }), product('p380', { price: 31 }), product('n1'), product('n2')];

    test('flag off: the body object itself is returned and no identity row is read', async () => {
      const { collapseSearchResponseBodyByShadeLine } = require('../../src/services/shadeLineCardCollapse');
      const body = { products: pool(), total: 6 };
      const resolver = jest.fn();
      const out = await collapseSearchResponseBodyByShadeLine({ body, servingCurrency: 'SGD', requestedLimit: 3, identityRowsResolverFn: resolver });
      expect(out).toBe(body);
      expect(resolver).not.toHaveBeenCalled();
    });

    test('flag on, page 1, a pool wider than the page: the line folds, mirrors follow, total is left as the lane reported it', async () => {
      process.env[FLAG] = 'true';
      const { collapseSearchResponseBodyByShadeLine } = require('../../src/services/shadeLineCardCollapse');
      const products = pool();
      const body = { products, results: products, data: { products }, total: 40, metadata: { query_source: 'x' } };
      const out = await collapseSearchResponseBodyByShadeLine({ body, servingCurrency: 'SGD', requestedLimit: 3, identityRowsResolverFn: lineRows });
      expect(out.products.map((entry) => entry.product_id)).toEqual(['other', 't415', 'n1', 'n2']);
      expect(out.results).toBe(out.products);
      expect(out.data.products).toBe(out.products);
      expect(out.total).toBe(40);
      expect(out.products[1]).toMatchObject({ product_line_id: LINE, shade_count: 3, price: 33, shade_line: { in_stock_shade_count: 2 } });
      expect(out.products[1].shade_line).not.toHaveProperty('from_price');
      expect(out.metadata).toMatchObject({ query_source: 'x', shade_line_collapse: { lines_collapsed: 1, cards_dropped: 2, pool_size: 6, requested_limit: 3 } });
    });

    test('folds only what the pool over-fetched: a line needing more drops than the pool spares stays unfolded', async () => {
      process.env[FLAG] = 'true';
      const { collapseSearchResponseBodyByShadeLine } = require('../../src/services/shadeLineCardCollapse');
      // Pool of 6 for a page of 5: one spare card, but the line would drop two.
      const short = await collapseSearchResponseBodyByShadeLine({ body: { products: pool() }, servingCurrency: 'SGD', requestedLimit: 5, identityRowsResolverFn: lineRows });
      expect(short.products).toHaveLength(6);
      expect(short.products.some((entry) => entry.shade_line && entry.shade_line.collapsed_card_count > 1)).toBe(false);
      // No requested page size known: nothing folds either.
      const unknown = await collapseSearchResponseBodyByShadeLine({ body: { products: pool() }, servingCurrency: 'SGD', identityRowsResolverFn: lineRows });
      expect(unknown.products).toHaveLength(6);
    });

    test('budgets only the cards that survive the door\'s guards; cards that will not survive never fold', async () => {
      process.env[FLAG] = 'true';
      const { collapseSearchResponseBodyByShadeLine } = require('../../src/services/shadeLineCardCollapse');
      const keys = (ids) => new Set(ids.map((id) => `merch_obs_shopone:${id}`));
      // Pool 6, page 3, but only 4 cards survive the guards: one spare card, the line needs two.
      const tight = await collapseSearchResponseBodyByShadeLine({
        body: { products: pool() },
        servingCurrency: 'SGD',
        requestedLimit: 3,
        survivorKeys: keys(['k2207', 't415', 'p380', 'other']),
        identityRowsResolverFn: lineRows,
      });
      expect(tight.products).toHaveLength(6);
      expect(tight.products.some((entry) => entry.shade_line)).toBe(false);
      // A member the guards will drop is not folded (nor chosen to represent the line).
      const partial = await collapseSearchResponseBodyByShadeLine({
        body: { products: pool() },
        servingCurrency: 'SGD',
        requestedLimit: 2,
        survivorKeys: keys(['k2207', 't415', 'other', 'n1', 'n2']),
        identityRowsResolverFn: lineRows,
      });
      expect(partial.products.map((entry) => entry.product_id)).toEqual(['other', 't415', 'p380', 'n1', 'n2']);
      expect(partial.metadata.shade_line_collapse).toMatchObject({ cards_dropped: 1, surviving_pool_size: 5 });
      // Unknown survivors (the probe failed): nothing folds.
      const unknown = await collapseSearchResponseBodyByShadeLine({
        body: { products: pool() },
        servingCurrency: 'SGD',
        requestedLimit: 2,
        survivorKeys: null,
        identityRowsResolverFn: lineRows,
      });
      expect(unknown.products).toHaveLength(6);
    });

    test('folds on the first page only', async () => {
      process.env[FLAG] = 'true';
      const { collapseSearchResponseBodyByShadeLine } = require('../../src/services/shadeLineCardCollapse');
      const resolver = jest.fn(lineRows);
      const body = { products: pool() };
      expect(await collapseSearchResponseBodyByShadeLine({ body, servingCurrency: 'SGD', requestedLimit: 3, page: 2, identityRowsResolverFn: resolver })).toBe(body);
      expect(await collapseSearchResponseBodyByShadeLine({ body, servingCurrency: 'SGD', requestedLimit: 3, offset: 3, identityRowsResolverFn: resolver })).toBe(body);
      expect(resolver).not.toHaveBeenCalled();
    });

    test('flag on but no card is an accepted member: the body is returned untouched', async () => {
      process.env[FLAG] = '1';
      const { collapseSearchResponseBodyByShadeLine } = require('../../src/services/shadeLineCardCollapse');
      const body = { products: pool() };
      const out = await collapseSearchResponseBodyByShadeLine({
        body,
        servingCurrency: 'SGD',
        requestedLimit: 3,
        identityRowsResolverFn: async () => [identityRow('k2207', { decision: null }), identityRow('t415', { decision: null })],
      });
      expect(out).toBe(body);
    });
  });

  describe('listLiveShadeLineMembers', () => {
    test('accepted members only, per-line cap BEFORE the seed join and the trust check, deterministic order, no source_payload', async () => {
      process.env.DATABASE_URL = 'postgres://test';
      const { listLiveShadeLineMembers } = require('../../src/services/pdpIdentityGraph');
      const queryFn = jest.fn(async () => ({
        rows: [
          { source_listing_ref: 'm:a', product_line_id: LINE, sellable_item_group_id: 'sig_a', shade_line: approved(LINE), price_amount: '30.00', price_currency: 'sgd', availability: 'in_stock' },
          { source_listing_ref: 'm:b', product_line_id: LINE, sellable_item_group_id: 'sig_b', shade_line: approved(LINE), price_amount: null, price_currency: null, availability: null },
        ],
      }));
      const rows = await listLiveShadeLineMembers({ productLineIds: [LINE], perLineLimit: 50, queryFn });
      const [sql, params] = queryFn.mock.calls[0];
      const capAt = sql.indexOf('WHERE ranked.line_rank <= $2');
      expect(capAt).toBeGreaterThan(0);
      expect(sql.indexOf('FROM external_product_seeds e')).toBeGreaterThan(capAt);
      expect(sql.indexOf("crt.serving_decision = 'public'")).toBeGreaterThan(capAt);
      expect(sql).toMatch(/soft_identity->'shade_line'->>'status' = 'approved'/);
      expect(sql).toMatch(/soft_identity->'shade_line'->>'product_line_id' = pil\.product_line_id/);
      expect(sql).toMatch(/row_number\(\) OVER \(\s*PARTITION BY pil\.product_line_id\s*ORDER BY pil\.source_listing_ref\s*\)/);
      expect(sql).toMatch(/ORDER BY capped\.product_line_id, capped\.source_listing_ref/);
      expect(sql).not.toMatch(/source_payload/);
      expect(params).toEqual([[LINE], 50]);
      expect(rows[0].card_facts).toEqual({ price: 30, currency: 'SGD', availability: 'in_stock' });
      expect(rows[1].card_facts).toEqual({});
    });
  });

  describe('listLivePdpIdentityRowsForRefs', () => {
    test('reads the shade-line decision only when the collapse flag is on', async () => {
      process.env.DATABASE_URL = 'postgres://test';
      const { listLivePdpIdentityRowsForRefs } = require('../../src/services/pdpIdentityGraph');
      const queryFn = jest.fn(async () => ({ rows: [] }));
      await listLivePdpIdentityRowsForRefs({ sourceListingRefs: ['m:a'], queryFn });
      expect(queryFn.mock.calls[0][0]).not.toMatch(/shade_line/);
      process.env[FLAG] = 'true';
      await listLivePdpIdentityRowsForRefs({ sourceListingRefs: ['m:a'], queryFn });
      expect(queryFn.mock.calls[1][0]).toMatch(/pil\.soft_identity->'shade_line' AS shade_line/);
    });
  });
});
