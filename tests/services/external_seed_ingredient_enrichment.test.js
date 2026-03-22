jest.mock('../../src/db', () => ({
  query: jest.fn(),
}));

jest.mock('../../src/services/pciKbClient', () => ({
  kbQuery: jest.fn(),
}));

const {
  ENRICHMENT_SOURCE,
  SEED_KB_SYNC_STATUS,
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
});
