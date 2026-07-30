const {
  EXTERNAL_SEED_PRODUCT_KEY_PREFIX,
  externalProductIdFromProductKey,
  normalizeBrandTitleKey,
  truncateToLaneLimit,
  normalizeSeedLaneItem,
  normalizeCatalogLaneItem,
  joinLaneItems,
  diffQueryResults,
  aggregateParityReport,
  parseCorpusLine,
} = require('../../scripts/audit-recall-lane-parity.cjs');

describe('audit-recall-lane-parity identity bridge', () => {
  test('extracts external_product_id from the external_seed catalog product_key', () => {
    expect(
      externalProductIdFromProductKey('prod::external_seed::external_seed::ext_abc123'),
    ).toBe('ext_abc123');
    expect(externalProductIdFromProductKey('prod::shopify::merch_1::123')).toBe('');
    expect(externalProductIdFromProductKey(null)).toBe('');
    expect(EXTERNAL_SEED_PRODUCT_KEY_PREFIX).toBe('prod::external_seed::external_seed::');
  });

  test('joins seed and catalog items via the external_seed product_key bridge', () => {
    const seedItems = [
      normalizeSeedLaneItem({
        external_product_id: 'ext_abc123',
        title: 'Hydra Boost Serum',
        brand: 'GlowLab',
      }),
      normalizeSeedLaneItem({
        external_product_id: 'ext_only_seed',
        title: 'Seed Only Cleanser',
        brand: 'SeedBrand',
      }),
    ];
    const catalogItems = [
      normalizeCatalogLaneItem({
        product_key: 'prod::external_seed::external_seed::ext_abc123',
        product_title: 'Totally Different Display Title',
        brand: 'Different Brand',
      }),
      normalizeCatalogLaneItem({
        product_key: 'prod::shopify::merch_1::sku9',
        product_title: 'Catalog Only Toner',
        brand: 'CatBrand',
      }),
    ];

    const { matches, onlyInSeed, onlyInCatalog } = joinLaneItems(seedItems, catalogItems);
    expect(matches).toHaveLength(1);
    expect(matches[0].join_kind).toBe('ext');
    expect(matches[0].join_key).toBe('ext::ext_abc123');
    expect(matches[0].seed.external_product_id).toBe('ext_abc123');
    expect(matches[0].catalog.product_key).toBe('prod::external_seed::external_seed::ext_abc123');
    expect(onlyInSeed).toHaveLength(1);
    expect(onlyInSeed[0].external_product_id).toBe('ext_only_seed');
    expect(onlyInCatalog).toHaveLength(1);
    expect(onlyInCatalog[0].title).toBe('Catalog Only Toner');
  });

  test('joins seed and catalog items via source_product_id on external_seed platform rows', () => {
    const seedItems = [
      normalizeSeedLaneItem({ external_product_id: 'ext_src_77', title: 'SPF Fluid', brand: 'Sunny' }),
    ];
    const catalogItems = [
      normalizeCatalogLaneItem({
        product_key: 'prod::external_seed::merch_obs_sunny::hash',
        platform: 'external_seed',
        source_product_id: 'ext_src_77',
        product_title: 'SPF Fluid 50+',
        brand: 'Sunny',
      }),
    ];
    const { matches, onlyInSeed, onlyInCatalog } = joinLaneItems(seedItems, catalogItems);
    expect(matches).toHaveLength(1);
    expect(matches[0].join_kind).toBe('ext');
    expect(onlyInSeed).toHaveLength(0);
    expect(onlyInCatalog).toHaveLength(0);
  });

  test('falls back to normalized brand+title join when no id keys line up', () => {
    const seedItems = [
      normalizeSeedLaneItem({
        external_product_id: 'ext_zzz',
        title: '  GLOWLAB   Hydra-Boost SERUM!! ',
        brand: 'GlowLab',
      }),
    ];
    const catalogItems = [
      normalizeCatalogLaneItem({
        product_key: 'prod::shopify::merch_1::42',
        product_title: 'GlowLab Hydra Boost Serum',
        brand: 'glowlab',
      }),
    ];

    expect(normalizeBrandTitleKey('GlowLab', '  GLOWLAB   Hydra-Boost SERUM!! ')).toBe(
      normalizeBrandTitleKey('glowlab', 'GlowLab Hydra Boost Serum'),
    );

    const { matches, onlyInSeed, onlyInCatalog } = joinLaneItems(seedItems, catalogItems);
    expect(matches).toHaveLength(1);
    expect(matches[0].join_kind).toBe('bt');
    expect(onlyInSeed).toHaveLength(0);
    expect(onlyInCatalog).toHaveLength(0);
  });

  test('joins by pivota_signature_id and content_key before brand+title', () => {
    const seedItems = [
      normalizeSeedLaneItem({
        external_product_id: 'ext_a',
        pivota_signature_id: 'sig_123',
        title: 'Name A',
        brand: 'Brand A',
      }),
    ];
    const catalogItems = [
      normalizeCatalogLaneItem({
        product_key: 'prod::shopify::m::1',
        pivota_signature_id: 'sig_123',
        product_title: 'Name B',
        brand: 'Brand B',
      }),
    ];
    const { matches } = joinLaneItems(seedItems, catalogItems);
    expect(matches).toHaveLength(1);
    expect(matches[0].join_kind).toBe('sig');
  });
});

