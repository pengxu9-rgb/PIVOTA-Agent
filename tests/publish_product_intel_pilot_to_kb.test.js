const {
  assertProductIntelKbWritable,
  buildKbEntriesForRow,
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
    expect(entries[0].source).toBe('pivota_product_intel_pilot_selected');
    expect(entries[0].source_meta.selected_mode).toBe('hybrid_gemini');
    expect(entries[0].source_meta.external_highlight_review_status).toBe('rewrite');
    expect(entries[0].source_meta.external_review_batch).toBe('batch_demo');
    expect(entries[0].source_meta.review_status).toBe('completed');
    expect(entries[0].source_meta.review_decision).toBe('rewrite');
    expect(entries[0].source_meta.reviewer).toBe('Human QA');
    expect(entries[0].source_meta.review_tier).toBe('strict_human');
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
});
