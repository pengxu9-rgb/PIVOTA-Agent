const {
  buildOwnerDelegatedPublishReport,
} = require('../../scripts/build_owner_delegated_product_intel_publish_report');

describe('build_owner_delegated_product_intel_publish_report', () => {
  test('builds assistant-reviewed publish rows without claiming human review', () => {
    const compareReport = {
      rows: [
        {
          case_id: 'pilot_owner_delegated_case',
          baseline: {
            canonical_product_ref: {
              merchant_id: 'external_seed',
              product_id: 'ext_owner_delegated_case',
            },
          },
          selected: {
            selected_mode: 'human_standard_rewrite',
            selected_field_count: 3,
            field_sources: {
              what_it_is: 'human_standard',
            },
            bundle: publishableBundle(),
          },
        },
      ],
    };
    const reviewPacket = {
      rows: [
        {
          case_id: 'pilot_owner_delegated_case',
          review_decision: 'pass_recommended',
          reviewer: 'codex_quality_reviewer',
          reviewer_kind: 'assistant',
          public_write_allowed_by_this_packet: false,
          rationale: 'No automated precheck issues.',
          candidate_bundle_hash: 'candidate-hash',
          previous_bundle_hash: 'previous-hash',
        },
      ],
    };

    const report = buildOwnerDelegatedPublishReport(compareReport, reviewPacket, {
      ownerDelegated: true,
      reviewer: 'codex_quality_reviewer',
      reviewedAt: '2026-05-22T02:30:00.000Z',
      ownerInstruction: 'Owner asked Codex to perform review.',
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toEqual(
      expect.objectContaining({
        case_id: 'pilot_owner_delegated_case',
        review_status: 'completed',
        review_decision: 'rewrite',
        reviewer: 'codex_quality_reviewer',
        reviewer_kind: 'assistant',
        reviewed_at: '2026-05-22T02:30:00.000Z',
      }),
    );
    expect(report.rows[0].owner_delegated_review).toEqual(
      expect.objectContaining({
        reviewer_kind: 'assistant',
        source_public_write_allowed_by_packet: false,
        candidate_bundle_hash: 'candidate-hash',
      }),
    );
    expect(report.rows[0].reviewer_kind).not.toBe('human');
  });

  test('requires explicit owner delegation flag', () => {
    expect(() =>
      buildOwnerDelegatedPublishReport(
        { rows: [{ case_id: 'case_1', selected: { bundle: publishableBundle() } }] },
        { rows: [{ case_id: 'case_1' }] },
      ),
    ).toThrow(/owner_delegation_required/);
  });

  test('blocks rows with commerce truth claims', () => {
    const bundle = publishableBundle();
    bundle.product_intel_core.watchouts = [
      {
        label: 'Price may change at checkout.',
      },
    ];

    expect(() =>
      buildOwnerDelegatedPublishReport(
        {
          rows: [
            {
              case_id: 'case_with_price_claim',
              selected: {
                selected_mode: 'human_standard_rewrite',
                selected_field_count: 1,
                bundle,
              },
            },
          ],
        },
        {
          rows: [
            {
              case_id: 'case_with_price_claim',
              review_decision: 'pass_recommended',
              reviewer_kind: 'assistant',
            },
          ],
        },
        { ownerDelegated: true },
      ),
    ).toThrow(/commerce_truth_claim/);
  });
});

function publishableBundle() {
  return {
    contract_version: 'pivota.product_intel.v1',
    canonical_product_ref: {
      merchant_id: 'external_seed',
      product_id: 'ext_owner_delegated_case',
    },
    product_intel_core: {
      what_it_is: {
        headline: 'Color-correcting skinstick',
        body: 'A color-correcting skinstick designed to brighten and neutralize visible discoloration.',
      },
      why_it_stands_out: [
        {
          headline: 'Targeted color correction',
          body: 'Combines a portable stick format with shade-specific correction.',
        },
      ],
      best_for: [{ label: 'Targeted correction', tag: 'color-correction' }],
      watchouts: [
        {
          label: 'Color-correction fit depends on undertone and discoloration target.',
        },
      ],
    },
    shopping_card: {
      title: 'Match Stix Correcting Skinstick',
      subtitle: 'Color-Correcting Skinstick',
      highlight: 'Targeted color correction',
    },
    search_card: {
      compact_candidate: 'Color-Correcting Skinstick',
      highlight_candidate: 'Targeted color correction',
    },
    quality_state: 'ready',
    evidence_profile: 'seller_plus_formula',
    provenance: {
      source: 'product_intel_pilot_compare',
    },
  };
}