describe('audit-recall-lane-parity per-query diff', () => {
  test('reports counts, overlap, and only-in-lane items', () => {
    const seedItems = [
      normalizeSeedLaneItem({ external_product_id: 'ext_1', title: 'Match One', brand: 'B1' }),
      normalizeSeedLaneItem({ external_product_id: 'ext_2', title: 'Seed Only', brand: 'B2' }),
    ];
    const catalogItems = [
      normalizeCatalogLaneItem({
        product_key: 'prod::external_seed::external_seed::ext_1',
        product_title: 'Match One',
        brand: 'B1',
      }),
    ];
    const diff = diffQueryResults({
      query: 'acne cleanser',
      bucket: 'skincare_cleanser',
      seedItems,
      catalogItems,
      seedLatencyMs: 12.9,
      catalogLatencyMs: 34,
    });
    expect(diff.query).toBe('acne cleanser');
    expect(diff.bucket).toBe('skincare_cleanser');
    expect(diff.seed_count).toBe(2);
    expect(diff.catalog_count).toBe(1);
    expect(diff.overlap_count).toBe(1);
    expect(diff.overlap_at_k).toBe(0.5);
    expect(diff.jaccard).toBe(0.5);
    expect(diff.catalog_gap).toBe(false);
    expect(diff.only_in_seed).toHaveLength(1);
    expect(diff.only_in_seed[0].title).toBe('Seed Only');
    expect(diff.only_in_catalog).toHaveLength(0);
    expect(diff.seed_latency_ms).toBe(12);
    expect(diff.catalog_latency_ms).toBe(34);
  });

  test('truncates the catalog lane to the per-lane limit so overlap@k compares k vs k', () => {
    // fetchCanonicalChainRows returns up to limit*6 flattened chain rows.
    const limit = 3;
    const rawCatalogRows = Array.from({ length: limit * 6 }, (_, i) => ({
      product_key: `prod::external_seed::external_seed::ext_trunc_${i}`,
      product_title: `Chain Row ${i}`,
      brand: 'TruncBrand',
    }));

    const truncated = truncateToLaneLimit(rawCatalogRows, limit);
    expect(truncated).toHaveLength(limit);
    // Keeps the head of the ranked list, in order.
    expect(truncated.map((r) => r.product_title)).toEqual(['Chain Row 0', 'Chain Row 1', 'Chain Row 2']);
    // Degenerate inputs are safe.
    expect(truncateToLaneLimit(null, limit)).toEqual([]);
    expect(truncateToLaneLimit(rawCatalogRows, Number.NaN)).toHaveLength(limit * 6);

    // Seed lane matches only the tail rows -> with truncation those rows are
    // outside the catalog top-k, so overlap@k must be 0 (k vs k), not 1.
    const seedItems = [
      normalizeSeedLaneItem({
        external_product_id: `ext_trunc_${limit * 6 - 1}`,
        title: `Chain Row ${limit * 6 - 1}`,
        brand: 'TruncBrand',
      }),
    ];
    const catalogItems = truncated.map(normalizeCatalogLaneItem).filter(Boolean);
    const diff = diffQueryResults({ query: 'truncation', seedItems, catalogItems });
    expect(diff.catalog_count).toBe(limit);
    expect(diff.overlap_count).toBe(0);
    expect(diff.overlap_at_k).toBe(0);
  });

  test('flags catalog_gap when catalog lane is empty but seed lane is not', () => {
    const diff = diffQueryResults({
      query: 'vanilla perfume',
      seedItems: [normalizeSeedLaneItem({ external_product_id: 'ext_9', title: 'Vanilla Musk', brand: 'F' })],
      catalogItems: [],
    });
    expect(diff.catalog_gap).toBe(true);
    expect(diff.overlap_at_k).toBe(0);
  });
});

