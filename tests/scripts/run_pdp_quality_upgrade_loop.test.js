const {
  CONFIRM_TOKEN,
  buildAuditArgs,
  buildCategoryPatchArgs,
  buildCategoryPatchManifest,
  buildPlanRows,
  buildPublishArgs,
  buildReportArgs,
  buildRelgraphSyncRoutineArgs,
  buildSyncArgs,
  classifyInventoryRow,
  hasOfficialBrandSource,
  inferReviewedCategoryPatch,
  isSafeCategoryPatchCandidate,
  isSafeInsightRewriteCandidate,
  summarizePlan,
} = require('../../scripts/run-pdp-quality-upgrade-loop.cjs');

function baseRow(overrides = {}) {
  return {
    external_product_id: 'ext_safe',
    title: 'Safe Official PDP',
    domain: 'brand.com',
    canonical_url: 'https://brand.com/products/safe-official-pdp',
    destination_url: 'https://brand.com/products/safe-official-pdp',
    seed_missing_fields: '',
    identity_exists: true,
    identity_status: 'approved',
    identity_live_read_enabled: true,
    identity_review_required: false,
    identity_source_tier: 'brand',
    catalog_attached: true,
    index_serving_eligible: true,
    commerce_doc_public: true,
    terminal_hold: false,
    terminal_hold_reason: '',
    db_serving_ready: false,
    kb_exists: false,
    kb_direct_status: 'missing_kb',
    kb_direct_high_quality_ready: false,
    kb_effective_high_quality_ready: false,
    kb_direct_quality_state: 'missing',
    kb_direct_evidence_profile: 'missing',
    kb_direct_issues: 'missing_kb',
    kb_direct_blocking_issues: 'missing_kb',
    main_blocker: 'kb_missing',
    recommended_lane: 'lane_3_kb_rewrite_review',
    ...overrides,
  };
}

