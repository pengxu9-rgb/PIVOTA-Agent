const {
  assertProductIntelKbWritable,
  buildKbEntriesForRow,
} = require('../scripts/publish_product_intel_pilot_to_kb');

describe('publish_product_intel_pilot_to_kb', () => {
  test('builds product-key KB entries from selected bundles', () => {
    const row = {
      case_id: 'pilot_fenty_instant_reset',
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
        },
      },
    };

    const entries = buildKbEntriesForRow(row);

    expect(entries).toHaveLength(1);
    expect(entries[0].kb_key).toBe('product:pilot_fenty_instant_reset');
    expect(entries[0].analysis.product_intel_v1.contract_version).toBe('pivota.product_intel.v1');
    expect(entries[0].source).toBe('pivota_product_intel_pilot_selected');
    expect(entries[0].source_meta.selected_mode).toBe('hybrid_gemini');
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
