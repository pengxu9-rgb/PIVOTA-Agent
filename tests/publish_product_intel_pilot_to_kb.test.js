const {
  assertProductIntelKbWritable,
  buildKbEntriesForRow,
  prepareEntriesForWrite,
} = require('../scripts/publish_product_intel_pilot_to_kb');

describe('publish_product_intel_pilot_to_kb', () => {
  test('builds product-key KB entries from selected bundles', () => {
    const row = {
      case_id: 'pilot_fenty_instant_reset',
      review_status: 'completed',
      review_decision: 'rewrite',
      reviewer: 'Human QA',
      selected: {
        selected_mode: 'hybrid_gemini',
        selected_field_count: 6,
        field_sources: {
          what_it_is: 'gemini',
        },
        bundle: {
          contract_version: 'pivota.product_intel.v1',
          canonical_product_ref: {
            merchant_id: 'pilot_fenty',
            product_id: 'pilot_fenty_instant_reset',
          },
          product_intel_core: {
            what_it_is: {
              headline: 'Overnight gel-cream moisturizer',
              body: 'An overnight gel-cream moisturizer designed to hydrate and support the skin barrier while you sleep.',
            },
          },
          quality_state: 'limited',
          evidence_profile: 'seller_plus_formula',
          provenance: {
            external_highlight_review_status: 'rewrite',
            external_evidence_generated_at: '2026-04-10T12:00:00.000Z',
            external_evidence_model: 'external_highlight_pipeline_v1',
            external_review_batch: 'batch_demo',
          },
        },
      },
    };

    const entries = buildKbEntriesForRow(row);

    expect(entries).toHaveLength(1);
    expect(entries[0].kb_key).toBe('product:pilot_fenty_instant_reset');
    expect(entries[0].analysis.product_intel_v1.contract_version).toBe('pivota.product_intel.v1');
    expect(entries[0].analysis.product_intel_v1.quality_state).toBe('reviewed');
    expect(entries[0].analysis.product_intel_v1.product_intel_core.quality_state).toBe('reviewed');
    expect(entries[0].analysis.product_intel_v1.provenance.pre_review_quality_state).toBe('limited');
    expect(entries[0].source).toBe('pivota_product_intel_pilot_selected');
    expect(entries[0].source_meta.selected_mode).toBe('hybrid_gemini');
    expect(entries[0].source_meta.quality_state).toBe('reviewed');
    expect(entries[0].source_meta.pre_review_quality_state).toBe('limited');
    expect(entries[0].source_meta.external_highlight_review_status).toBe('rewrite');
    expect(entries[0].source_meta.external_review_batch).toBe('batch_demo');
    expect(entries[0].source_meta.review_status).toBe('completed');
    expect(entries[0].source_meta.review_decision).toBe('rewrite');
    expect(entries[0].source_meta.reviewer).toBe('Human QA');
    expect(entries[0].source_meta.review_tier).toBe('strict_human');
    expect(entries[0].analysis.product_intel_v1.agent_context.contract_version).toBe(
      'pivota.agent_product_context.v1',
    );
    expect(
      entries[0].analysis.product_intel_v1.agent_context.guardrails.no_price_or_availability_claims,
    ).toBe(true);
  });

  test('skips rows that have not passed review', () => {
    const entries = buildKbEntriesForRow({
      case_id: 'pilot_pending_case',
      review_status: 'pending',
      review_decision: 'pending',
      selected: {
        bundle: {
          canonical_product_ref: {
            merchant_id: 'pilot_brand',
            product_id: 'pilot_pending_case',
          },
        },
      },
    });

    expect(entries).toEqual([]);
  });

  test('skips strict baseline_only selected rows', () => {
    const entries = buildKbEntriesForRow({
      case_id: 'pilot_baseline_only_case',
      review_status: 'completed',
      review_decision: 'pass',
      selected: {
        selected_mode: 'baseline_only',
        bundle: {
          canonical_product_ref: {
            merchant_id: 'pilot_baseline',
            product_id: 'pilot_baseline_only_case',
          },
          product_intel_core: {
            what_it_is: {
              headline: 'Baseline item',
              body: 'Used for testing strict publish checks.',
            },
          },
        },
      },
    });

    expect(entries).toEqual([]);
  });

  test('fails fast when the KB write preflight query fails', async () => {
    await expect(
      assertProductIntelKbWritable(async () => {
        const err = new Error('DATABASE_URL not configured or pg driver unavailable');
        err.code = 'NO_DATABASE';
        throw err;
      }),
    ).rejects.toMatchObject({
      code: 'NO_DATABASE',
    });
  });

  test('write preparation blocks protected existing bundles without explicit replacement review', () => {
    const row = reviewedPublishRow();
    const entries = buildKbEntriesForRow(row);
    const existingByKey = new Map([
      [
        'product:pilot_fenty_instant_reset',
        {
          kb_key: 'product:pilot_fenty_instant_reset',
          analysis: {
            product_intel_v1: reviewedBundle({
              quality_state: 'verified',
              evidence_profile: 'community_supported',
            }),
          },
          source: 'aurora_product_intel_kb',
          source_meta: {},
        },
      ],
    ]);

    const result = prepareEntriesForWrite(entries, [row], existingByKey);

    expect(result.preparedEntries).toEqual([]);
    expect(result.blockedEntries).toHaveLength(1);
    expect(result.blockedEntries[0].reason).toBe(
      'protected_existing_bundle_requires_explicit_human_replacement_review',
    );
  });

  test('write preparation allows explicit human replacement review and records quality delta', () => {
    const row = {
      ...reviewedPublishRow(),
      quality_improvement_review: {
        decision: 'approved_replacement',
        reviewer_kind: 'human',
        reason: 'Manual review confirms fresher official PDP evidence and no field loss.',
      },
    };
    const entries = buildKbEntriesForRow(row);
    const existingByKey = new Map([
      [
        'product:pilot_fenty_instant_reset',
        {
          kb_key: 'product:pilot_fenty_instant_reset',
          analysis: {
            product_intel_v1: reviewedBundle({
              quality_state: 'verified',
              evidence_profile: 'community_supported',
            }),
          },
          source: 'aurora_product_intel_kb',
          source_meta: {},
        },
      ],
    ]);

    const result = prepareEntriesForWrite(entries, [row], existingByKey);

    expect(result.blockedEntries).toEqual([]);
    expect(result.preparedEntries).toHaveLength(1);
    expect(result.preparedEntries[0].source_meta.quality_improvement.previous_bundle_hash).toBeTruthy();
    expect(result.preparedEntries[0].source_meta.quality_improvement.existing_quality_lane).toBe('keep');
  });
});

