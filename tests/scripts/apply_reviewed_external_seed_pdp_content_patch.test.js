const {
  _internals: {
    buildNextSeedData,
    buildServingPatch,
    parseInciItems,
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

  test('propagates root source metadata into entry quality summaries', () => {
    const [entry] = readManifestEntries({
      reviewed_by: 'codex',
      reason: 'verified_retailer_source_backed_inci',
      evidence: 'Ingredients were reviewed from a verified retailer PDP and cross-checked.',
      source_url: 'https://www.ulta.com/p/king-kylie-collection-loose-powder-highlighter-pimprod2055671',
      source_kind: 'verified_retailer_pdp_ingredients_cross_checked',
      entries: [
        {
          external_product_id: 'ext_king_highlighter',
          pdp_ingredients_raw:
            'Synthetic Fluorphlogopite, Mica, Silica, Octyldodecyl Stearoyl Stearate, Caprylyl Glycol, Ethylhexylglycerin.',
        },
      ],
    });

    const result = buildNextSeedData(
      { external_product_id: 'ext_king_highlighter', seed_data: { snapshot: {} } },
      entry,
      '2026-05-23T00:00:00.000Z',
    );

    expect(result.blocked).toEqual([]);
    expect(result.seedData.pdp_field_quality_summary.ingredients_raw).toEqual(
      expect.objectContaining({
        source_url: 'https://www.ulta.com/p/king-kylie-collection-loose-powder-highlighter-pimprod2055671',
        source_kinds: ['verified_retailer_pdp_ingredients_cross_checked'],
      }),
    );
    expect(result.seedData.reviewed_pdp_content_patch_v1).toEqual(
      expect.objectContaining({
        source_kind: 'verified_retailer_pdp_ingredients_cross_checked',
      }),
    );
  });

  test('preserves reviewed detail sections from manifest entries', () => {
    const [entry] = readManifestEntries({
      reviewed_by: 'codex',
      evidence: 'Brand PDP details were reviewed and rewritten.',
      source_url: 'https://brand.example/products/sample',
      source_kind: 'official_component_source_pdp',
      entries: [
        {
          external_product_id: 'ext_reviewed_sections',
          pdp_details_sections: [
            {
              heading: 'Formula cues',
              body: 'Brand source highlights a cream-to-lather cleanser format with non-stripping cleansing context.',
            },
          ],
        },
      ],
    });

    expect(validateEntry(entry)).toEqual([]);

    const result = buildNextSeedData(
      { external_product_id: 'ext_reviewed_sections', seed_data: { snapshot: {} } },
      entry,
      '2026-05-24T00:00:00.000Z',
    );

    expect(result.blocked).toEqual([]);
    expect(result.fields).toEqual(['pdp_details_sections']);
    expect(result.seedData.pdp_details_sections).toEqual([
      expect.objectContaining({
        heading: 'Formula cues',
        body: 'Brand source highlights a cream-to-lather cleanser format with non-stripping cleansing context.',
        source_origin: 'reviewed_source_backed_pdp_content_patch',
        source_quality_status: 'high',
      }),
    ]);
  });

  test('protects existing high-quality description while filling missing ingredients', () => {
    const [entry] = readManifestEntries({
      reviewed_by: 'codex',
      evidence: 'Retailer ingredients were reviewed from the current product detail page.',
      source_url: 'https://retailer.example/products/lip',
      source_kind: 'verified_retailer_pdp_ingredients',
      entries: [
        {
          external_product_id: 'ext_keep_description',
          description: 'A shorter retailer description that should not replace the brand authored content.',
          pdp_ingredients_raw:
            'Dimethicone, Silica, Trimethylsiloxysilicate, Polyisobutene, Polyethylene, Ozokerite, Titanium Dioxide.',
        },
      ],
    });

    const row = {
      external_product_id: 'ext_keep_description',
      seed_data: {
        description: 'Brand-authored long-form product description from the PDP that should remain in place.',
        snapshot: {
          description: 'Brand-authored long-form product description from the PDP that should remain in place.',
        },
        pdp_field_quality_summary: {
          description_raw: {
            source_origin: 'official_pdp',
            source_quality_status: 'high',
          },
          ingredients_raw: {
            source_origin: 'unknown',
            source_quality_status: 'low',
          },
        },
      },
    };

    const result = buildNextSeedData(row, entry, '2026-05-24T00:00:00.000Z');

    expect(result.blocked).toEqual([]);
    expect(result.skipped_fields).toEqual(expect.arrayContaining(['blocked_protect_high_quality_description']));
    expect(result.fields).toEqual(expect.arrayContaining(['pdp_ingredients_raw']));
    expect(result.seedData.description).toBe(row.seed_data.description);
    expect(result.seedData.pdp_ingredients_raw).toBe(entry.pdp_ingredients_raw);
    expect(result.seedData.ingredients_inci).toEqual([
      'Dimethicone',
      'Silica',
      'Trimethylsiloxysilicate',
      'Polyisobutene',
      'Polyethylene',
      'Ozokerite',
      'Titanium Dioxide.',
    ]);
  });

  test('normalizes reviewed raw INCI text into a structured ingredients array', () => {
    expect(
      parseInciItems(
        'SIMMONDSIA CHINENSIS SEED OIL */**, SQUALANE *, PARFUM * (natural identical) * Ingredients from natural origin (99.5%)',
      ),
    ).toEqual(['SIMMONDSIA CHINENSIS SEED OIL', 'SQUALANE', 'PARFUM (natural identical)']);
  });

  test('can write reviewed ingredient authority for short source-backed INCI patches', () => {
    const [entry] = readManifestEntries({
      reviewed_by: 'codex',
      evidence: 'Official PDP ingredients were reviewed and scoped to the product formula.',
      source_url: 'https://brand.example/products/remover',
      source_kind: 'official_stiletto_accordion_scoped_formula',
      write_reviewed_ingredient_authority: true,
      entries: [
        {
          external_product_id: 'ext_remover',
          pdp_ingredients_raw:
            'Dimethyl Glutamate, Dimethyl Adipate, Methyl Oleate/Palmitate/Linoleate/Stearate, Trideceth-8',
        },
      ],
    });

    const result = buildNextSeedData(
      { external_product_id: 'ext_remover', seed_data: { snapshot: {} } },
      entry,
      '2026-05-28T00:00:00.000Z',
    );

    expect(result.blocked).toEqual([]);
    expect(result.seedData.ingredient_intel.authoritative).toEqual(
      expect.objectContaining({
        purity_status: 'authoritative',
        authority_scope: 'reviewed_official_pdp_inci',
        items: [
          'Dimethyl Glutamate',
          'Dimethyl Adipate',
          'Methyl Oleate/Palmitate/Linoleate/Stearate',
          'Trideceth-8',
        ],
      }),
    );
    expect(result.seedData.snapshot.ingredient_intel.authoritative).toEqual(
      expect.objectContaining({
        source_origin: 'reviewed_source_backed_pdp_content_patch',
      }),
    );
  });

  test('patches same raw INCI when structured ingredients are missing', () => {
    const [entry] = readManifestEntries({
      reviewed_by: 'codex',
      evidence: 'Official PDP ingredients were reviewed and need structured INCI normalization.',
      source_url: 'https://brand.example/products/oil',
      source_kind: 'official_pdp_ingredients_reviewed',
      entries: [
        {
          external_product_id: 'ext_same_raw_missing_structured',
          pdp_ingredients_raw:
            'SIMMONDSIA CHINENSIS SEED OIL */**, MACADAMIA TERNIFOLIA SEED OIL *, SQUALANE *, TOCOPHEROL *',
        },
      ],
    });

    const result = buildNextSeedData(
      {
        external_product_id: 'ext_same_raw_missing_structured',
        seed_data: {
          pdp_ingredients_raw: entry.pdp_ingredients_raw,
          raw_ingredient_text_clean: entry.pdp_ingredients_raw,
          inci_list: entry.pdp_ingredients_raw,
          snapshot: {},
        },
      },
      entry,
      '2026-05-24T00:00:00.000Z',
    );

    expect(result.changed).toBe(true);
    expect(result.fields).toEqual(expect.arrayContaining(['ingredients_inci']));
    expect(result.seedData.ingredients_inci).toEqual([
      'SIMMONDSIA CHINENSIS SEED OIL',
      'MACADAMIA TERNIFOLIA SEED OIL',
      'SQUALANE',
      'TOCOPHEROL',
    ]);
  });

  test('materializes canonical ingredient fields when only legacy aliases are populated', () => {
    const [entry] = readManifestEntries({
      reviewed_by: 'codex',
      evidence: 'Exact shade ingredients were reviewed from the current retailer product detail page.',
      source_url: 'https://retailer.example/products/eyeliner-purple',
      source_kind: 'verified_retailer_exact_shade_inci',
      entries: [
        {
          external_product_id: 'ext_alias_only_inci',
          pdp_ingredients_raw:
            'Trisiloxane, Trimethylsiloxysilicate, Polyethylene, Dimethicone, Mica, Titanium Dioxide.',
        },
      ],
    });

    const row = {
      external_product_id: 'ext_alias_only_inci',
      seed_data: {
        raw_ingredient_text_clean:
          'TRISILOXANE, TRIMETHYLSILOXYSILICATE, POLYETHYLENE, DIMETHICONE, MICA, TITANIUM DIOXIDE.',
        inci_list:
          'TRISILOXANE, TRIMETHYLSILOXYSILICATE, POLYETHYLENE, DIMETHICONE, MICA, TITANIUM DIOXIDE.',
        snapshot: {},
        pdp_field_quality_summary: {
          ingredients_raw: {
            source_origin: 'unknown',
            source_quality_status: 'low',
          },
        },
      },
    };

    const result = buildNextSeedData(row, entry, '2026-05-24T00:00:00.000Z');

    expect(result.blocked).toEqual([]);
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual(expect.arrayContaining(['pdp_ingredients_raw', 'raw_ingredient_text_clean']));
    expect(result.seedData.pdp_ingredients_raw).toBe(entry.pdp_ingredients_raw);
    expect(result.seedData.snapshot.pdp_ingredients_raw).toBe(entry.pdp_ingredients_raw);
    expect(result.seedData.ingredient_intel.raw_ingredient_text_clean).toBe(entry.pdp_ingredients_raw);
    expect(result.seedData.pdp_field_quality_summary.ingredients_raw).toEqual(
      expect.objectContaining({
        source_origin: 'reviewed_source_backed_pdp_content_patch',
        source_quality_status: 'high',
        source_kinds: ['verified_retailer_exact_shade_inci'],
      }),
    );

    const servingPatch = buildServingPatch(result.seedData, result.fields);
    expect(servingPatch).toEqual(
      expect.objectContaining({
        pdp_ingredients_raw: entry.pdp_ingredients_raw,
        raw_ingredient_text_clean: entry.pdp_ingredients_raw,
        ingredient_intel: expect.objectContaining({
          raw_ingredient_text_clean: entry.pdp_ingredients_raw,
        }),
      }),
    );
  });

  test('blocks a description-only patch when existing description is high quality', () => {
    const [entry] = readManifestEntries({
      reviewed_by: 'codex',
      evidence: 'Retailer description was reviewed from the current product detail page.',
      source_url: 'https://retailer.example/products/lip',
      source_kind: 'verified_retailer_pdp_description',
      entries: [
        {
          external_product_id: 'ext_block_description',
          description: 'A retailer description that is long enough but weaker than the brand-authored copy.',
        },
      ],
    });

    const row = {
      external_product_id: 'ext_block_description',
      seed_data: {
        description: 'Brand-authored long-form product description from the PDP that should remain in place.',
        snapshot: {},
        pdp_field_quality_summary: {
          description_raw: {
            source_origin: 'official_pdp',
            source_quality_status: 'high',
          },
        },
      },
    };

    const result = buildNextSeedData(row, entry, '2026-05-24T00:00:00.000Z');

    expect(result.changed).toBe(false);
    expect(result.blocked).toEqual(['blocked_protect_high_quality_description']);
  });
});
