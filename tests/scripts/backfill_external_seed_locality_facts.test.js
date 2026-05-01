const {
  buildLocalityBackfillPlanForRow,
  buildSelectRowsSql,
  summarizePlans,
} = require('../../scripts/backfill-external-seed-locality-facts.cjs');

describe('backfill-external-seed-locality-facts', () => {
  test('builds a bounded default select that skips already-normalized rows', () => {
    const { sql, params } = buildSelectRowsSql({
      market: 'KR',
      brand: 'Round Lab',
      limit: 25,
    });

    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("seed_data->'locality_facts_v1' IS NULL");
    expect(sql).toContain("seed_data#>'{snapshot,locality_facts_v1}' IS NULL");
    expect(sql).toContain('LIMIT $3');
    expect(params).toEqual(['KR', 'Round Lab', 25]);
  });

  test('plans a dry-run seed_data update with locality facts but does not require DB writes', () => {
    const plan = buildLocalityBackfillPlanForRow({
      id: 123,
      market: 'KR',
      tool: 'creator_agents',
      domain: 'www.oliveyoung.co.kr',
      external_product_id: 'ext_roundlab_spf',
      canonical_url: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=C000',
      destination_url: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=C000',
      title: 'Round Lab Birch Moisturizing Sun Stick SPF50 Mini',
      seed_data: {
        brand: 'Round Lab',
        snapshot: {
          title: 'Round Lab Birch Moisturizing Sun Stick SPF50 Mini',
          brand: 'Round Lab',
        },
      },
    });

    expect(plan.changed).toBe(true);
    expect(plan.locality_facts_v1.brand_home_market).toBe('KR');
    expect(plan.locality_facts_v1.local_purchase_markets).toContain('KR');
    expect(plan.next_seed_data.snapshot.locality_facts_v1.travel_size).toBe(true);
  });

  test('summarizes changed rows and unknown brand gaps for review', () => {
    const plans = [
      buildLocalityBackfillPlanForRow({
        id: 1,
        market: 'KR',
        title: 'Round Lab Mini SPF',
        seed_data: { brand: 'Round Lab', snapshot: { title: 'Round Lab Mini SPF', brand: 'Round Lab' } },
      }),
      buildLocalityBackfillPlanForRow({
        id: 2,
        market: 'US',
        title: 'Unknown Brand Full Size Cream',
        seed_data: { brand: 'Unknown Brand', snapshot: { title: 'Unknown Brand Full Size Cream', brand: 'Unknown Brand' } },
      }),
    ];

    const summary = summarizePlans(plans);
    expect(summary.total_rows).toBe(2);
    expect(summary.changed_rows).toBe(2);
    expect(summary.market_counts).toEqual({ KR: 1, US: 1 });
    expect(summary.unknown_brand_home_market_sample).toContain('Unknown Brand');
  });
});