describe('run-pdp-quality-upgrade-loop decision layer', () => {
  test('exposes the write confirmation token intentionally', () => {
    expect(CONFIRM_TOKEN).toBe('RUN_PDP_QUALITY_UPGRADE_LOOP_V1');
  });

  test('selects a safe official-source missing-KB PDP for automatic insight rewrite', () => {
    const row = baseRow();
    expect(hasOfficialBrandSource(row)).toBe(true);
    expect(isSafeInsightRewriteCandidate(row)).toBe(true);
    expect(classifyInventoryRow(row)).toMatchObject({
      action: 'insight_rewrite',
      lane: 'lane_3_kb_rewrite_review',
      auto_apply: true,
    });
  });

  test('holds terminal source failures even when Product Intel is missing', () => {
    expect(
      classifyInventoryRow(
        baseRow({
          terminal_hold: true,
          terminal_hold_reason: 'official_pdp_404',
        }),
      ),
    ).toMatchObject({
      action: 'hold',
      lane: 'terminal_hold',
      reason: 'official_pdp_404',
      auto_apply: false,
    });
  });

  test('holds identity review-required rows instead of auto-approving live read', () => {
    expect(
      classifyInventoryRow(
        baseRow({
          identity_status: 'review_required',
          identity_live_read_enabled: false,
          identity_review_required: true,
        }),
      ),
    ).toMatchObject({
      action: 'hold',
      lane: 'identity_index_review',
      reason: 'identity_review_required',
    });
  });

  test('holds seed commerce gaps before insight publishing', () => {
    expect(
      classifyInventoryRow(
        baseRow({
          seed_missing_fields: 'price|currency',
        }),
      ),
    ).toMatchObject({
      action: 'hold',
      lane: 'seed_commerce_or_content_gap',
      reason: 'seed_missing_fields:price|currency',
    });
  });

  test('selects high-confidence official nail category gaps for reviewed category patching', () => {
    const row = baseRow({
      external_product_id: 'ext_java',
      title: 'Java - Breathable Nail Polish',
      domain: '786cosmetics.com',
      canonical_url: 'https://786cosmetics.com/products/java-breathable-nail-polish',
      destination_url: 'https://786cosmetics.com/products/java-breathable-nail-polish',
      seed_missing_fields: 'category',
      main_blocker: 'seed_content_blocked',
      recommended_lane: 'lane_2_seed_commerce_facts',
      kb_direct_status: 'displayable',
      kb_direct_quality_state: 'reviewed',
      kb_direct_evidence_profile: 'official_pdp_reviewed_formula_and_usage',
      kb_direct_issues: '',
      kb_direct_blocking_issues: '',
    });

    expect(isSafeCategoryPatchCandidate(row)).toBe(true);
    expect(inferReviewedCategoryPatch(row)).toMatchObject({
      category: 'Nail Polish',
      product_type: 'Nail Polish',
      category_path: 'beauty/makeup/nails/nail-polish',
      confidence: 0.92,
    });
    expect(classifyInventoryRow(row)).toMatchObject({
      action: 'category_patch',
      lane: 'lane_2_seed_commerce_facts',
      reason: 'seed_missing_fields:category',
      auto_apply: true,
    });
  });

  test('selects nail set, hand set, remover, and cuticle oil category patches only from clear titles', () => {
    expect(
      inferReviewedCategoryPatch(
        baseRow({
          title: 'Nail Polish Set 4 Piece (Choose Your Colors)',
          seed_missing_fields: 'category',
        }),
      ),
    ).toMatchObject({
      category: 'Nail Polish Set',
      category_path: 'beauty/makeup/nails/nail-polish-set',
    });
    expect(
      inferReviewedCategoryPatch(
        baseRow({
          title: 'Hand Care Ritual Set - Organic Nail & Cuticle Oil + Exfoliating Hand Scrub',
          seed_missing_fields: 'category',
        }),
      ),
    ).toMatchObject({
      category: 'Hand Care Set',
      category_path: 'beauty/body/hand-care',
    });
    expect(
      inferReviewedCategoryPatch(
        baseRow({
          title: 'Soy Nail Polish Remover With Jojoba Seed & Tea Tree Oil',
          seed_missing_fields: 'category',
        }),
      ),
    ).toMatchObject({
      category: 'Nail Polish Remover',
      category_path: 'beauty/makeup/nails/nail-polish-remover',
    });
    expect(
      inferReviewedCategoryPatch(
        baseRow({
          title: 'Almond & Ginseng Cuticle Oil',
          seed_missing_fields: 'category',
        }),
      ),
    ).toMatchObject({
      category: 'Cuticle Oil',
      category_path: 'beauty/makeup/nails/cuticle-oil',
    });
    expect(
      inferReviewedCategoryPatch(
        baseRow({
          title: 'Ambiguous Beauty Favorite',
          seed_missing_fields: 'category',
        }),
      ),
    ).toBeNull();
  });

  test('holds promo or commerce-copy insight issues', () => {
    const row = baseRow({
      main_blocker: 'kb_displayable_limited',
      kb_direct_status: 'displayable',
      kb_direct_quality_state: 'reviewed',
      kb_direct_evidence_profile: 'seller_plus_reviews',
      kb_direct_issues: 'public_promo_availability_copy',
      kb_direct_blocking_issues: 'public_promo_availability_copy',
    });
    expect(isSafeInsightRewriteCandidate(row)).toBe(false);
    expect(classifyInventoryRow(row)).toMatchObject({
      action: 'hold',
      lane: 'insight_content_review',
      reason: 'public_promo_availability_copy',
    });
  });

  test('keeps already serving high-quality PDPs', () => {
    expect(
      classifyInventoryRow(
        baseRow({
          db_serving_ready: true,
          kb_effective_high_quality_ready: true,
          kb_direct_high_quality_ready: true,
          main_blocker: 'db_serving_ready',
          recommended_lane: 'ready_no_action',
        }),
      ),
    ).toMatchObject({
      action: 'keep',
      lane: 'ready_no_action',
      reason: 'db_serving_ready_high_quality',
    });
  });

  test('builds plan rows and summaries for operator review', () => {
    const rows = [
      baseRow({ external_product_id: 'ext_rewrite' }),
      baseRow({ external_product_id: 'ext_hold', terminal_hold: true, terminal_hold_reason: 'official_pdp_404' }),
    ];
    const planRows = buildPlanRows(rows);
    expect(planRows.map((row) => row.action)).toEqual(['insight_rewrite', 'hold']);
    expect(summarizePlan(planRows)).toMatchObject({
      scanned: 2,
      by_action: { insight_rewrite: 1, hold: 1 },
      auto_apply_count: 1,
    });
  });

  test('builds child script argument lists without shell composition', () => {
    const options = {
      market: 'US',
      limit: 10,
      pageSize: 5,
      sampleLimit: 3,
      domain: 'brand.com',
      externalProductIds: ['ext_a', 'ext_b'],
      resume: true,
      force: true,
      batchSize: 7,
      reviewer: 'codex_test',
      includeMissingOfficialSource: true,
      includeReviewedSellerOnly: true,
      includeNotReviewedOfficialSource: false,
    };
    expect(buildAuditArgs(options, '/tmp/audit')).toEqual([
      '--market',
      'US',
      '--limit',
      '10',
      '--page-size',
      '5',
      '--sample-limit',
      '3',
      '--out-dir',
      '/tmp/audit',
      '--domain',
      'brand.com',
      '--external-product-ids',
      'ext_a,ext_b',
      '--resume',
      '--force',
    ]);
    expect(buildReportArgs(options, '/tmp/inventory.json', '/tmp/report.json', 'batch')).toContain(
      '--include-missing-official-source',
    );
    expect(
      buildCategoryPatchManifest(
        [
          baseRow({
            external_product_id: 'ext_java',
            title: 'Java - Breathable Nail Polish',
            seed_missing_fields: 'category',
          }),
        ],
        { market: 'US', reviewer: 'codex_test' },
      ).entries[0],
    ).toMatchObject({
      external_product_id: 'ext_java',
      category: 'Nail Polish',
      reviewed_by: 'codex_test',
    });
    expect(buildCategoryPatchArgs('/tmp/manifest.json', '/tmp/category.json', options, { write: true })).toEqual([
      '--manifest',
      '/tmp/manifest.json',
      '--market',
      'US',
      '--out',
      '/tmp/category.json',
      '--write',
      '--confirm',
      'APPLY_REVIEWED_EXTERNAL_SEED_CATEGORY_PATCH',
    ]);
    expect(buildPublishArgs('/tmp/report.json', '/tmp/publish.json', { write: false })).toContain(
      '--validate-replacements',
    );
    expect(buildPublishArgs('/tmp/report.json', '/tmp/publish.json', { write: true })).toContain('--write');
    expect(buildSyncArgs(['ext_a'], '/tmp/sync.json')).toEqual([
      '--apply',
      '--confirm',
      'SYNC_REVIEWED_EXTERNAL_SEEDS_TO_CATALOG',
      '--external-product-ids',
      'ext_a',
      '--upsert-serving-state',
      '--bootstrap-reviewed-identity-live-read',
      '--out',
      '/tmp/sync.json',
    ]);
    expect(buildSyncArgs(['ext_a'], '/tmp/sync.json', { affectedProductsOut: '/tmp/affected.json' })).toEqual([
      '--apply',
      '--confirm',
      'SYNC_REVIEWED_EXTERNAL_SEEDS_TO_CATALOG',
      '--external-product-ids',
      'ext_a',
      '--upsert-serving-state',
      '--bootstrap-reviewed-identity-live-read',
      '--out',
      '/tmp/sync.json',
      '--affected-products-out',
      '/tmp/affected.json',
    ]);
    expect(buildRelgraphSyncRoutineArgs('/tmp/affected.json', '/tmp/relgraph', {
      market: 'US',
      relgraphCutoff: '2026-06-08T00:00:00Z',
      relgraphSkipReview: false,
      relgraphApplyBuild: true,
      relgraphApplyReview: false,
      relgraphLimit: 200,
      relgraphReviewLimit: 250,
    })).toEqual([
      '--market',
      'US',
      '--affected-products-file',
      '/tmp/affected.json',
      '--out-dir',
      '/tmp/relgraph',
      '--limit',
      '200',
      '--review-limit',
      '250',
      '--cutoff',
      '2026-06-08T00:00:00Z',
      '--apply-build',
      '--confirm',
      'APPLY_RELGRAPH_SYNC_ROUTINE',
    ]);
  });
});
