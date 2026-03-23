jest.mock('../../src/db', () => ({
  query: jest.fn(),
}));

jest.mock('../../src/services/pciKbClient', () => ({
  kbQuery: jest.fn(),
}));

const {
  ENRICHMENT_SOURCE,
  SEED_ANCHOR_CONFLICT_STATUS,
  SEED_ANCHOR_SOURCE_KIND,
  SEED_KB_SYNC_STATUS,
  SEED_QUARANTINE_BUCKET,
  _internals,
  enrichExternalSeedRowIngredients,
} = require('../../src/services/externalSeedIngredientEnrichment');

describe('externalSeedIngredientEnrichment', () => {
  test('writes reviewed KB ingredient coverage back into root and snapshot seed_data', async () => {
    const row = {
      id: 'eps_bpo',
      title: 'Rapid Clear Stubborn Acne Spot Gel',
      canonical_url: 'https://neutrogena.example.com/products/rapid-clear-stubborn-acne-spot-gel',
      destination_url: 'https://neutrogena.example.com/products/rapid-clear-stubborn-acne-spot-gel',
      seed_data: {
        snapshot: {
          title: 'Rapid Clear Stubborn Acne Spot Gel',
          canonical_url: 'https://neutrogena.example.com/products/rapid-clear-stubborn-acne-spot-gel',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      ingredientId: 'benzoyl_peroxide',
      kbRows: [
        {
          sku_key: 'extseed:eps_bpo:US',
          parse_status: 'OK',
          raw_ingredient_text_clean: 'Active ingredient: Benzoyl Peroxide 10%',
          inci_list: 'Benzoyl Peroxide 10%',
          product_name: 'Rapid Clear Stubborn Acne Spot Gel',
          source_ref: 'https://neutrogena.example.com/products/rapid-clear-stubborn-acne-spot-gel',
        },
      ],
    });

    expect(out.changed).toBe(true);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.kbReviewed);
    expect(out.seed_kb_sync_status).toBe(SEED_KB_SYNC_STATUS.synced);
    expect(out.runtime_ingredient_evidence_source).toBe('seed_structured_fields');
    expect(out.seed_anchor_source_kind).toBe(SEED_ANCHOR_SOURCE_KIND.kbReviewed);
    expect(out.seed_quarantine_bucket).toBeNull();
    expect(out.quarantined_from_wave1).toBe(false);
    expect(out.row.seed_data.ingredient_tokens).toEqual(expect.arrayContaining(['Benzoyl peroxide']));
    expect(out.row.seed_data.active_ingredients).toEqual(expect.arrayContaining(['Benzoyl peroxide']));
    expect(out.row.seed_data.snapshot.ingredient_tokens).toEqual(expect.arrayContaining(['Benzoyl peroxide']));
    expect(out.row.seed_data.ingredient_intel.external_seed_enrichment).toEqual(
      expect.objectContaining({
        source: ENRICHMENT_SOURCE.kbReviewed,
        kb_row_count: 1,
      }),
    );
  });

  test('anchor-only enrichment stays token-only and does not fabricate inci or actives', async () => {
    const row = {
      id: 'eps_alpha',
      title: 'Alpha Arbutin 2% + HA',
      canonical_url: 'https://theordinary.example.com/products/alpha-arbutin-2-ha',
      destination_url: 'https://theordinary.example.com/products/alpha-arbutin-2-ha',
      seed_data: {
        snapshot: {
          title: 'Alpha Arbutin 2% + HA',
          canonical_url: 'https://theordinary.example.com/products/alpha-arbutin-2-ha',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      ingredientId: 'alpha_arbutin',
      ingredientName: 'Alpha Arbutin',
      kbRows: [],
    });

    expect(out.changed).toBe(true);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.titleUrlAnchor);
    expect(out.seed_anchor_source_kind).toBe(SEED_ANCHOR_SOURCE_KIND.explicitTitleUrlAnchor);
    expect(out.row.seed_data.ingredient_tokens).toEqual(expect.arrayContaining(['Alpha Arbutin']));
    expect(out.row.seed_data.key_ingredients).toEqual(expect.arrayContaining(['Alpha Arbutin']));
    expect(out.row.seed_data.active_ingredients || []).toEqual([]);
    expect(out.row.seed_data.raw_ingredient_text_clean).toBeUndefined();
    expect(out.row.seed_data.inci_list).toBeUndefined();
  });

  test('description parse does not create ingredient structure from weak marketing copy', () => {
    const block = _internals.buildBlockFromDescriptionParse(
      {
        seed_data: {
          description: 'Soothes the look of redness and supports a healthy-looking skin barrier.',
          snapshot: {
            description: 'Hydrates and comforts for softer-feeling skin.',
          },
        },
      },
      {},
    );

    expect(block).toBeNull();
  });

  test('pdp ingredient fields produce structured ingredient evidence without relying on generic description', () => {
    const block = _internals.buildBlockFromPdpIngredientFields(
      {
        seed_data: {
          pdp_ingredients_raw: 'Water, Glycerin, Ceramide NP, Cholesterol',
          pdp_details_sections: [
            {
              heading: 'How to Use',
              body: 'Use morning and night.',
              source_kind: 'accordion_how_to_use',
            },
          ],
        },
      },
      {},
    );

    expect(block).toEqual(
      expect.objectContaining({
        raw_ingredient_text_clean: 'Water, Glycerin, Ceramide NP, Cholesterol',
        ingredient_tokens: expect.arrayContaining(['Ceramide NP']),
        key_ingredients: expect.arrayContaining(['Ceramide NP']),
        ingredient_intel: expect.objectContaining({
          external_seed_enrichment: expect.objectContaining({
            source: ENRICHMENT_SOURCE.pdpIngredientFields,
            parsed_from_pdp_fields: true,
          }),
        }),
      }),
    );
  });

  test('synthetic summary origin does not feed description-based ingredient parsing', () => {
    const block = _internals.buildBlockFromDescriptionParse(
      {
        seed_data: {
          seed_description_origin: 'synthetic_summary',
          pdp_description_raw: 'OFFICIAL: Brightens skin. /// SOCIAL HIGHLIGHTS: TikTok loves it. Ingredients: Water, Niacinamide.',
        },
      },
      {},
    );

    expect(block).toBeNull();
  });

  test('does not re-derive a different anchor when structured ingredient fields are already present', async () => {
    const row = {
      id: 'eps_bpo_present',
      title: 'Rapid Clear Stubborn Acne Spot Gel',
      canonical_url: 'https://neutrogena.example.com/products/rapid-clear-stubborn-acne-spot-gel',
      destination_url: 'https://neutrogena.example.com/products/rapid-clear-stubborn-acne-spot-gel',
      seed_data: {
        raw_ingredient_text_clean: 'benzoyl peroxide 10%',
        inci_list: 'benzoyl peroxide 10%',
        ingredient_tokens: ['benzoyl peroxide', 'bpo'],
        active_ingredients: ['benzoyl peroxide 10%'],
        key_ingredients: ['benzoyl peroxide'],
        snapshot: {
          title: 'Rapid Clear Stubborn Acne Spot Gel',
          canonical_url: 'https://neutrogena.example.com/products/rapid-clear-stubborn-acne-spot-gel',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      kbRows: [],
    });

    expect(out.changed).toBe(false);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.none);
    expect(out.row.seed_data.ingredient_tokens).toEqual(['benzoyl peroxide', 'bpo']);
    expect(out.row.seed_data.key_ingredients).toEqual(['benzoyl peroxide']);
    expect(out.row.seed_data.active_ingredients).toEqual(['benzoyl peroxide 10%']);
  });

  test('upgrades title-anchor structured state when stronger pdp ingredient fields become available', async () => {
    const row = {
      id: 'eps_pixi_upgrade',
      title: 'Rose Ceramide Cream',
      canonical_url: 'https://pixibeauty.example.com/products/rose-ceramide-cream',
      destination_url: 'https://pixibeauty.example.com/products/rose-ceramide-cream',
      seed_data: {
        ingredient_tokens: ['Ceramide NP'],
        key_ingredients: ['Ceramide NP'],
        ingredient_intel: {
          external_seed_enrichment: {
            source: ENRICHMENT_SOURCE.titleUrlAnchor,
            seed_anchor_source_kind: SEED_ANCHOR_SOURCE_KIND.explicitTitleUrlAnchor,
          },
        },
        pdp_ingredients_raw: 'Water, Glycerin, Ceramide NP, Cholesterol',
        pdp_details_sections: [
          {
            heading: 'Ingredients',
            body: 'Water, Glycerin, Ceramide NP, Cholesterol',
            source_kind: 'accordion_ingredients',
          },
        ],
        seed_description_origin: 'pdp_product_description',
        snapshot: {
          title: 'Rose Ceramide Cream',
          canonical_url: 'https://pixibeauty.example.com/products/rose-ceramide-cream',
          ingredient_tokens: ['Ceramide NP'],
          key_ingredients: ['Ceramide NP'],
          ingredient_intel: {
            external_seed_enrichment: {
              source: ENRICHMENT_SOURCE.titleUrlAnchor,
              seed_anchor_source_kind: SEED_ANCHOR_SOURCE_KIND.explicitTitleUrlAnchor,
            },
          },
          pdp_ingredients_raw: 'Water, Glycerin, Ceramide NP, Cholesterol',
          pdp_details_sections: [
            {
              heading: 'Ingredients',
              body: 'Water, Glycerin, Ceramide NP, Cholesterol',
              source_kind: 'accordion_ingredients',
            },
          ],
          seed_description_origin: 'pdp_product_description',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      kbRows: [],
    });

    expect(out.changed).toBe(true);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.pdpIngredientFields);
    expect(out.row.seed_data.raw_ingredient_text_clean).toBe('Water, Glycerin, Ceramide NP, Cholesterol');
    expect(out.row.seed_data.ingredient_intel.external_seed_enrichment).toEqual(
      expect.objectContaining({
        source: ENRICHMENT_SOURCE.pdpIngredientFields,
        parsed_from_pdp_fields: true,
      }),
    );
  });

  test('does not bulk-anchor a blank row from family-only title text', async () => {
    const row = {
      id: 'eps_family_only',
      title: 'Winona Soothing Repair Serum',
      canonical_url: 'https://winona.example.com/products/soothing-repair-serum',
      destination_url: 'https://winona.example.com/products/soothing-repair-serum',
      seed_data: {
        snapshot: {
          title: 'Winona Soothing Repair Serum',
          canonical_url: 'https://winona.example.com/products/soothing-repair-serum',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      kbRows: [],
    });

    expect(out.changed).toBe(false);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.none);
    expect(out.quarantine_reason).toBeNull();
    expect(out.seed_quarantine_bucket).toBe(SEED_QUARANTINE_BUCKET.manualUpstreamRequired);
    expect(out.quarantined_from_wave1).toBe(true);
    expect(out.seed_structured_ingredient_status_after).toBe('missing');
    expect(out.row.seed_data.ingredient_tokens).toBeUndefined();
  });

  test('does not use row-level ingredient_name as a bulk anchor when title and url have no explicit match', async () => {
    const row = {
      id: 'eps_bpo_blank',
      title: 'Rapid Clear Stubborn Acne Spot Gel',
      ingredient_name: 'Benzoyl peroxide',
      canonical_url: 'https://neutrogena.example.com/products/rapid-clear-stubborn-acne-spot-gel',
      destination_url: 'https://neutrogena.example.com/products/rapid-clear-stubborn-acne-spot-gel',
      seed_data: {
        ingredient_name: 'Benzoyl peroxide',
        snapshot: {
          title: 'Rapid Clear Stubborn Acne Spot Gel',
          canonical_url: 'https://neutrogena.example.com/products/rapid-clear-stubborn-acne-spot-gel',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      kbRows: [],
    });

    expect(out.changed).toBe(false);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.none);
    expect(out.quarantine_reason).toBe('row_ingredient_name_only');
    expect(out.seed_quarantine_bucket).toBe(SEED_QUARANTINE_BUCKET.rowIngredientNameOnly);
    expect(out.quarantined_from_wave1).toBe(true);
    expect(out.seed_structured_ingredient_status_after).toBe('missing');
    expect(out.row.seed_data.ingredient_tokens).toBeUndefined();
  });

  test('does not infer a bulk anchor from a stale url-only sunscreen match when the title has no explicit anchor', async () => {
    const row = {
      id: 'eps_stale_url',
      title: 'Sérum C³ Perfection',
      canonical_url: 'https://patyka.example.com/en-us/products/spf50-face-sunscreen-sample',
      destination_url: 'https://patyka.example.com/products/creme-solaire-visage-spf50-echantillon',
      seed_data: {
        snapshot: {
          title: 'Sérum C³ Perfection',
          canonical_url: 'https://patyka.example.com/en-us/products/spf50-face-sunscreen-sample',
          destination_url: 'https://patyka.example.com/products/creme-solaire-visage-spf50-echantillon',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      kbRows: [],
    });

    expect(out.changed).toBe(false);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.none);
    expect(out.quarantine_reason).toBe('url_only_anchor');
    expect(out.seed_quarantine_bucket).toBe(SEED_QUARANTINE_BUCKET.manualUpstreamRequired);
    expect(out.quarantined_from_wave1).toBe(true);
    expect(out.seed_anchor_conflict_status).toBe(SEED_ANCHOR_CONFLICT_STATUS.none);
    expect(out.seed_structured_ingredient_status_after).toBe('missing');
    expect(out.row.seed_data.ingredient_tokens).toBeUndefined();
  });

  test('quarantines conflicting title and url ingredient anchors instead of writing back', async () => {
    const row = {
      id: 'eps_conflict',
      title: 'Ceramide Face Cream',
      canonical_url: 'https://brand.example.com/products/spf-50-face-sunscreen',
      destination_url: 'https://brand.example.com/products/spf-50-face-sunscreen',
      seed_data: {
        snapshot: {
          title: 'Ceramide Face Cream',
          canonical_url: 'https://brand.example.com/products/spf-50-face-sunscreen',
          destination_url: 'https://brand.example.com/products/spf-50-face-sunscreen',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      kbRows: [],
    });

    expect(out.changed).toBe(false);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.none);
    expect(out.quarantine_reason).toBe('url_anchor_conflict');
    expect(out.seed_anchor_conflict_status).toBe(SEED_ANCHOR_CONFLICT_STATUS.urlAnchorConflict);
    expect(out.url_anchor_conflict).toBe(true);
    expect(out.seed_quarantine_bucket).toBe(SEED_QUARANTINE_BUCKET.urlAnchorConflict);
    expect(out.quarantined_from_wave1).toBe(true);
  });

  test('quarantines contaminated attached slice rows from auto-writeback', async () => {
    const row = {
      id: 'eps_dirty_attached',
      attached_product_key: 'prod_dirty',
      domain: 'jwx893-fz.myshopify.com',
      title: 'Small Eyeshadow Brush',
      canonical_url: 'https://jwx893-fz.myshopify.com/products/moyu-5560894018009',
      destination_url: 'https://jwx893-fz.myshopify.com/products/moyu-5560894018009',
      seed_data: {
        snapshot: {
          title: 'Small Eyeshadow Brush',
          canonical_url: 'https://jwx893-fz.myshopify.com/products/moyu-5560894018009',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      ingredientId: 'niacinamide',
      ingredientName: 'Niacinamide',
      kbRows: [
        {
          sku_key: 'extseed:eps_dirty_attached:US',
          parse_status: 'OK',
          raw_ingredient_text_clean: 'Niacinamide',
          inci_list: 'Niacinamide',
          product_name: 'Small Eyeshadow Brush',
          source_ref: 'https://jwx893-fz.myshopify.com/products/moyu-5560894018009',
        },
      ],
    });

    expect(out.changed).toBe(false);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.none);
    expect(out.seed_quarantine_bucket).toBe(SEED_QUARANTINE_BUCKET.attachedContamination);
    expect(out.quarantined_from_wave1).toBe(true);
    expect(out.contamination_signal_source).toBe('attached_domain_blocklist');
  });

  test('quarantines reviewed KB off-surface rows from Wave 1 auto-sync', async () => {
    const row = {
      id: 'eps_eye',
      domain: 'pixibeauty.com',
      title: 'Retinol Eye Cream',
      canonical_url: 'https://pixibeauty.com/products/retinol-eye-cream',
      destination_url: 'https://pixibeauty.com/products/retinol-eye-cream',
      seed_data: {
        snapshot: {
          title: 'Retinol Eye Cream',
          canonical_url: 'https://pixibeauty.com/products/retinol-eye-cream',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      kbRows: [
        {
          sku_key: 'extseed:eps_eye:US',
          parse_status: 'OK',
          raw_ingredient_text_clean: 'Retinol',
          inci_list: 'Retinol',
          product_name: 'Retinol Eye Cream - 25 ml',
          source_ref: 'https://www.pixibeauty.com/products/retinol-eye-cream',
        },
      ],
    });

    expect(out.changed).toBe(true);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.kbReviewed);
    expect(out.seed_quarantine_bucket).toBe(SEED_QUARANTINE_BUCKET.manualUpstreamRequired);
    expect(out.quarantined_from_wave1).toBe(true);
    expect(out.contamination_signal_source).toBe('row_scope_off_surface_signal');
  });

  test('quarantines hand-mask title anchors from Wave 1 auto-sync', async () => {
    const row = {
      id: 'eps_hand_mask',
      domain: 'fentybeauty.com',
      title: 'Hydra’Reset Intensive Recovery Glycerin Hand Mask',
      canonical_url: 'https://fentybeauty.com/products/hydrareset-intensive-recovery-glycerin-hand-mask',
      destination_url: 'https://fentybeauty.com/products/hydrareset-intensive-recovery-glycerin-hand-mask',
      seed_data: {
        snapshot: {
          title: 'Hydra’Reset Intensive Recovery Glycerin Hand Mask',
          canonical_url: 'https://fentybeauty.com/products/hydrareset-intensive-recovery-glycerin-hand-mask',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      ingredientId: 'glycerin',
      ingredientName: 'Glycerin',
    });

    expect(out.changed).toBe(true);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.titleUrlAnchor);
    expect(out.seed_quarantine_bucket).toBe(SEED_QUARANTINE_BUCKET.manualUpstreamRequired);
    expect(out.quarantined_from_wave1).toBe(true);
    expect(out.contamination_signal_source).toBe('row_scope_off_surface_signal');
  });

  test("quarantines collector's-case bundle title anchors from Wave 1 auto-sync", async () => {
    const row = {
      id: 'eps_collectors_case',
      domain: 'fentybeauty.com',
      title: "Skincare Lov'rs Cleanser, Toner, SPF Moisturizer + Collector's Case",
      canonical_url: 'https://fentybeauty.com/products/skincare-lovrs-cleanser-toner-spf-moisturizer-collectors-case',
      destination_url: 'https://fentybeauty.com/products/skincare-lovrs-cleanser-toner-spf-moisturizer-collectors-case',
      seed_data: {
        snapshot: {
          title: "Skincare Lov'rs Cleanser, Toner, SPF Moisturizer + Collector's Case",
          canonical_url: 'https://fentybeauty.com/products/skincare-lovrs-cleanser-toner-spf-moisturizer-collectors-case',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      ingredientId: 'sunscreen_filters',
      ingredientName: 'Sunscreen Filters',
    });

    expect(out.changed).toBe(true);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.titleUrlAnchor);
    expect(out.seed_quarantine_bucket).toBe(SEED_QUARANTINE_BUCKET.manualUpstreamRequired);
    expect(out.quarantined_from_wave1).toBe(true);
    expect(out.contamination_signal_source).toBe('row_scope_bundle_signal');
  });

  test('quarantines reviewed KB bundle rows from Wave 1 auto-sync', async () => {
    const row = {
      id: 'eps_kit',
      domain: 'dermalogica.com',
      title: 'dark spot solutions kit',
      canonical_url: 'https://dermalogica.com/products/dark-spot-solutions-kit',
      destination_url: 'https://dermalogica.com/products/dark-spot-solutions-kit',
      seed_data: {
        snapshot: {
          title: 'dark spot solutions kit',
          canonical_url: 'https://dermalogica.com/products/dark-spot-solutions-kit',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      kbRows: [
        {
          sku_key: 'extseed:eps_kit:US',
          parse_status: 'OK',
          raw_ingredient_text_clean: 'Niacinamide',
          inci_list: 'Niacinamide',
          product_name: 'dark spot solutions kit - KIT',
          source_ref: 'https://www.dermalogica.com/products/dark-spot-solutions-kit',
        },
      ],
    });

    expect(out.changed).toBe(true);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.kbReviewed);
    expect(out.seed_quarantine_bucket).toBe(SEED_QUARANTINE_BUCKET.manualUpstreamRequired);
    expect(out.quarantined_from_wave1).toBe(true);
    expect(out.contamination_signal_source).toBe('row_scope_bundle_signal');
  });

  test('quarantines reviewed KB rows that lack a safe face-skincare class signal', async () => {
    const row = {
      id: 'eps_base',
      domain: 'pixibeauty.com',
      title: 'On-the-Glow BASE',
      canonical_url: 'https://pixibeauty.com/products/on-the-glow-base',
      destination_url: 'https://pixibeauty.com/products/on-the-glow-base',
      seed_data: {
        snapshot: {
          title: 'On-the-Glow BASE',
          canonical_url: 'https://pixibeauty.com/products/on-the-glow-base',
        },
      },
    };

    const out = await enrichExternalSeedRowIngredients({
      row,
      kbRows: [
        {
          sku_key: 'extseed:eps_base:US',
          parse_status: 'OK',
          raw_ingredient_text_clean: 'Niacinamide',
          inci_list: 'Niacinamide',
          product_name: 'On-the-Glow BASE',
          source_ref: 'https://www.pixibeauty.com/products/on-the-glow-base',
        },
      ],
    });

    expect(out.changed).toBe(true);
    expect(out.enrichment_source).toBe(ENRICHMENT_SOURCE.kbReviewed);
    expect(out.seed_quarantine_bucket).toBe(SEED_QUARANTINE_BUCKET.manualUpstreamRequired);
    expect(out.quarantined_from_wave1).toBe(true);
    expect(out.contamination_signal_source).toBe('row_scope_off_surface_signal');
  });
});
