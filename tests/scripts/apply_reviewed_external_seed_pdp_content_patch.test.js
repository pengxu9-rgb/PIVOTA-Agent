const {
  _internals: {
    buildNextSeedData,
    buildServingPatch,
    readManifestEntries,
    validateEntry,
  },
} = require('../../scripts/apply-reviewed-external-seed-pdp-content-patch.cjs');

describe('apply-reviewed-external-seed-pdp-content-patch', () => {
  test('accepts source-backed how-to-only patches without replacing description', () => {
    const [entry] = readManifestEntries({
      reviewed_by: 'codex_review',
      entries: [
        {
          external_product_id: 'ext_reviewed_how_to',
          evidence: 'Retailer directions reviewed from the current product detail page.',
          source_url: 'https://retailer.example/products/cream',
          source_kind: 'retailer_pdp_how_to_use',
          pdp_how_to_use_raw: 'After cleansing, apply a small amount evenly and let it absorb.',
        },
      ],
    });

    expect(validateEntry(entry)).toEqual([]);

    const row = {
      external_product_id: 'ext_reviewed_how_to',
      seed_data: {
        description: 'Existing high quality description that should not be replaced.',
        snapshot: {
          description: 'Existing high quality description that should not be replaced.',
        },
      },
    };
    const result = buildNextSeedData(row, entry, '2026-05-19T00:00:00.000Z');

    expect(result.blocked).toEqual([]);
    expect(result.changed).toBe(true);
    expect(result.seedData.description).toBe(row.seed_data.description);
    expect(result.seedData.snapshot.description).toBe(row.seed_data.snapshot.description);
    expect(result.seedData.pdp_how_to_use_raw).toBe(entry.pdp_how_to_use_raw);
    expect(result.seedData.snapshot.pdp_how_to_use_raw).toBe(entry.pdp_how_to_use_raw);
    expect(result.seedData.pdp_field_quality_summary.how_to_use_raw).toEqual(
      expect.objectContaining({
        source_origin: 'reviewed_source_backed_pdp_content_patch',
        source_quality_status: 'high',
        source_url: 'https://retailer.example/products/cream',
      }),
    );
    expect(result.fields).toEqual(expect.arrayContaining(['pdp_how_to_use_raw']));

    const servingPatch = buildServingPatch(result.seedData, result.fields);
    expect(servingPatch).toEqual(
      expect.objectContaining({
        pdp_how_to_use_raw: entry.pdp_how_to_use_raw,
        reviewed_pdp_content_patch_v1: expect.any(Object),
      }),
    );
    expect(servingPatch).not.toHaveProperty('description');
    expect(servingPatch).not.toHaveProperty('pdp_description_raw');
  });

  test('blocks how-to patches without review evidence', () => {
    const [entry] = readManifestEntries({
      entries: [
        {
          external_product_id: 'ext_reviewed_how_to',
          pdp_how_to_use_raw: 'Apply a small amount evenly and let it absorb.',
        },
      ],
    });

    expect(validateEntry(entry)).toEqual(expect.arrayContaining(['missing_review_evidence']));
  });
});
