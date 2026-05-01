const {
  parseKnownBrandHints,
  buildSelectSql,
  deriveSeedRow,
  buildDtcCoverage,
  buildChannelCoverage,
} = require('../../scripts/audit-kbeauty-seed-baseline-coverage.cjs');

describe('audit-kbeauty-seed-baseline-coverage', () => {
  test('builds a bounded active external seed query for market audit', () => {
    const { sql, params } = buildSelectSql({ market: 'US', limit: 25 });

    expect(sql).toContain("eps.status = 'active'");
    expect(sql).toContain("eps.external_product_id LIKE 'ext_%'");
    expect(sql).toContain("(eps.tool = '*' OR eps.tool = 'creator_agents')");
    expect(sql).toContain('eps.market = $1');
    expect(sql).toContain('LIMIT $2');
    expect(params).toEqual(['US', 25]);
  });

  test('normalizes hosts from domain and canonical or destination URLs', () => {
    const row = deriveSeedRow({
      id: 1,
      external_product_id: 'ext_1',
      market: 'US',
      tool: 'creator_agents',
      brand: 'Beauty of Joseon',
      title: 'Glow Deep Serum',
      domain: 'beautyofjoseon.com',
      canonical_url: 'https://www.beautyofjoseon.com/products/glow-deep-serum',
      destination_url: 'https://beautyofjoseon.com/products/glow-deep-serum',
      availability: 'in_stock',
      price_currency: 'USD',
      seed_data: {},
    });

    expect(row.hosts).toEqual(['beautyofjoseon.com']);
    expect(row.brand_norm).toBe('beauty of joseon');
  });

  test('computes DTC brand coverage by official host', () => {
    const dtc = buildDtcCoverage(
      [
        { brand_name: 'Beauty of Joseon', official_site: 'https://beautyofjoseon.com' },
        { brand_name: 'Anua', official_site: 'https://anua.com' },
        { brand_name: 'Torriden', official_site: 'https://torriden.com' },
      ],
      [
        {
          external_product_id: 'ext_boj_1',
          brand: 'Beauty of Joseon',
          brand_norm: 'beauty of joseon',
          title: 'Glow Deep Serum',
          market: 'US',
          availability: 'in_stock',
          price_currency: 'USD',
          hosts: ['beautyofjoseon.com'],
        },
        {
          external_product_id: 'ext_torriden_1',
          brand: 'Torriden',
          brand_norm: 'torriden',
          title: 'Dive-In Serum',
          market: 'US',
          availability: 'in_stock',
          price_currency: 'USD',
          hosts: ['torriden.us'],
        },
      ],
    );

    expect(dtc.baseline_brand_count).toBe(3);
    expect(dtc.covered_brand_count).toBe(1);
    expect(dtc.active_seed_count).toBe(1);
    expect(dtc.shadow_only_brand_count).toBe(1);
    expect(dtc.shadow_only_brand_names).toEqual(['Torriden']);
    expect(dtc.strict_or_shadow_covered_brand_count).toBe(2);
    expect(dtc.missing_brand_names).toEqual(['Anua', 'Torriden']);
    expect(dtc.rows.find((row) => row.brand_name === 'Torriden')).toMatchObject({
      covered: false,
      shadow_covered: true,
      coverage_mode: 'brand_shadow_only',
      shadow_active_seed_count: 1,
      shadow_hosts: ['torriden.us'],
    });
  });

  test('computes channel coverage and matched known brands by retailer host', () => {
    const channels = buildChannelCoverage(
      [
        {
          channel_name: 'Soko Glam',
          website: 'https://sokoglam.com',
          seed_known_brands_to_check: 'COSRX; Klairs; Benton',
        },
      ],
      [
        {
          external_product_id: 'ext_sg_1',
          brand: 'COSRX',
          brand_norm: 'cosrx',
          title: 'Advanced Snail 96 Mucin Power Essence',
          market: 'US',
          availability: 'in_stock',
          price_currency: 'USD',
          hosts: ['sokoglam.com'],
        },
        {
          external_product_id: 'ext_sg_2',
          brand: 'Some Other Brand',
          brand_norm: 'some other brand',
          title: 'Other',
          market: 'US',
          availability: 'in_stock',
          price_currency: 'USD',
          hosts: ['sokoglam.com'],
        },
      ],
    );

    expect(parseKnownBrandHints('COSRX; Klairs; Benton')).toHaveLength(3);
    expect(channels.covered_channel_count).toBe(1);
    expect(channels.active_seed_count).toBe(2);
    expect(channels.matched_known_brand_count).toBe(1);
    expect(channels.rows[0].matched_known_brands).toEqual([{ label: 'COSRX', active_seed_count: 1 }]);
  });
});
