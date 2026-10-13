// Discovery feed end to end: one card per verified shade line when SHADE_LINE_CARD_COLLAPSE_ENABLED
// is on; the old list when it is off. Invented store and brand.

describe('discovery feed shade line collapse', () => {
  const ORIGINAL_ENV = process.env;
  const LINE = 'pl_cccccccccccccccccccccccc';

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test' };
    delete process.env.SHADE_LINE_CARD_COLLAPSE_ENABLED;
    delete process.env.DATABASE_URL;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  const shade = (productId, { price = 16, inStock = true } = {}) => ({
    merchant_id: 'merch_shopone',
    product_id: productId,
    title: `BRANDA Gel Polish ${productId.toUpperCase()}`,
    description: 'Gel nail polish',
    brand: 'BRANDA',
    category: 'Nail Polish',
    product_type: 'Nail Polish',
    price,
    currency: 'USD',
    inventory_quantity: inStock ? 10 : 0,
    ...(inStock ? {} : { in_stock: false, availability: 'out_of_stock' }),
    canonical_url: `https://shop-one.example/products/${productId}`,
    image_url: `https://shop-one.example/images/${productId}.jpg`,
    status: 'active',
  });

  const identityRow = (productId) => ({
    source_listing_ref: `merch_shopone:${productId}`,
    merchant_id: 'merch_shopone',
    product_id: productId,
    source_kind: 'internal',
    source_tier: 'merchant',
    sellable_item_group_id: `sig_${productId}`,
    product_line_id: LINE,
    review_family_id: 'rf_line',
    identity_confidence: 0.8,
    match_basis: ['official_url:https://shop-one.example/products/x'],
    // As listLivePdpIdentityRowsForRefs reads it: soft_identity->'shade_line' AS shade_line.
    shade_line: { rule_version: 'shade_line_v2', status: 'approved', product_line_id: LINE, store: 'merch_shopone@shop-one.example' },
  });

  async function run(extraRequest = {}, options = {}) {
    const { getDiscoveryFeed } = require('../src/services/discoveryFeed');
    return getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
        scope: { brand_names: ['BRANDA'] },
        context: { locale: 'en-US' },
        ...extraRequest,
      },
      {
        candidateProducts: [
          shade('k2207', { price: 18 }),
          shade('t415', { price: 16 }),
          shade('p380', { price: 14 }),
        ],
        identityGraphRowsResolverFn: async () => [identityRow('k2207'), identityRow('t415'), identityRow('p380')],
        // An out-of-stock shade the page never recalled (the feed drops unsellable cards): it
        // counts as a shade but is not a "from" price.
        shadeLineMembersResolverFn: async () => [
          {
            ...identityRow('b220'),
            card_facts: { price: 9, currency: 'USD', availability: 'out_of_stock' },
          },
        ],
        ...options,
      },
    );
  }

  test('flag off: every shade is its own card', async () => {
    const response = await run();
    expect(response.products).toHaveLength(3);
    expect(response.products.every((product) => !product.shade_line)).toBe(true);
    expect(response.metadata.shade_line_collapse).toBeUndefined();
  });

  test('flag on: one card for the line, in stock, priced as its own listing, with the shade count', async () => {
    process.env.SHADE_LINE_CARD_COLLAPSE_ENABLED = 'true';
    const response = await run();
    expect(response.products).toHaveLength(1);
    expect(response.products[0].shade_line).toMatchObject({
      product_line_id: LINE,
      shade_count: 4,
      in_stock_shade_count: 3,
    });
    // The card keeps its own listing's price; no "from" price from another shade.
    expect(response.products[0].shade_line).not.toHaveProperty('from_price');
    expect(response.products[0].price).toBe(18);
    expect(response.products[0].shade_count).toBe(4);
    expect(response.metadata.shade_line_collapse).toMatchObject({ applied: true, lines_collapsed: 1, cards_dropped: 2 });
  });

  test('the shade-line decision is never projected onto a card (search and discovery match on card fields)', async () => {
    process.env.SHADE_LINE_CARD_COLLAPSE_ENABLED = 'true';
    const response = await run();
    const card = response.products[0];
    expect(card.identityShadeLine).toBeUndefined();
    expect(JSON.stringify(card.match_basis || [])).not.toMatch(/shade_line|line_rule|approved/);
    expect(JSON.stringify(card.identity_graph || {})).not.toMatch(/shade_line|approved/);
  });

  test('card-mode discovery (response_detail=card) carries shade_line and shade_count too', async () => {
    process.env.SHADE_LINE_CARD_COLLAPSE_ENABLED = 'true';
    const response = await run({ response_detail: 'card' });
    expect(response.products).toHaveLength(1);
    expect(response.products[0]).toMatchObject({
      shade_count: 4,
      shade_line: { product_line_id: LINE, shade_count: 4 },
    });
  });

  test('the recalled cards\' own identity rows verify the line, with no member read at all', async () => {
    process.env.SHADE_LINE_CARD_COLLAPSE_ENABLED = 'true';
    const response = await run({}, { shadeLineMembersResolverFn: async () => [] });
    expect(response.products).toHaveLength(1);
    expect(response.products[0].shade_line).toMatchObject({ product_line_id: LINE, shade_count: 3 });
  });
});
