const {
  BAD_QA_PATTERNS,
  buildBlockingReasons,
  buildCoverageTable,
  buildMergeBoardFromConsolidation,
  buildDomainMappings,
  chooseQualityBucket,
  computeGalleryHealth,
  determineMergeBucket,
  KNOWN_MERGE_TRACKS,
  mapRowToBaseline,
  parseCsv,
} = require('../../scripts/build_kbeauty_master_inventory');

describe('build_kbeauty_master_inventory', () => {
  test('parses baseline CSV rows with quoted fields', () => {
    const rows = parseCsv([
      'brand_name,official_site,notes',
      '"Beauty of Joseon",https://beautyofjoseon.com,"official, us-ready"',
    ].join('\n'));
    expect(rows).toEqual([
      {
        brand_name: 'Beauty of Joseon',
        official_site: 'https://beautyofjoseon.com',
        notes: 'official, us-ready',
      },
    ]);
  });

  test('maps strict and shadow coverage by host', () => {
    const mappings = buildDomainMappings(
      [
        { brand_name: 'Torriden', official_site: 'https://torriden.com' },
        { brand_name: 'Beauty of Joseon', official_site: 'https://beautyofjoseon.com' },
      ],
      [{ channel_name: 'Ohlolly', website: 'https://ohlolly.com' }],
    );

    expect(
      mapRowToBaseline(
        { domain: 'beautyofjoseon.com', seed_data: {}, external_product_id: 'ext_a' },
        mappings,
      ),
    ).toEqual(
      expect.objectContaining({
        baseline_type: 'dtc',
        brand_or_channel: 'Beauty of Joseon',
        coverage_status: 'strict_covered',
      }),
    );

    expect(
      mapRowToBaseline(
        { domain: 'torriden.us', seed_data: {}, external_product_id: 'ext_b' },
        mappings,
      ),
    ).toEqual(
      expect.objectContaining({
        baseline_type: 'dtc',
        brand_or_channel: 'Torriden',
        coverage_status: 'shadow_covered',
      }),
    );

    expect(
      mapRowToBaseline(
        {
          domain: 'ohlolly.com',
          seed_data: { brand: 'Beauty of Joseon' },
          external_product_id: 'ext_c',
        },
        mappings,
      ),
    ).toEqual(
      expect.objectContaining({
        baseline_type: 'channel',
        brand_or_channel: 'Ohlolly',
        channel_label: 'Ohlolly',
      }),
    );
  });

  test('flags gallery bloat and bad qa blockers conservatively', () => {
    const gallery = computeGalleryHealth({
      image_url: 'https://cdn.shopify.com/a/product_400x.jpg',
      seed_data: {
        image_urls: Array.from({ length: 14 }, (_, idx) =>
          `https://cdn.shopify.com/a/product_${idx % 2 ? '800x' : '400x'}.jpg?v=${idx}`,
        ),
        snapshot: {},
      },
    });
    expect(gallery.gallery_bloat).toBe(true);

    const blockingReasons = buildBlockingReasons(
      {},
      {
        currency_mismatch: true,
        variant: { displayable: false },
        review: { review_count: 0 },
        coverage: { how_to_chars: 0, inci_chars: 0 },
        product_intel: { displayable: false, reviewed: false },
        bad_qa: BAD_QA_PATTERNS.some((pattern) => pattern.test('Are you sure you want to quit?')),
        gallery,
        identity: { product_line_id: null },
      },
    );
    expect(blockingReasons).toEqual(
      expect.arrayContaining([
        'currency_mismatch',
        'missing_variant',
        'missing_reviews',
        'missing_how_to',
        'missing_ingredients',
        'missing_insights',
        'bad_qa',
        'gallery_bloat',
        'identity_missing',
      ]),
    );
  });

  test('classifies merge bucket from known merge tracks', () => {
    const mergedPairs = new Set(
      KNOWN_MERGE_TRACKS.merged_live_verified_pairs.map((row) => `${row.brand.toLowerCase()}::${row.channel.toLowerCase()}`),
    );
    const blockedByProductId = new Map(
      KNOWN_MERGE_TRACKS.blocked_public_live_rows.map((row) => [row.channel_external_product_id, row]),
    );
    const blockedOfficialByProductId = new Map(
      KNOWN_MERGE_TRACKS.blocked_public_live_rows.map((row) => [row.official_anchor_external_product_id, row]),
    );
    const holdPairs = new Map(
      KNOWN_MERGE_TRACKS.hold_pairs.map((row) => [`${row.brand.toLowerCase()}::${row.channel.toLowerCase()}`, row.merge_bucket]),
    );
    const mergeContext = { mergedPairs, blockedByProductId, blockedOfficialByProductId, holdPairs };

    expect(
      determineMergeBucket(
        {
          external_product_id: 'ext_f6e9cfc1ee91df23073c40d5',
          identity: { product_line_id: 'pl_1' },
        },
        { seed_type: 'channel', brand_label: 'COSRX', channel_label: 'Soko Glam' },
        mergeContext,
        new Map(),
      ),
    ).toBe('db_identity_ready_public_live_blocked');

    expect(
      determineMergeBucket(
        {
          external_product_id: 'ext_x',
          identity: { product_line_id: 'pl_2' },
        },
        { seed_type: 'channel', brand_label: 'Beauty of Joseon', channel_label: 'Ohlolly' },
        mergeContext,
        new Map(),
      ),
    ).toBe('merged_live_verified');

    expect(
      chooseQualityBucket(['missing_reviews', 'missing_how_to'], {
        coverage: { details_sections_count: 1, how_to_chars: 0, inci_chars: 100 },
        review: { review_count: 0 },
        product_intel: { displayable: true, reviewed: true },
      }).pdp_quality_bucket,
    ).toBe('thin');
  });

  test('builds coverage rows from shadow audit baseline', () => {
    const out = buildCoverageTable(
      [
        {
          brand_name: 'COSRX',
          priority_tier: 'P0',
          transaction_ready: 'yes',
          validation_status: 'validated_search_result',
        },
        {
          brand_name: 'Torriden',
          priority_tier: 'P1',
          transaction_ready: 'conditional',
          validation_status: 'needs_codex_http_check',
        },
      ],
      [
        {
          channel_name: 'Soko Glam',
          priority_tier: 'P0',
          transaction_ready: 'yes',
          validation_status: 'validated_search_result',
        },
      ],
      [],
      {
        dtc: {
          rows: [
            {
              brand_name: 'COSRX',
              covered: true,
              shadow_covered: false,
              active_seed_count: 101,
              shadow_active_seed_count: 0,
              markets: ['US'],
              shadow_markets: [],
              sample_external_product_ids: ['ext_a'],
              shadow_sample_external_product_ids: [],
            },
            {
              brand_name: 'Torriden',
              covered: false,
              shadow_covered: true,
              active_seed_count: 0,
              shadow_active_seed_count: 35,
              markets: [],
              shadow_markets: ['US'],
              sample_external_product_ids: [],
              shadow_sample_external_product_ids: ['ext_shadow'],
            },
          ],
        },
        channels: {
          rows: [
            {
              channel_name: 'Soko Glam',
              covered: true,
              active_seed_count: 15,
              markets: ['US'],
              sample_external_product_ids: ['ext_channel'],
            },
          ],
        },
      },
    );

    expect(out).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          brand_or_channel: 'COSRX',
          coverage_status: 'strict_covered',
          active_seed_count: 101,
          official_host_status: 'strict',
        }),
        expect.objectContaining({
          brand_or_channel: 'Torriden',
          coverage_status: 'shadow_covered',
          active_seed_count: 35,
          official_host_status: 'shadow',
        }),
        expect.objectContaining({
          brand_or_channel: 'Soko Glam',
          coverage_status: 'strict_covered',
          active_seed_count: 15,
          official_host_status: 'strict',
        }),
      ]),
    );
  });

  test('builds merge remediation board from consolidation report shape', () => {
    const board = buildMergeBoardFromConsolidation({
      merge_tracks: {
        merged_live_verified: [{ brand: 'Beauty of Joseon', channel: 'Ohlolly' }],
        merge_safe_blocked_public_live: {
          brand: 'COSRX',
          channel: 'Soko Glam',
          rows: [
            {
              channel_external_product_id: 'ext_cosrx_channel',
              official_anchor_external_product_id: 'ext_cosrx_official',
              channel_title: 'Advanced Snail 96 Mucin Power Essence',
              db_product_line_id: 'pl_1',
              db_sellable_item_group_id: 'sig_1',
              merge_status: 'db_identity_ready_public_live_blocked',
            },
            {
              channel_external_product_id: 'ext_missing_anchor',
              official_anchor_external_product_id: 'ext_missing_anchor_official',
              channel_title: 'The Vitamin C 13 Serum',
              db_product_line_id: null,
              db_sellable_item_group_id: null,
              merge_status: 'official_anchor_identity_missing_in_db',
            },
          ],
        },
        anchor_missing_or_not_exact_hold: [
          { brand: 'Klairs', channel: 'Wishtrend', status: 'official_anchor_missing' },
          { brand: 'Anua', channel: 'Blooming Koco', status: 'probable_same_product_hold' },
        ],
      },
    });

    expect(board).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          brand: 'Beauty of Joseon',
          channel: 'Ohlolly',
          merge_bucket: 'merged_live_verified',
          merge_safe: true,
        }),
        expect.objectContaining({
          brand: 'COSRX',
          channel: 'Soko Glam',
          channel_external_product_id: 'ext_cosrx_channel',
          merge_bucket: 'db_identity_ready_public_live_blocked',
          ready_for_override: true,
        }),
        expect.objectContaining({
          channel_external_product_id: 'ext_missing_anchor',
          merge_bucket: 'anchor_missing',
          next_action: 'official_anchor_identity_lift',
        }),
        expect.objectContaining({
          brand: 'Klairs',
          channel: 'Wishtrend',
          merge_bucket: 'anchor_missing',
        }),
        expect.objectContaining({
          brand: 'Anua',
          channel: 'Blooming Koco',
          merge_bucket: 'no_verified_merge_path',
        }),
      ]),
    );
  });
});