describe('audit-recall-lane-parity aggregate gap metric', () => {
  function makeDiff({ query, seedTitles = [], catalogTitles = [], overlap = 0 }) {
    const seedItems = seedTitles.map((title, i) =>
      normalizeSeedLaneItem({ external_product_id: `${query}_s${i}`, title, brand: 'AggBrand' }),
    );
    const catalogItems = catalogTitles.map((title, i) =>
      normalizeCatalogLaneItem({
        product_key:
          i < overlap
            ? `prod::external_seed::external_seed::${query}_s${i}`
            : `prod::shopify::m::${query}_c${i}`,
        product_title: title,
        brand: 'OtherBrand',
      }),
    );
    return diffQueryResults({ query, seedItems, catalogItems, seedLatencyMs: 10, catalogLatencyMs: 20 });
  }

  test('computes catalog-zero-while-seed-positive share and overlap stats', () => {
    const perQuery = [
      // seed positive, catalog empty -> the gap that matters
      makeDiff({ query: 'gap query', seedTitles: ['Seed Hit A', 'Seed Hit B'] }),
      // both lanes agree on 2 of 2
      makeDiff({
        query: 'full overlap',
        seedTitles: ['X', 'Y'],
        catalogTitles: ['cat X', 'cat Y'],
        overlap: 2,
      }),
      // both empty (excluded from gap denominator)
      makeDiff({ query: 'empty query' }),
      // seed positive, catalog positive but disjoint
      makeDiff({ query: 'disjoint', seedTitles: ['Seed Hit A'], catalogTitles: ['Unrelated'] }),
    ];

    const aggregate = aggregateParityReport(perQuery);
    expect(aggregate.queries_total).toBe(4);
    expect(aggregate.queries_seed_positive).toBe(3);
    expect(aggregate.queries_catalog_positive).toBe(2);
    expect(aggregate.queries_both_empty).toBe(1);
    // overlap_at_k values across seed-positive queries: 0, 1, 0
    expect(aggregate.mean_overlap_at_k).toBeCloseTo(1 / 3, 4);
    expect(aggregate.median_overlap_at_k).toBe(0);
    expect(aggregate.catalog_zero_seed_positive_count).toBe(1);
    expect(aggregate.catalog_zero_seed_positive_pct).toBeCloseTo(33.33, 2);
    expect(aggregate.catalog_zero_seed_positive_queries).toEqual(['gap query']);
    expect(aggregate.mean_seed_latency_ms).toBe(10);
    expect(aggregate.mean_catalog_latency_ms).toBe(20);
  });

  test('excludes lane-errored rows from the gap metric and counts them as errors', () => {
    // Catalog lane threw for this query; its empty result is an error
    // artifact, not a recall gap.
    const erroredCatalog = diffQueryResults({
      query: 'errored catalog query',
      seedItems: [
        normalizeSeedLaneItem({ external_product_id: 'ext_err_1', title: 'Seed Hit', brand: 'B' }),
      ],
      catalogItems: [],
      catalogError: 'catalog_lane_error: relation does not exist',
    });
    expect(erroredCatalog.catalog_error).toBe('catalog_lane_error: relation does not exist');
    expect(erroredCatalog.seed_count).toBe(1);
    expect(erroredCatalog.catalog_count).toBe(0);
    expect(erroredCatalog.catalog_gap).toBe(false);

    const erroredSeed = diffQueryResults({
      query: 'errored seed query',
      seedItems: [],
      catalogItems: [],
      seedError: 'seed_lane_error: timeout',
    });
    expect(erroredSeed.seed_error).toBe('seed_lane_error: timeout');
    expect(erroredSeed.catalog_gap).toBe(false);

    const trueGap = makeDiff({ query: 'true gap', seedTitles: ['Seed Only Hit'] });

    const aggregate = aggregateParityReport([erroredCatalog, erroredSeed, trueGap]);
    expect(aggregate.queries_total).toBe(3);
    expect(aggregate.queries_seed_error).toBe(1);
    expect(aggregate.queries_catalog_error).toBe(1);
    // Only the clean gap query counts; the errored catalog row is excluded
    // from both the numerator and the denominator.
    expect(aggregate.catalog_zero_seed_positive_count).toBe(1);
    expect(aggregate.catalog_zero_seed_positive_queries).toEqual(['true gap']);
    expect(aggregate.catalog_zero_seed_positive_pct).toBe(100);
  });

  test('gap pct is null when every seed-positive row errored', () => {
    const erroredCatalog = diffQueryResults({
      query: 'only errored',
      seedItems: [
        normalizeSeedLaneItem({ external_product_id: 'ext_err_2', title: 'Seed Hit', brand: 'B' }),
      ],
      catalogItems: [],
      catalogError: 'catalog_lane_error: boom',
    });
    const aggregate = aggregateParityReport([erroredCatalog]);
    expect(aggregate.queries_catalog_error).toBe(1);
    expect(aggregate.catalog_zero_seed_positive_count).toBe(0);
    expect(aggregate.catalog_zero_seed_positive_pct).toBeNull();
  });

  test('surfaces recurring only-in-seed titles across queries', () => {
    const perQuery = [
      makeDiff({ query: 'q1', seedTitles: ['Seed Hit A', 'Solo Title'] }),
      makeDiff({ query: 'q2', seedTitles: ['Seed Hit A'] }),
    ];
    const aggregate = aggregateParityReport(perQuery);
    expect(aggregate.top_only_in_seed_titles[0]).toMatchObject({
      title: 'Seed Hit A',
      brand: 'AggBrand',
      count: 2,
    });
    expect(aggregate.top_only_in_seed_titles[0].queries).toEqual(
      expect.arrayContaining(['q1', 'q2']),
    );
    const soloEntry = aggregate.top_only_in_seed_titles.find((e) => e.title === 'Solo Title');
    expect(soloEntry.count).toBe(1);
  });
});

describe('audit-recall-lane-parity corpus parsing', () => {
  test('parses eval_corpus_recall_v1 lines and skips junk', () => {
    expect(
      parseCorpusLine(
        '{"query":"acne cleanser","page":1,"limit":12,"lang":"en","bucket":"skincare_cleanser"}',
      ),
    ).toEqual({ query: 'acne cleanser', bucket: 'skincare_cleanser', lang: 'en' });
    expect(parseCorpusLine('')).toBeNull();
    expect(parseCorpusLine('not json')).toBeNull();
    expect(parseCorpusLine('{"page":1}')).toBeNull();
  });
});
