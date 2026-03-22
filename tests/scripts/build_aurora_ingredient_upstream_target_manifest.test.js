const { _internals } = require('../../scripts/build_aurora_ingredient_upstream_target_manifest.cjs');

describe('build_aurora_ingredient_upstream_target_manifest', () => {
  test('parseArgs accepts extract audit input', () => {
    expect(_internals.parseArgs([
      '--input', 'backlog.json',
      '--extract-audit', 'audit.json',
      '--out', 'manifest.json',
    ])).toMatchObject({
      inputPath: 'backlog.json',
      extractAuditPath: 'audit.json',
      outPath: 'manifest.json',
    });
  });

  test('annotates official targets with extract audit safety and blocked notes', () => {
    const extractAuditIndex = _internals.indexExtractAuditRows({
      rows: [
        {
          ingredient_id: 'tranexamic_acid',
          url: 'https://www.goodmolecules.com/products/discoloration-correcting-serum',
          safe_to_backfill: false,
          http_status: 200,
          product_count: 0,
          first_title: null,
          representative_url: null,
          discovery_strategy: 'seed_page',
          failure_category: 'no_product_urls',
          diagnostics: { block_provider: 'perimeterx' },
        },
      ],
    });

    const item = _internals.buildManifestItem(
      {
        ingredient_id: 'tranexamic_acid',
        ingredient_name: 'Tranexamic acid',
        query: 'tranexamic acid serum',
        root_cause_bucket: 'only_family_supply_present',
        remediation_lane: 'refresh_existing_seed_supply',
        seed_creation_required: false,
        recommended_action: 'review_candidate_hints_and_rebuild_explicit_supply',
        source_statuses: { kb_attached_seed: 'filtered_after_admission' },
        candidate_hints: [],
      },
      extractAuditIndex,
    );

    expect(item.official_targets).toHaveLength(1);
    expect(item.official_targets[0].extract_spot_check_result).toMatchObject({
      safe_to_backfill: false,
      failure_category: 'no_product_urls',
      block_provider: 'perimeterx',
    });
    expect(item.pipeline_notes.join(' ')).toMatch(/manual-upstream/i);
  });

  test('keeps safe target extract summaries on official targets', () => {
    const extractAuditIndex = _internals.indexExtractAuditRows({
      rows: [
        {
          ingredient_id: 'squalane',
          url: 'https://theordinary.com/en-us/100-plant-derived-squalane-face-oil-100398.html',
          safe_to_backfill: true,
          http_status: 200,
          product_count: 1,
          first_title: '100% Plant-Derived Squalane',
          representative_url: 'https://theordinary.com/en-us/100-plant-derived-squalane-face-oil-100398.html',
          discovery_strategy: 'seed_page',
          failure_category: null,
          diagnostics: { block_provider: null },
        },
      ],
    });

    const item = _internals.buildManifestItem(
      {
        ingredient_id: 'squalane',
        ingredient_name: 'Squalane',
        query: 'squalane oil',
        root_cause_bucket: 'only_family_supply_present',
        remediation_lane: 'refresh_existing_seed_supply',
        seed_creation_required: false,
        recommended_action: 'review_candidate_hints_and_rebuild_explicit_supply',
        source_statuses: { kb_attached_seed: 'filtered_after_admission' },
        candidate_hints: [],
      },
      extractAuditIndex,
    );

    expect(item.official_targets[0].extract_spot_check_result).toMatchObject({
      safe_to_backfill: true,
      first_title: '100% Plant-Derived Squalane',
      discovery_strategy: 'seed_page',
    });
    expect(item.pipeline_notes.join(' ')).toMatch(/dry-run backfill/i);
  });
});
