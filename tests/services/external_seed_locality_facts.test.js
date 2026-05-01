const {
  applyLocalityFactsToSeedData,
  resolveExternalSeedLocalityFacts,
} = require('../../src/services/externalSeedLocalityFacts');
const {
  buildExternalSeedBrandSearchProduct,
  buildExternalSeedProduct,
} = require('../../src/services/externalSeedProducts');
const {
  __internal: travelLocalAuthorityInternal,
} = require('../../src/auroraBff/travelLocalProductAuthority');

describe('external seed locality facts', () => {
  test('normalizes brand origin, market availability, retail channel, and travel-size evidence', () => {
    const row = {
      id: 'eps_roundlab_kr_spf',
      market: 'KR',
      domain: 'www.oliveyoung.co.kr',
      external_product_id: 'ext_roundlab_birch_stick_mini',
      title: 'Round Lab Birch Moisturizing Sun Stick SPF50 Mini',
      canonical_url: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=A000',
      destination_url: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=A000',
      seed_data: {
        brand: 'Round Lab',
        snapshot: {
          title: 'Round Lab Birch Moisturizing Sun Stick SPF50 Mini',
          brand: 'Round Lab',
        },
      },
    };

    const facts = resolveExternalSeedLocalityFacts({
      row,
      seedData: row.seed_data,
      snapshot: row.seed_data.snapshot,
    });

    expect(facts.brand_origin_country).toBe('KR');
    expect(facts.brand_origin).toEqual(expect.objectContaining({ country: 'KR', home_market: 'KR' }));
    expect(facts.brand_home_market).toBe('KR');
    expect(facts.market_availability).toEqual(expect.objectContaining({
      available_markets: expect.arrayContaining(['KR']),
      local_purchase_markets: expect.arrayContaining(['KR']),
    }));
    expect(facts.available_markets).toContain('KR');
    expect(facts.local_purchase_markets).toContain('KR');
    expect(facts.local_retail_channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'olive_young', market: 'KR' }),
      ]),
    );
    expect(facts.travel_size).toBe(true);
    expect(facts.travel_size_evidence).toMatch(/mini/i);

    const nextSeedData = applyLocalityFactsToSeedData(row.seed_data, facts);
    expect(nextSeedData.locality_facts_v1.brand_home_market).toBe('KR');
    expect(nextSeedData.snapshot.market_availability.local_purchase_markets).toContain('KR');
    expect(nextSeedData.snapshot.locality_facts_v1.local_purchase_markets).toContain('KR');
    expect(nextSeedData.snapshot.local_retail_channel).toContain('olive_young');
  });

  test('does not turn weak K-beauty title tokens into Seoul local-purchase authority', () => {
    const product = buildExternalSeedBrandSearchProduct({
      id: 'eps_us_roundlab',
      market: 'US',
      tool: 'creator_agents',
      status: 'active',
      domain: 'example.com',
      external_product_id: 'ext_us_roundlab_dokdo_cleanser',
      canonical_url: 'https://example.com/products/dokdo-cleanser',
      destination_url: 'https://example.com/products/dokdo-cleanser',
      title: 'Dokdo Cleansing Water',
      price_currency: 'USD',
      seed_data: {
        brand: 'Round Lab',
        snapshot: {
          title: 'Dokdo Cleansing Water',
          brand: 'Round Lab',
          category: 'Cleanser',
        },
        derived: {
          recall: {
            retrieval_title: 'Dokdo Cleansing Water',
            retrieval_summary: 'gentle cleansing water',
            category: 'Cleanser',
            brand: 'Round Lab',
          },
        },
      },
    });

    expect(product.brand_home_market).toBe('KR');
    expect(product.local_purchase_markets).toContain('US');
    expect(product.creator_local_reason).toBeUndefined();
    expect(travelLocalAuthorityInternal.hasTravelLocalCatalogAuthority(product, 'KR')).toBe(false);
    expect(travelLocalAuthorityInternal.hasTravelLocalCatalogAuthority(product, 'US')).toBe(true);
  });

  test('keeps out-of-stock market rows out of local purchase authority', () => {
    const facts = resolveExternalSeedLocalityFacts({
      row: {
        id: 'eps_oos',
        market: 'KR',
        availability: 'Out of Stock',
        domain: 'www.oliveyoung.co.kr',
        title: 'Round Lab Birch Sunscreen',
      },
      seedData: {
        brand: 'Round Lab',
        snapshot: { title: 'Round Lab Birch Sunscreen', brand: 'Round Lab' },
      },
      snapshot: { title: 'Round Lab Birch Sunscreen', brand: 'Round Lab' },
    });

    expect(facts.available_markets).toContain('KR');
    expect(facts.local_purchase_markets).not.toContain('KR');
    expect(facts.market_availability.availability_status).toBe('Out of Stock');
  });

  test('maps production brand aliases onto reviewed home-market facts', () => {
    const tirtirFacts = resolveExternalSeedLocalityFacts({
      row: {
        id: 'eps_tirtir_us',
        market: 'US',
        domain: 'tirtir.global',
        title: 'Mask Fit Red Cushion',
      },
      seedData: {
        brand: 'TIRTIR Global',
        snapshot: { title: 'Mask Fit Red Cushion', brand: 'TIRTIR Global' },
      },
      snapshot: { title: 'Mask Fit Red Cushion', brand: 'TIRTIR Global' },
    });
    expect(tirtirFacts.brand_origin_country).toBe('KR');
    expect(tirtirFacts.brand_home_market).toBe('KR');
    expect(tirtirFacts.local_purchase_markets).toContain('US');
    expect(tirtirFacts.creator_local_reason).toBeNull();

    const laneigeFacts = resolveExternalSeedLocalityFacts({
      row: {
        id: 'eps_laneige_us',
        market: 'US',
        domain: 'us.laneige.com',
        title: 'Lip Glowy Balm',
      },
      seedData: {
        brand: 'LANEIGE US',
        snapshot: { title: 'Lip Glowy Balm', brand: 'LANEIGE US' },
      },
      snapshot: { title: 'Lip Glowy Balm', brand: 'LANEIGE US' },
    });
    expect(laneigeFacts.brand_origin_country).toBe('KR');
    expect(laneigeFacts.brand_home_market).toBe('KR');
    expect(laneigeFacts.local_purchase_markets).toContain('US');
    expect(laneigeFacts.creator_local_reason).toBeNull();
  });

  test('surfaces locality fields on runtime external seed products and recall docs', () => {
    const product = buildExternalSeedProduct({
      id: 'eps_boj_kr_spf',
      market: 'KR',
      domain: 'www.oliveyoung.co.kr',
      external_product_id: 'ext_boj_relief_sun',
      canonical_url: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=B000',
      destination_url: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=B000',
      title: 'Relief Sun Rice + Probiotics SPF50+ PA++++',
      price_amount: 18000,
      price_currency: 'KRW',
      seed_data: {
        brand: 'Beauty of Joseon',
        category: 'Sunscreen',
        snapshot: {
          title: 'Relief Sun Rice + Probiotics SPF50+ PA++++',
          brand: 'Beauty of Joseon',
          category: 'Sunscreen',
          price_amount: 18000,
          price_currency: 'KRW',
        },
      },
    });

    expect(product.locality_facts_v1).toEqual(expect.objectContaining({
      brand_home_market: 'KR',
      local_purchase_markets: expect.arrayContaining(['KR']),
    }));
    expect(product.brand_origin_country).toBe('KR');
    expect(product.brand_origin).toEqual(expect.objectContaining({ country: 'KR', home_market: 'KR' }));
    expect(product.market_availability.local_purchase_markets).toContain('KR');
    expect(product.local_retail_channel).toContain('olive_young');
    expect(product.creator_local_reason).toMatch(/KR home-market/);
    expect(product.external_seed_recall.locality_tokens).toEqual(
      expect.arrayContaining(['brand home market KR', 'local purchase KR']),
    );
  });
});
