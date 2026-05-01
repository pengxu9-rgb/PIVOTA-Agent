const {
  buildSelectSql,
  buildMarketCoverageGroups,
  summarizeCoverageGroups,
} = require('../../scripts/audit-external-seed-market-coverage.cjs');

describe('audit-external-seed-market-coverage', () => {
  test('builds a bounded query with optional market and brand filters', () => {
    const { sql, params } = buildSelectSql({
      market: 'US',
      brand: 'Beauty of Joseon',
      limit: 25,
    });

    expect(sql).toContain("eps.status = 'active'");
    expect(sql).toContain("eps.external_product_id LIKE 'ext_%'");
    expect(sql).toContain('eps.market = $1');
    expect(sql).toContain('lower(coalesce(eps.brand');
    expect(sql).toContain('LIMIT $3');
    expect(params).toEqual(['US', 'beauty of joseon', 25, 0]);
  });

  test('groups same title core across multiple markets into one coverage bucket', () => {
    const groups = buildMarketCoverageGroups([
      {
        id: 1,
        external_product_id: 'ext_us_1',
        market: 'US',
        tool: 'creator_agents',
        brand: 'Beauty of Joseon',
        domain: 'beautyofjoseon.com',
        title: 'Glow Deep Serum : Rice + Alpha-Arbutin',
        canonical_url: 'https://beautyofjoseon.com/products/glow-deep-serum',
        price_amount: 17,
        price_currency: 'USD',
        availability: 'in_stock',
        seed_data: {
          commerce_facts_v1: {
            contract_version: 'commerce_facts.v1',
            market_id: 'US',
            currency_target: 'USD',
            regional_price: { amount: 17, currency: 'USD', observed_currency: 'USD' },
          },
        },
      },
      {
        id: 2,
        external_product_id: 'ext_eu_1',
        market: 'EU-DE',
        tool: 'creator_agents',
        brand: 'Beauty of Joseon',
        domain: 'beautyofjoseon.com',
        title: 'Glow Deep Serum : Rice + Alpha-Arbutin',
        canonical_url: 'https://beautyofjoseon.com/products/glow-deep-serum',
        price_amount: 17,
        price_currency: 'EUR',
        availability: 'in_stock',
        seed_data: {
          commerce_facts_v1: {
            contract_version: 'commerce_facts.v1',
            market_id: 'EU-DE',
            currency_target: 'EUR',
            regional_price: { amount: 17, currency: 'EUR', observed_currency: 'EUR' },
          },
        },
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].multi_market).toBe(true);
    expect(groups[0].markets).toEqual(['EU-DE', 'US']);
    expect(groups[0].currencies).toEqual(['EUR', 'USD']);
    expect(groups[0].currency_divergence).toBe(true);
  });

  test('summarizes multi-market coverage counts for operator review', () => {
    const summary = summarizeCoverageGroups([
      {
        brand: 'Beauty of Joseon',
        title_core_norm: 'glow deep serum rice alpha arbutin',
        markets: ['EU-DE', 'US'],
        market_count: 2,
        currencies: ['EUR', 'USD'],
        multi_market: true,
        currency_divergence: true,
        total_row_count: 2,
      },
      {
        brand: 'Anua',
        title_core_norm: 'heartleaf 80 moisture soothing ampoule',
        markets: ['US'],
        market_count: 1,
        currencies: ['USD'],
        multi_market: false,
        currency_divergence: false,
        total_row_count: 1,
      },
    ]);

    expect(summary.total_groups).toBe(2);
    expect(summary.multi_market_groups).toBe(1);
    expect(summary.single_market_groups).toBe(1);
    expect(summary.currency_divergence_groups).toBe(1);
    expect(summary.sample_multi_market_groups[0].brand).toBe('Beauty of Joseon');
  });
});
