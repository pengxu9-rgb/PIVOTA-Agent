const {
  buildHighlightRepairReport,
  buildHighlightRepairRow,
  buildTitleBasedHighlight,
  hasSingleItemTitleMultiItemBodyMismatch,
  normalizeHighlightCandidate,
} = require('../../scripts/build_protected_insight_highlight_repair_report');

function seedRow(overrides = {}) {
  return {
    external_product_id: 'ext_pixi_repair_case',
    title: 'Retinol Tonic Travel Size',
    canonical_url: 'https://pixibeauty.com/products/retinol-tonic',
    ...overrides,
  };
}

function protectedBundle(overrides = {}) {
  const qualityState = overrides.quality_state || 'eligible';
  const evidenceProfile = overrides.evidence_profile || 'community_supported';
  return {
    contract_version: 'pivota.product_intel.v1',
    canonical_product_ref: {
      merchant_id: 'external_seed',
      product_id: 'ext_pixi_repair_case',
    },
    product_intel_core: {
      quality_state: qualityState,
      evidence_profile: evidenceProfile,
      what_it_is: {
        headline: 'Retinol tonic',
        body: 'A Pixi toner step centered on retinol and routine use after cleansing.',
      },
      why_it_stands_out: [
        {
          headline: 'Retinol toner step',
          body: 'Keeps the routine focused on a toner step rather than a moisturizer or cleanser.',
        },
      ],
      best_for: [{ label: 'Toner routine', tag: 'toner' }],
      watchouts: [],
    },
    shopping_card: {
      title: 'Retinol Tonic Travel Size',
      subtitle: 'Retinol Tonic',
    },
    search_card: {
      title_candidate: 'Retinol Tonic Travel Size',
      compact_candidate: 'Retinol Tonic',
    },
    quality_state: qualityState,
    evidence_profile: evidenceProfile,
    provenance: {
      review_status: 'completed',
      review_decision: 'rewrite',
      reviewer: 'Human QA',
      reviewer_kind: 'human',
      review_tier: 'strict_human',
    },
    ...overrides,
  };
}

function kbRow(bundle = protectedBundle()) {
  return {
    kb_key: 'product:ext_pixi_repair_case',
    source: 'aurora_product_intel_kb',
    source_meta: {},
    analysis: {
      product_intel_v1: bundle,
    },
  };
}

describe('protected insight highlight repair report', () => {
  test('derives compact title-based highlights without commerce truth', () => {
    expect(buildTitleBasedHighlight('Retinol Tonic Travel Size')).toBe('Retinol toner step');
    expect(buildTitleBasedHighlight('+C Vit Priming Oil')).toBe('Vitamin C priming oil');
    expect(normalizeHighlightCandidate('Save 20% with this kit')).toBe('');
    expect(normalizeHighlightCandidate('5% glycolic acid toner')).toBe('5% glycolic acid toner');
  });

  test('builds an owner-delegated highlight-only replacement without changing core content', () => {
    const existing = protectedBundle();
    const row = buildHighlightRepairRow(seedRow(), kbRow(existing), {
      reviewer: 'codex_quality_reviewer',
      reviewedAt: '2026-05-23T16:30:00.000Z',
    });

    expect(row.skipped).toBeUndefined();
    expect(row.case_id).toBe('ext_pixi_repair_case');
    expect(row.reviewer_kind).toBe('assistant');
    expect(row.quality_improvement_review).toMatchObject({
      decision: 'approved_replacement',
      reviewer_kind: 'assistant',
      owner_delegated: true,
    });
    expect(row.selected.selected_mode).toBe('highlight_only_repair');
    expect(row.selected.bundle.product_intel_core.what_it_is).toEqual(
      existing.product_intel_core.what_it_is,
    );
    expect(row.selected.bundle.evidence_profile).toBe('community_supported');
    expect(row.selected.bundle.shopping_card.highlight).toBe('Retinol toner step');
    expect(row.selected.bundle.search_card.highlight_candidate).toBe('Retinol toner step');
    expect(row.selected.bundle.card_highlight).toBe('Retinol toner step');
    expect(row.review_packet.previous_blocking_issues).toEqual(['missing_card_highlight']);
  });

  test('skips protected rows when missing highlight is not the only blocker', () => {
    const weak = protectedBundle({
      product_intel_core: {
        quality_state: 'eligible',
        evidence_profile: 'community_supported',
        what_it_is: {
          headline: 'Hydrating mist',
          body: 'This product centers its story around routine context and product data.',
        },
        why_it_stands_out: [
          {
            headline: 'Routine context',
            body: 'The formula story positions itself through merchant data.',
          },
        ],
        best_for: [{ label: 'Daily use', tag: 'daily' }],
        watchouts: [],
      },
    });

    const row = buildHighlightRepairRow(seedRow({ title: 'Mini Hydrating Milky Mist' }), kbRow(weak), {
      reviewedAt: '2026-05-23T16:30:00.000Z',
    });

    expect(row.skipped).toBe(true);
    expect(row.reason).toBe('non_highlight_blockers:missing_card_highlight|generic_copy_signal');
  });

  test('skips single-item titles whose existing body looks like a multi-item kit', () => {
    const mismatched = protectedBundle({
      product_intel_core: {
        quality_state: 'eligible',
        evidence_profile: 'community_supported',
        what_it_is: {
          headline: 'Prep or toner step',
          body: 'Hydrating Milky Cleanser 15ml - Rich cleanser. Milky Tonic 40ml - Hydrating tonic. Hydrating Milky Lotion 15ml - Moisture lotion.',
        },
        why_it_stands_out: [
          {
            headline: 'Milky toner step',
            body: 'Keeps the routine focused on toner use.',
          },
        ],
        best_for: [{ label: 'Toner routine', tag: 'toner' }],
        watchouts: [],
      },
    });

    expect(
      hasSingleItemTitleMultiItemBodyMismatch({
        seedRow: seedRow({ title: 'Milky Tonic Mini Size' }),
        bundle: mismatched,
      }),
    ).toBe(true);

    const row = buildHighlightRepairRow(seedRow({ title: 'Milky Tonic Mini Size' }), kbRow(mismatched), {
      reviewedAt: '2026-05-23T16:30:00.000Z',
    });

    expect(row.skipped).toBe(true);
    expect(row.reason).toBe('single_item_title_with_multi_item_bundle_body');
  });

  test('report separates selected rows from skipped rows', () => {
    const report = buildHighlightRepairReport(
      [
        seedRow(),
        seedRow({
          external_product_id: 'ext_missing_kb',
          title: 'Rose Tonic Travel Size',
        }),
      ],
      [kbRow()],
      {
        limit: 10,
        reviewedAt: '2026-05-23T16:30:00.000Z',
      },
    );

    expect(report.rows).toHaveLength(1);
    expect(report.skipped_rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          case_id: 'ext_missing_kb',
          reason: 'missing_kb_row',
        }),
      ]),
    );
  });
});
