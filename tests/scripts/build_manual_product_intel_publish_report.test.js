const {
  buildManualPublishReport,
} = require('../../scripts/build_manual_product_intel_publish_report');

describe('build_manual_product_intel_publish_report', () => {
  test('applies Oil La La manual override and emits approved publish row', () => {
    const compareReport = {
      rows: [
        {
          case_id: 'live_ext_5ffe1c0b5195b36d2bdcffa9',
          baseline: {
            canonical_product_ref: {
              merchant_id: 'external_seed',
              product_id: 'ext_5ffe1c0b5195b36d2bdcffa9',
            },
          },
          selected: {
            selected_mode: 'human_standard_rewrite',
            field_sources: {},
            selected_field_count: 0,
            bundle: {
              contract_version: 'pivota.product_intel.v1',
              canonical_product_ref: {
                merchant_id: 'external_seed',
                product_id: 'ext_5ffe1c0b5195b36d2bdcffa9',
              },
              product_intel_core: {
                what_it_is: {
                  headline: 'Daily cleanser',
                  body: 'Incorrect baseline body for test coverage.',
                },
              },
              shopping_card: {
                title: 'KraveBeauty Oil La La',
                subtitle: 'Daily Cleanser',
              },
              search_card: {},
              review_summary: {
                rating: 4.2,
                review_count: 404,
              },
            },
          },
        },
      ],
    };

    const report = buildManualPublishReport(compareReport, ['live_ext_5ffe1c0b5195b36d2bdcffa9']);
    const row = report.rows[0];

    expect(report.rows).toHaveLength(1);
    expect(row.review_status).toBe('approved');
    expect(row.review_decision).toBe('approved');
    expect(row.selected.selected_mode).toBe('manual_override');
    expect(row.selected.bundle.product_intel_core.what_it_is.headline).toBe('Facial oil-serum');
    expect(row.selected.bundle.product_intel_core.what_it_is.body).toMatch(/breakout-prone/i);
    expect(row.selected.bundle.shopping_card.subtitle).toMatch(/Facial Oil Serum|Facial Oil-Serum/i);
    expect(row.selected.bundle.search_card.compact_candidate).toMatch(/Facial Oil Serum|Facial Oil-Serum/i);
    expect(row.selected.bundle.product_intel_core.what_it_is.body).not.toMatch(/cleanser/i);
  });
});