function reviewedBundle(overrides = {}) {
  const qualityState = overrides.quality_state || 'reviewed';
  const evidenceProfile = overrides.evidence_profile || 'seller_plus_formula';
  return {
    contract_version: 'pivota.product_intel.v1',
    canonical_product_ref: {
      merchant_id: 'pilot_fenty',
      product_id: 'pilot_fenty_instant_reset',
    },
    product_intel_core: {
      quality_state: qualityState,
      evidence_profile: evidenceProfile,
      what_it_is: {
        headline: 'Overnight gel-cream moisturizer',
        body: 'An overnight gel-cream moisturizer designed to hydrate and support the skin barrier while you sleep.',
      },
      why_it_stands_out: [
        {
          headline: 'Gel-cream barrier support',
          body: 'Pairs humectants and barrier-supporting emollients in an overnight gel-cream format.',
        },
      ],
      best_for: [{ label: 'Night moisturizer', tag: 'night-cream' }],
      watchouts: [{ body: 'Patch test before daily use.' }],
    },
    shopping_card: {
      title: 'Instant Reset',
      subtitle: 'Overnight Gel-Cream',
      highlight: 'Overnight barrier support',
    },
    search_card: {
      title_candidate: 'Instant Reset',
      compact_candidate: 'Overnight Gel-Cream',
      highlight_candidate: 'Overnight barrier support',
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

function reviewedPublishRow() {
  return {
    case_id: 'pilot_fenty_instant_reset',
    review_status: 'completed',
    review_decision: 'rewrite',
    reviewer: 'Human QA',
    selected: {
      selected_mode: 'hybrid_gemini',
      selected_field_count: 6,
      field_sources: {
        what_it_is: 'gemini',
      },
      bundle: reviewedBundle({
        quality_state: 'limited',
        evidence_profile: 'seller_plus_formula',
        provenance: {
          external_highlight_review_status: 'rewrite',
          external_evidence_generated_at: '2026-04-10T12:00:00.000Z',
          external_evidence_model: 'external_highlight_pipeline_v1',
          external_review_batch: 'batch_demo',
        },
      }),
    },
  };
}
