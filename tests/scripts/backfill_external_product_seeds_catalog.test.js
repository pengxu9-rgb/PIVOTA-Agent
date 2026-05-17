const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const axios = require('axios');

const {
  pickSeedTargetUrl,
  buildExtractRequestBody,
  findCommerceFactsOfferForBackfill,
  findCommerceFactsForBackfill,
  enrichPayloadWithCommerceFacts,
  chooseRepresentativeProduct,
  processRow,
  buildSeedUpdatePayload,
  buildVariantSeedRows,
  comparableSeedData,
  normalizeComparableUrlKey,
  normalizeTargetUrlForMarket,
  recoverTargetUrlFromDiagnostics,
  parseDelimitedIds,
  sanitizeSeedImageUrls,
  sanitizeJsonForPostgres,
  sanitizeTextForPostgres,
  stringifyPostgresJsonb,
  validateNextRowImageHealth,
  hasNestedVariantImageSanitizationDelta,
  buildIdentityListingSourcePayload,
  collectBackfilledExternalProductIds,
  isDisplayableProductIntelKbRow,
  cleanPdpIngredientsRaw,
  choosePdpHowToUseRaw,
  extractHowToUseFromPdpText,
  isReviewPollutedPdpDetailsSection,
  normalizeDetailsSections,
  pickPdpIngredientsRaw,
  applyReviewedActiveIngredientContract,
  reapplyApprovedPdpIngredientFieldsToRow,
  serializeBackfillResult,
  writeBackfillReport,
} = require('../../scripts/backfill-external-product-seeds-catalog');

describe('backfill-external-product-seeds-catalog', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('parses external product id lists from comma or newline input', () => {
    expect(parseDelimitedIds('ext_a, ext_b\next_a\n\next_c')).toEqual(['ext_a', 'ext_b', 'ext_c']);
  });

  test('removes null bytes from JSON before postgres jsonb writes', () => {
    const sanitized = sanitizeJsonForPostgres({
      title: 'Shade\u0000and Illuminate',
      'bad\u0000key': 'value',
      wrapped: new String('Wrapped\u0000 value'),
      nested: {
        body: 'Clean\u0000 copy and literal \\u0000 escape',
        items: ['One\u0000', 'Two\\u0000'],
      },
    });

    expect(sanitized).toEqual({
      title: 'Shadeand Illuminate',
      badkey: 'value',
      wrapped: 'Wrapped value',
      nested: {
        body: 'Clean copy and literal  escape',
        items: ['One', 'Two'],
      },
    });
    expect(stringifyPostgresJsonb(sanitized)).not.toContain('\\u0000');
    expect(stringifyPostgresJsonb(sanitized)).not.toContain('\u0000');
  });

  test('removes null bytes from postgres text column values', () => {
    expect(sanitizeTextForPostgres('Ultra\u0000-Shine Lip Color \\u0000')).toBe(
      'Ultra-Shine Lip Color ',
    );
    expect(sanitizeTextForPostgres(null)).toBeNull();
  });

  test('collects updated external product ids for post-backfill Pivota Insights coverage', () => {
    expect(
      collectBackfilledExternalProductIds([
        { status: 'skipped', row: { external_product_id: 'ext_skipped' } },
        { status: 'updated', row: { external_product_id: 'ext_parent' } },
        {
          status: 'updated',
          row: { external_product_id: 'ext_parent' },
          payload: {
            variant_seed_rows: [
              { external_product_id: 'ext_child_a' },
              { external_product_id: 'ext_child_b' },
            ],
          },
        },
      ]),
    ).toEqual(['ext_parent', 'ext_child_a', 'ext_child_b']);
  });

  test('serializes dry-run results with authoritative snapshot summary', () => {
    const serialized = serializeBackfillResult({
      status: 'dry_run',
      row: {
        id: 'seed_1',
        external_product_id: 'ext_1',
        title: 'Ceramidin Cream',
        brand: 'Dr.Jart+',
        domain: 'drjart.com',
        canonical_url: 'https://www.drjart.com/product',
        seed_data: {
          external_seed_snapshot_contract: {
            authoritative: true,
            legacy_fields_quarantined: true,
          },
        },
      },
      payload: {
        changed: true,
        nextRow: {
          external_product_id: 'ext_1',
          title: 'Ceramidin Cream',
          image_url: 'https://www.drjart.com/image.png',
          canonical_url: 'https://www.drjart.com/product',
          seed_data: {
            image_urls: ['https://www.drjart.com/image.png'],
            pdp_details_sections: [{ heading: 'Overview', body: 'Barrier cream' }],
            pdp_faq_items: [{ question: 'Q1', answer: 'A1' }],
            pdp_how_to_use_raw: 'Apply morning and night.',
            pdp_ingredients_raw: 'Water, Glycerin',
            pdp_active_ingredients_raw: 'Ceramide NP',
            external_seed_snapshot_contract: {
              authoritative: true,
              legacy_fields_quarantined: true,
            },
          },
        },
      },
    });

    expect(serialized.payload.next_row_summary).toMatchObject({
      image_count: 1,
      details_section_count: 1,
      faq_count: 1,
      how_to_use_present: true,
      ingredients_present: true,
      active_ingredients_present: true,
    });
    expect(serialized.payload.next_row_summary.seed_snapshot_contract).toMatchObject({
      authoritative: true,
      legacy_fields_quarantined: true,
    });
  });

  test('writes backfill summary and per-row report artifacts', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-seed-backfill-report-'));
    const report = writeBackfillReport({
      outDir,
      options: {
        market: 'US',
        dryRun: true,
        externalProductIds: ['ext_1'],
        concurrency: 1,
      },
      rows: [{ id: 'seed_1' }],
      summary: { scanned: 1, dry_run: 1, updated: 0, skipped: 0, failed: 0 },
      results: [
        {
          status: 'dry_run',
          row: {
            id: 'seed_1',
            external_product_id: 'ext_1',
          },
          payload: {
            nextRow: {
              external_product_id: 'ext_1',
              seed_data: {
                image_urls: ['https://example.com/image.png'],
              },
            },
          },
        },
      ],
      insightsCoverage: { status: 'skipped', reason: 'dry_run' },
    });

    expect(report).toMatchObject({ result_count: 1 });
    expect(fs.existsSync(path.join(outDir, 'backfill-summary.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'backfill-results.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'rows', 'ext_1.json'))).toBe(true);
  });

  test('detects nested variant image pollution even when canonical gallery is already clean', () => {
    const productImage =
      'https://theordinary.com/dw/image/v2/BFKJ_PRD/on/demandware.static/-/Sites-deciem-master/default/dw0fd80738/Images/products/The%20Ordinary/product.png?sw=900&sh=900&sm=fit';
    const siteChromeImage =
      'https://theordinary.com/on/demandware.static/-/Library-Sites-DeciemSharedLibrary/default/dw665025d6/theordinary/homepage/slotA/heroes-slot-a-mobile.jpg';
    const logo =
      'https://theordinary.com/on/demandware.static/Sites-deciem-us-Site/-/default/dw7498968d/images/brands-logo/theOrdinary-logo.svg';

    expect(
      hasNestedVariantImageSanitizationDelta({
        image_urls: [productImage],
        variants: [
          {
            image_url: productImage,
            image_urls: [productImage, siteChromeImage, logo],
          },
        ],
        snapshot: {
          image_urls: [productImage],
          variants: [
            {
              image_url: productImage,
              image_urls: [productImage, siteChromeImage, logo],
            },
          ],
        },
      }),
    ).toBe(true);

    expect(
      hasNestedVariantImageSanitizationDelta({
        variants: [{ image_url: productImage, image_urls: [productImage] }],
        snapshot: { variants: [{ image_url: productImage, image_urls: [productImage] }] },
      }),
    ).toBe(false);
  });

  test('does not treat unreviewed limited product intel KB rows as displayable coverage', () => {
    const bundle = {
      contract_version: 'pivota.product_intel.v1',
      quality_state: 'limited',
      evidence_profile: 'seller_only',
      product_intel_core: {
        what_it_is: {
          headline: 'Treatment serum',
          body: 'A peptide lash and brow serum.',
        },
      },
    };

    expect(
      isDisplayableProductIntelKbRow({
        kb_key: 'product:ext_case',
        analysis: { product_intel_v1: bundle },
        source_meta: {
          selected_mode: 'baseline_only',
          quality_state: 'limited',
        },
      }),
    ).toBe(false);

    expect(
      isDisplayableProductIntelKbRow({
        kb_key: 'product:ext_case',
        analysis: { product_intel_v1: bundle },
        source_meta: {
          selected_mode: 'curated_override',
          review_status: 'completed',
          review_decision: 'seller_only_fallback',
          reviewer: 'Codex',
          reviewer_kind: 'assistant',
          reviewed_at: '2026-04-26T00:00:00.000Z',
        },
      }),
    ).toBe(true);
  });

  test('drops review-card heading siblings from PDP details sections', () => {
    const sections = normalizeDetailsSections([
      {
        heading: 'Benefits',
        body: 'Plumping\n\nElasticity\n\nHydrating',
        source_kind: 'shopify_body_html_labeled_section',
      },
      {
        heading: 'Deep Moisture',
        body: 'Tried this mask last night after a peel and it was very cooling and moisturizing.\n\n(opens in a new window)\n\nDeep Peptide Radiance Mask',
        source_kind: 'heading_sibling',
      },
      {
        heading: 'Love the hydration',
        body: 'They are perfect for long flights\n\nDeep Peptide Radiance Mask\n\nDeep Peptide Radiance Mask',
        source_kind: 'heading_sibling',
      },
    ]);

    expect(isReviewPollutedPdpDetailsSection('Deep Moisture', sections[0]?.body, 'heading_sibling')).toBe(false);
    expect(sections).toEqual([
      {
        heading: 'Benefits',
        body: 'Plumping\n\nElasticity\n\nHydrating',
        source_kind: 'shopify_body_html_labeled_section',
      },
    ]);
  });

  test('recovers complete numbered how-to steps from PDP description when extracted how-to starts at step 2', () => {
    const description = `Strengthening elasticity with just one sheet

How to use

1. Prep skin with toner after cleansing
2. After opening the mask, adjust to fit on face
3. Leave it on for 10-20 minutes and remove
4. Gently pat to enhance absorption

*Recommended to use along with Age-R Device
If used along with Age-R, the Peptide Mask acts as an energy conductor allowing effective elasticity care.

What's in it?

Contains four types of peptides`;
    const primary = `2. After opening the mask, adjust to fit on face
3. Leave it on for 10-20 minutes and remove
4. Gently pat to enhance absorption`;

    const fallback = extractHowToUseFromPdpText(description);
    expect(fallback).toContain('1. Prep skin with toner after cleansing');
    expect(fallback).not.toContain("What's in it");
    expect(choosePdpHowToUseRaw(primary, fallback)).toBe(fallback);
  });

  test('uses full PDP description how-to when short extractor usage starts at step 2', () => {
    const row = {
      id: 'eps_medicube_mask',
      title: 'Deep Peptide Radiance Mask',
      canonical_url: 'https://medicube.us/products/deep-peptide-radiance-mask',
      destination_url: 'https://medicube.us/products/deep-peptide-radiance-mask',
      image_url: '',
      price_amount: 18,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        pdp_how_to_use_raw: '2. After opening the mask, adjust to fit on face\n3. Leave it on for 10-20 minutes and remove',
        pdp_field_quality_summary: {
          how_to_use_raw: {
            source_quality_status: 'high',
            source_origin: 'shopify_json',
            source_kinds: ['shopify_body_html_labeled_how_to_use'],
          },
        },
        pdp_content_asset_v1: {
          contract_version: 'external_seed.pdp_content_asset.v1',
          fields: {
            how_to_use_raw: {
              review_state: 'assistant_reviewed',
            },
          },
        },
        snapshot: {},
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: row.title,
            url: row.canonical_url,
            description_raw: 'High-functioning peptide cream essence.',
            pdp_description_raw: `High-functioning peptide cream essence.

How to use

1. Prep skin with toner after cleansing
2. After opening the mask, adjust to fit on face
3. Leave it on for 10-20 minutes and remove
4. Gently pat to enhance absorption

What's in it?

Contains four types of peptides`,
            how_to_use_raw: '2. After opening the mask, adjust to fit on face\n3. Leave it on for 10-20 minutes and remove',
            field_quality_summary: {
              description_raw: { source_quality_status: 'high', source_kinds: ['shopify_description'] },
              how_to_use_raw: {
                source_quality_status: 'high',
                source_kinds: ['shopify_body_html_labeled_how_to_use'],
              },
            },
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      row.canonical_url,
    );

    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).toContain(
      '1. Prep skin with toner after cleansing',
    );
    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).not.toContain("What's in it");
    expect(payload.nextRow.seed_data.snapshot_quarantine?.preserved_candidates?.how_to_use_raw).toBeUndefined();
  });

  test('extracts full ingredients from mixed PDP detail section bodies', () => {
    const raw = pickPdpIngredientsRaw('', [
      {
        heading: 'Product Details',
        body:
          'A mix of jojoba, sunflower, and grapeseed oil come together to provide hydration without clogging pores. Full Ingredients: Water (Aqua/Eau), Helianthus Annuus (Sunflower) Seed Oil, Rosa Canina (Rosehip) Fruit Oil, Vitis Vinifera (Grape) Seed Oil, Butylene Glycol, 1,2-Hexanediol, Madecassoside. PETA-certified vegan and cruelty-free.',
      },
    ]);

    expect(raw).toBe(
      'Water (Aqua/Eau), Helianthus Annuus (Sunflower) Seed Oil, Rosa Canina (Rosehip) Fruit Oil, Vitis Vinifera (Grape) Seed Oil, Butylene Glycol, 1,2-Hexanediol, Madecassoside.',
    );
  });

  test('cleans HTML-wrapped full ingredients snippets before persistence', () => {
    const cleaned = cleanPdpIngredientsRaw(
      '<p><strong>Full Ingredients:</strong> Water (Aqua/Eau), Butylene Glycol, Caprylic/Capric Triglyceride, Squalane, 1,2-Hexanediol, Trehalose, Behenyl Alcohol, Avena Sativa (Oat) Meal Extract</p><p>PETA-certified vegan and cruelty-free.</p>',
    );

    expect(cleaned).toBe(
      'Water (Aqua/Eau), Butylene Glycol, Caprylic/Capric Triglyceride, Squalane, 1,2-Hexanediol, Trehalose, Behenyl Alcohol, Avena Sativa (Oat) Meal Extract',
    );
  });

  test('cleans Krave full ingredients without matching trailing prose mentions of ingredients', () => {
    const cleaned = cleanPdpIngredientsRaw(
      'Oat extract: Soothes irritation and rebalances stressed skin.\nTrehalose: Helps bind water to skin to retain moisture.\nSqualane: Improves skin hydration and reduces moisture loss.\n\nFull Ingredients: Water (Aqua/Eau), Butylene Glycol, Caprylic/Capric Triglyceride, Squalane, 1,2-Hexanediol, Trehalose, Behenyl Alcohol, Ammonium Acryloyldimethyltaurate/VP Copolymer, Avena Sativa (Oat) Meal Extract\n\nPETA-certified vegan and cruelty-free.\n\nThe color and texture of Oat So Simple Water Cream may naturally vary slightly from batch to batch. No worries! This is a normal occurrence when using naturally-derived ingredients and does not impact the efficacy of the formula.',
    );

    expect(cleaned).toBe(
      'Water (Aqua/Eau), Butylene Glycol, Caprylic/Capric Triglyceride, Squalane, 1,2-Hexanediol, Trehalose, Behenyl Alcohol, Ammonium Acryloyldimethyltaurate/VP Copolymer, Avena Sativa (Oat) Meal Extract',
    );
  });

  test('picks Krave Oil La La ingredients from real accordion copy', () => {
    const raw = pickPdpIngredientsRaw('', [
      {
        heading: 'Ingredients',
        body:
          '10% Upcycled Rosehip Oil: Packed with fatty acids, antioxidants, and vitamins A, C, & E to help improve overall skin texture for an even complexion.\nBlend of Non-Comedogenic, Nourishing Omega Fatty Oils: A mix of jojoba, sunflower, and grapeseed oil come together to provide hydration without clogging your pores.\nCicatide Complex: A blend of five skin-soothing peptides and madecassoside to help soothe redness and irritation commonly caused by acne.\nPurple Gromwell Root Extract: A powerful antioxidant with barrier repair properties.\n\nFull Ingredients: Water (Aqua/Eau), Helianthus Annuus (Sunflower) Seed Oil, Rosa Canina (Rosehip) Fruit Oil, Vitis Vinifera (Grape) Seed Oil, Butylene Glycol, 1,2-Hexanediol, Caprylic/Capric Triglyceride, Polyglyceryl-6 Stearate, Ethylhexyl Pelargonate, Simmondsia Chinensis (Jojoba) Seed Oil, Microcrystalline Cellulose, Sodium Stearoyl Glutamate, Polyglyceryl-6 Behenate, Sphingomonas Ferment Extract, Sodium Polyacryloyldimethyl Taurate, Pyrus Communis (Pear) Fruit Extract, Lecithin, Rosa Damascena (Bulgarian Rose) Flower Water, Hydrogenated Polydecene, Cellulose Gum, Ethylhexylglycerin, Iris Florentina (Florentine Iris) Root Extract, Cucumis Melo (Melon) Seed Extract, Hedera Helix (Ivy) Leaf/Stem Extract, Disodium EDTA, Acetyl Glutamine, Lithospermum Erythrorhizon (Purple Gromwell) Root Extract, Caprylyl/Capryl Glucoside, Camellia Sinensis (Green Tea) Leaf Water, Hydrolyzed Gardenia Florida Extract, Rosa Centifolia Flower Water, Madecassoside, sh-Polypeptide-9\n\nPETA-certified vegan and cruelty-free.',
      },
    ]);

    expect(raw.startsWith('Water (Aqua/Eau), Helianthus Annuus (Sunflower) Seed Oil')).toBe(true);
    expect(raw.includes('Madecassoside, sh-Polypeptide-9')).toBe(true);
  });

  test('filters broken image URLs before seed writes while preserving Shopify asset identity', async () => {
    jest
      .spyOn(axios, 'head')
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
      .mockResolvedValueOnce({
        status: 404,
        headers: { 'content-type': 'text/html' },
      });

    const validUrl =
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807';
    const brokenUrl =
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png';
    const siteChromeUrl =
      'https://theordinary.com/on/demandware.static/-/Library-Sites-DeciemSharedLibrary/default/dw665025d6/theordinary/homepage/slotA/heroes-slot-a-mobile.jpg';

    const result = await validateNextRowImageHealth({
      image_url: validUrl,
      seed_data: {
        image_url: validUrl,
        image_urls: [validUrl, brokenUrl],
        variants: [
          {
            sku: 'sku_1',
            image_url: validUrl,
            image_urls: [validUrl, siteChromeUrl],
          },
        ],
        snapshot: {
          image_urls: [validUrl, brokenUrl],
          variants: [
            {
              sku: 'sku_1',
              image_url: validUrl,
              image_urls: [validUrl, siteChromeUrl],
            },
          ],
        },
      },
    });

    expect(result.validation).toEqual(
      expect.objectContaining({
        status: 'filtered_broken_images',
        scanned_count: 2,
        valid_count: 1,
        broken_count: 1,
      }),
    );
    expect(result.nextRow.image_url).toBe(validUrl);
    expect(result.nextRow.seed_data.image_urls).toEqual([validUrl]);
    expect(result.nextRow.seed_data.variants[0].image_urls).toEqual([validUrl]);
    expect(result.nextRow.seed_data.snapshot.variants[0].image_urls).toEqual([validUrl]);
    expect(result.nextRow.seed_data.snapshot.diagnostics.image_health_validation.status).toBe(
      'filtered_broken_images',
    );
  });

  test('reuses image health probes for duplicate URLs across rows', async () => {
    const headSpy = jest.spyOn(axios, 'head').mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
    const imageUrl = 'https://cdn.example.com/cache-test-product.jpg';

    await validateNextRowImageHealth({
      image_url: imageUrl,
      seed_data: { image_url: imageUrl, image_urls: [imageUrl] },
    });
    await validateNextRowImageHealth({
      image_url: imageUrl,
      seed_data: { image_url: imageUrl, image_urls: [imageUrl] },
    });

    expect(headSpy).toHaveBeenCalledTimes(1);
  });

  test('sanitizes decorative image URLs without stripping versioned Shopify assets', () => {
    expect(
      sanitizeSeedImageUrls([
        'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
        'https://www.tomfordbeauty.com/cdn/shop/files/Menu.svg?v=1771253635&width=24',
        'https://www.rarebeauty.com/cdn/shop/files/gnav-shop-fragrance-fa25_1024x.png?v=1753828599',
        'https://www.rarebeauty.com/cdn/shop/files/SHADE-FINDER-HERO-MIDDLE_1024x.jpg?v=1613736184',
        'https://theordinary.com/on/demandware.static/-/Library-Sites-DeciemSharedLibrary/default/dw665025d6/theordinary/homepage/slotA/heroes-slot-a-mobile.jpg',
        'https://theordinary.com/on/demandware.static/Sites-deciem-us-Site/-/default/dw6a974392/images/theordinary/navbar-email-signup-popup-img-TO.png',
        'https://theordinary.com/en-us/iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAAXNSR0IB2cksfwAAAAlwSFlzAAALEwAACxMBAJqcGAAAAANQTFRF+Pj4c64OKQAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAASUVORK5CYII=',
        'https://theordinary.com/dw/image/v2/BFKJ_PRD/on/demandware.static/-/Sites-deciem-master/default/dw0fd80738/Images/products/The%20Ordinary/rdn-multi-peptide-lash-and-brow-serum-eu-5ml.png?sw=900&sh=900&sm=fit',
        'https://theordinary.com/dw/image/v2/BFKJ_PRD/on/demandware.static/-/Sites-deciem-master/default/dw0fd80738/Images/products/The%20Ordinary/rdn-multi-peptide-lash-and-brow-serum-eu-5ml.png?sw=860&sh=860&sm=fit',
      ]),
    ).toEqual([
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
      'https://theordinary.com/dw/image/v2/BFKJ_PRD/on/demandware.static/-/Sites-deciem-master/default/dw0fd80738/Images/products/The%20Ordinary/rdn-multi-peptide-lash-and-brow-serum-eu-5ml.png?sw=900&sh=900&sm=fit',
    ]);
  });

  test('drops sibling product-type gallery images for single-product PDPs', () => {
    expect(
      sanitizeSeedImageUrls(
        [
          'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
          'https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-1268x1268_%7Bwidth%7Dx.jpg?v=1740424675',
          'https://www.rarebeauty.com/cdn/shop/files/ECOMM-FIND-COMFORT-BODY-LOTION-MINI-CLOSED_1024x.jpg?v=1762301243',
          'https://www.rarebeauty.com/cdn/shop/files/ECOMM-FIND-COMFORT-EXFOLIATING-BODY-WASH-MINI_1024x.jpg?v=1762301245',
          'https://www.rarebeauty.com/cdn/shop/files/find-comfort-aromatherapy-pen-closed-1440x1952_1024x.jpg?v=1762289703',
          'https://www.rarebeauty.com/cdn/shop/files/ECOMM-FIND-COMFORT-UNDER-EYE-PATCHES-8P_1024x.jpg?v=1762291431',
        ],
        {
          productTitle: 'Find Comfort Body & Hair Fragrance Mist Mini',
          productUrl: 'https://rarebeauty.com/products/find-comfort-body-hair-fragrance-mist-mini',
        },
      ),
    ).toEqual([
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
    ]);
  });

  test('keeps mixed product-type images for bundle-like PDPs', () => {
    expect(
      sanitizeSeedImageUrls(
        [
          'https://www.rarebeauty.com/cdn/shop/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED_1024x.jpg?v=1762301243',
          'https://www.rarebeauty.com/cdn/shop/files/ECOMM-FIND-COMFORT-BODY-LOTION-MINI-CLOSED_1024x.jpg?v=1762301243',
          'https://www.rarebeauty.com/cdn/shop/files/ECOMM-FIND-COMFORT-EXFOLIATING-BODY-WASH-MINI_1024x.jpg?v=1762301245',
          'https://www.rarebeauty.com/cdn/shop/files/SCENT-AWAKEN-CONFIDENCE-BODY-COLLECTION_89331bc8-aca5-4b0e-af1d-a33b663ec690.jpg?v=1732569750',
          'https://www.rarebeauty.com/cdn/shop/files/pdp-bundle-thumbnail-fc-body-lotion-180x180_1024x.jpg?v=1709669070',
        ],
        {
          productTitle: 'Find Comfort Mini Discovery Set',
          productUrl: 'https://rarebeauty.com/products/find-comfort-mini-discovery-set',
        },
      ),
    ).toEqual([
      'https://www.rarebeauty.com/cdn/shop/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED_1024x.jpg?v=1762301243',
      'https://www.rarebeauty.com/cdn/shop/files/ECOMM-FIND-COMFORT-BODY-LOTION-MINI-CLOSED_1024x.jpg?v=1762301243',
      'https://www.rarebeauty.com/cdn/shop/files/ECOMM-FIND-COMFORT-EXFOLIATING-BODY-WASH-MINI_1024x.jpg?v=1762301245',
      'https://www.rarebeauty.com/cdn/shop/files/SCENT-AWAKEN-CONFIDENCE-BODY-COLLECTION_89331bc8-aca5-4b0e-af1d-a33b663ec690.jpg?v=1732569750',
      'https://www.rarebeauty.com/cdn/shop/files/pdp-bundle-thumbnail-fc-body-lotion-180x180_1024x.jpg?v=1709669070',
    ]);
  });

  test('drops collection and bundle thumbnail images for single-product PDPs', () => {
    expect(
      sanitizeSeedImageUrls(
        [
          'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/find-comfort-body-lotion-closed-1440x1952.jpg?v=1762289702',
          'https://www.rarebeauty.com/cdn/shop/files/imperfect-circle-find-comfort-collection-800x864_1024x.png?v=1701811855',
          'https://www.rarebeauty.com/cdn/shop/files/pdp-bundle-thumbnail-fc-body-lotion-180x180_1024x.jpg?v=1709669070',
          'https://www.rarebeauty.com/cdn/shop/files/find-comfort-body-lotion-pump-01-1440x1952_120x120_crop_center.jpg?v=1762291295',
        ],
        {
          productTitle: 'Find Comfort Hydrating Body Lotion',
          productUrl: 'https://rarebeauty.com/products/find-comfort-hydrating-body-lotion',
        },
      ),
    ).toEqual([
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/find-comfort-body-lotion-closed-1440x1952.jpg?v=1762289702',
    ]);
  });

  test('preserves non-Rare collection-labeled product assets', () => {
    expect(
      sanitizeSeedImageUrls(
        [
          'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_FALL25_T2PRODUCT_ARMSWATCH_LE-DIAMOND-COLLECTION_DIAMONDBOMB_1200X1500_72DPI.jpg?v=1760673649',
          'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_FALL25_T2PRODUCT_ECOMM_LE-DIAMOND-COLLECTION_DIAMOND-BOMB_PINK-ICE_1200X1500_72DPI.jpg?v=1753918000',
        ],
        {
          productTitle: 'Diamond Bomb All-Over Diamond Veil',
          productUrl: 'https://fentybeauty.com/products/diamond-bomb-all-over-diamond-veil-pink-ice',
        },
      ),
    ).toEqual([
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_FALL25_T2PRODUCT_ARMSWATCH_LE-DIAMOND-COLLECTION_DIAMONDBOMB_1200X1500_72DPI.jpg?v=1760673649',
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_FALL25_T2PRODUCT_ECOMM_LE-DIAMOND-COLLECTION_DIAMOND-BOMB_PINK-ICE_1200X1500_72DPI.jpg?v=1753918000',
    ]);
  });

  test('preserves Pixi collection-labeled PDP infographic assets', () => {
    expect(
      sanitizeSeedImageUrls(
        [
          'https://cdn.shopify.com/s/files/1/1463/5858/files/GlowMist-80ml-25JUL23-CloseLid-web.jpg?v=1768348335',
          'https://cdn.shopify.com/s/files/1/1463/5858/files/pixi_skintreats_glowmist_collection_may_2020_2.jpg?v=1768348335',
        ],
        {
          productTitle: 'Glow Mist',
          productUrl: 'https://pixibeauty.com/products/glow-mist',
        },
      ),
    ).toEqual([
      'https://cdn.shopify.com/s/files/1/1463/5858/files/GlowMist-80ml-25JUL23-CloseLid-web.jpg?v=1768348335',
      'https://cdn.shopify.com/s/files/1/1463/5858/files/pixi_skintreats_glowmist_collection_may_2020_2.jpg?v=1768348335',
    ]);
  });

  test('filters Ole Henriksen ingredient infographic assets out of gallery candidates', () => {
    expect(
      sanitizeSeedImageUrls(
        [
          'https://cdn.shopify.com/s/files/1/0615/7785/5148/files/OH_SILO_PEACH_GLAZE_MIST_1500x1500_72DPI.jpg?v=1747952076',
          'https://cdn.shopify.com/s/files/1/0615/7785/5148/files/OH869600_PEACH_PeachGlazePlumpingTrio_PPageInfographics_Collection_INGREDIENT_1500x1500_72DPI_128a3f5a-2e86-4159-a54e-0b62de3b6fb9.jpg?v=1763962328',
        ],
        {
          productTitle: 'Peach Glaze Glow Mist',
          productUrl: 'https://olehenriksen.com/products/peach-glaze-glow-mist',
        },
      ),
    ).toEqual([
      'https://cdn.shopify.com/s/files/1/0615/7785/5148/files/OH_SILO_PEACH_GLAZE_MIST_1500x1500_72DPI.jpg?v=1747952076',
    ]);
  });

  test('filters Ole Henriksen navigation and promo assets from recovered gallery candidates', () => {
    expect(
      sanitizeSeedImageUrls(
        [
          'https://olehenriksen.com/cdn/shop/files/BananaBrightSunscreen_Silo_1500x.jpg?v=1686956927',
          'https://cdn.shopify.com/s/files/1/0615/7785/5148/products/S2677607-av-04.jpg?v=1721258800',
          'https://cdn.shopify.com/s/files/1/0615/7785/5148/files/BBSPF_PPAGE_2000x2000_300DPI.jpg?v=1747671491',
          'https://olehenriksen.com/cdn/shop/files/HEADER_MEGA_NAV_MOBILE_893050a5-ef11-4e5c-92a6-ff2141f7f524_750x.jpg?v=1773700179',
          'https://olehenriksen.com/cdn/shop/files/PROMO_TILE_2_-_READ_THE_BLOG_750x.jpg?v=1659480894',
          'https://olehenriksen.com/cdn/shop/files/GC_ICONS_MORNING-GLOW-BUNDLE_750x.jpg?v=1755816354',
        ],
        {
          productTitle: 'Banana Bright Mineral Sunscreen SPF 30',
          productUrl: 'https://olehenriksen.com/products/banana-bright-mineral-sunscreen-spf-30',
        },
      ),
    ).toEqual([
      'https://olehenriksen.com/cdn/shop/files/BananaBrightSunscreen_Silo_1500x.jpg?v=1686956927',
      'https://cdn.shopify.com/s/files/1/0615/7785/5148/products/S2677607-av-04.jpg?v=1721258800',
    ]);
  });

  test('preserves Murad collection-labeled carousel assets', () => {
    expect(
      sanitizeSeedImageUrls(
        [
          'https://cdn.shopify.com/s/files/1/0816/7705/8351/files/673700_Sensitive_Skin_Collection_Face_Cleanser_SiteAsset_Murad_Carousel_1_Soldier.png?v=1762439971',
          'https://cdn.shopify.com/s/files/1/0816/7705/8351/files/673700_Sensitive_Skin_Collection_Face_Cleanser_SiteAsset_Murad_Carousel_2_Benefit.jpg?v=1729220920',
        ],
        {
          productTitle: 'Heartleaf Soothing Face Cleanser for Sensitive and Eczema-Prone Skin',
          productUrl: 'https://www.murad.com/products/heartleaf-soothing-cleanser',
        },
      ),
    ).toEqual([
      'https://cdn.shopify.com/s/files/1/0816/7705/8351/files/673700_Sensitive_Skin_Collection_Face_Cleanser_SiteAsset_Murad_Carousel_1_Soldier.png?v=1762439971',
      'https://cdn.shopify.com/s/files/1/0816/7705/8351/files/673700_Sensitive_Skin_Collection_Face_Cleanser_SiteAsset_Murad_Carousel_2_Benefit.jpg?v=1729220920',
    ]);
  });

  test('drops explicit fullgroup and bulk collection assets outside Rare', () => {
    expect(
      sanitizeSeedImageUrls(
        [
          'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FU_SPR24_T2PRODUCT_EDITORIAL_LE_SMURFSCOLLECTION_FULLGROUP_1200X1500_72DPI.jpg?v=1750272253',
          'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_FALL25_T2PRODUCT_EDITORIAL_DIAMOND-COLLECTION_GROUPSHOT_1200X1500_72DPI.jpg?v=1753223741',
          'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_SPR26_T2PRODUCT_EDITORIAL_LE_WATTAMOMENT_COLLECTION_GLOSSBOMB_WATTABRAT_WATABTCH_BULK_20PRODUCT_1200X1500_72DPI.jpg?v=1769721467',
          'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_FALL25_T2PRODUCT_ECOMM_LE-DIAMOND-COLLECTION_DIAMOND-BOMB_PINK-ICE_1200X1500_72DPI.jpg?v=1753918000',
        ],
        {
          productTitle: 'Diamond Bomb All-Over Diamond Veil',
          productUrl: 'https://fentybeauty.com/products/diamond-bomb-all-over-diamond-veil-pink-ice',
        },
      ),
    ).toEqual([
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_FALL25_T2PRODUCT_ECOMM_LE-DIAMOND-COLLECTION_DIAMOND-BOMB_PINK-ICE_1200X1500_72DPI.jpg?v=1753918000',
    ]);
  });

  test('prefers canonical URL when building extract target', () => {
    const row = {
      canonical_url: 'https://example.com/p/canonical-product',
      destination_url: 'https://example.com/p/destination-product',
      seed_data: {
        canonical_url: 'https://example.com/p/fallback-canonical',
      },
    };

    expect(pickSeedTargetUrl(row)).toBe('https://example.com/p/canonical-product');
  });

  test('prefers variant destination URL for expanded exact-item seeds', () => {
    const row = {
      canonical_url: 'https://example.com/products/pro-c-serum',
      destination_url: 'https://example.com/products/pro-c-serum?variant=42771629506608',
      seed_data: {
        source_listing_scope: 'variant',
        parent_external_product_id: 'ext_parent',
        selected_variant_id: '42771629506608',
        snapshot: {
          canonical_url: 'https://example.com/products/pro-c-serum',
          destination_url: 'https://example.com/products/pro-c-serum?variant=42771629506608',
        },
      },
    };

    expect(pickSeedTargetUrl(row)).toBe('https://example.com/products/pro-c-serum?variant=42771629506608');
  });

  test('passes the seed market through to catalog-intelligence', () => {
    const row = {
      id: 'eps_theordinary_1',
      market: 'us',
      domain: 'theordinary.com',
      title: 'UV Filters SPF 45 Serum',
      seed_data: {
        brand: 'The Ordinary',
      },
    };

    expect(buildExtractRequestBody('https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html', row)).toEqual({
      brand: 'The Ordinary',
      domain: 'https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html',
      limit: 50,
      market: 'US',
    });
  });

  test('normalizes duplicate Shopify direct PDP suffixes in extract request targets without stripping semantic numbers', () => {
    const row = {
      brand: 'Anua',
      market: 'US',
      title: 'PDRN 100 Hyaluronic Acid Glow Pad',
      canonical_url: 'https://anua.com/products/pdrn-100-hyaluronic-acid-glow-pad-1',
      destination_url: 'https://anua.com/products/pdrn-100-hyaluronic-acid-glow-pad-1',
      seed_data: {
        snapshot: {
          canonical_url: 'https://anua.com/products/pdrn-100-hyaluronic-acid-glow-pad-1',
          title: 'PDRN 100 Hyaluronic Acid Glow Pad',
        },
      },
    };

    expect(
      buildExtractRequestBody(
        'https://anua.com/products/pdrn-100-hyaluronic-acid-glow-pad-1',
        row,
      ),
    ).toEqual({
      brand: 'Anua',
      domain: 'https://anua.com/products/pdrn-100-hyaluronic-acid-glow-pad',
      limit: 50,
      market: 'US',
    });

    expect(
      buildExtractRequestBody(
        'https://anua.com/products/zero-cast-moisturizing-sunscreen-spf-50',
        {
          ...row,
          title: 'Zero-Cast Moisturizing Sunscreen SPF 50',
        },
      ).domain,
    ).toBe('https://anua.com/products/zero-cast-moisturizing-sunscreen-spf-50');
  });

  test('matches extract-v2 commerce facts and gates US currency mismatches during dry-run enrichment', () => {
    const row = {
      id: 'eps_boj_calming',
      external_product_id: 'ext_boj_calming',
      market: 'US',
      title: 'Calming Serum',
      canonical_url: 'https://beautyofjoseon.com/products/calming-serum',
      destination_url: 'https://beautyofjoseon.com/products/calming-serum',
      image_url: 'https://cdn.example.com/calming.jpg',
      price_amount: 17,
      price_currency: 'EUR',
      availability: 'in_stock',
      seed_data: {
        title: 'Calming Serum',
        snapshot: {
          canonical_url: 'https://beautyofjoseon.com/products/calming-serum',
        },
      },
    };
    const rawFacts = {
      contract_version: 'commerce_facts.v1',
      market_id: 'US',
      currency_target: 'USD',
      regional_price: {
        amount: 17,
        currency: 'EUR',
        observed_currency: 'EUR',
        confidence: 'medium',
        market_switch_status: 'mismatch',
      },
      availability: { status: 'in_stock', confidence: 'medium' },
      shipping: { status: 'unknown', confidence: 'unknown' },
      promotions: [],
      returns: { status: 'unknown', confidence: 'unknown' },
    };
    const responseV2 = {
      offers_v2: [
        {
          url_canonical: 'https://beautyofjoseon.com/products/calming-serum',
          product_title: 'Calming Serum',
          commerce_facts_v1: rawFacts,
        },
      ],
    };

    expect(findCommerceFactsForBackfill(row, row, responseV2)).toBe(rawFacts);
    const payload = enrichPayloadWithCommerceFacts({
      row,
      payload: { changed: false, nextRow: row },
      responseV2,
      market: 'US',
    });

    expect(payload.changed).toBe(true);
    expect(payload.nextRow.seed_data.commerce_facts_v1.regional_price.currency).toBe('EUR');
    expect(payload.commerce_facts_v2.gate).toEqual(
      expect.objectContaining({
        status: 'hold',
        expected_currency: 'USD',
        observed_currency: 'EUR',
      }),
    );
    expect(payload.commerce_facts_v2.gate.problems).toEqual(
      expect.arrayContaining(['market_currency_mismatch', 'commerce_facts_currency_mismatch']),
    );
  });

  test('matches commerce facts offers when stored Shopify canonical uses a duplicate suffix', () => {
    const row = {
      title: 'PDRN 100 Hyaluronic Acid Glow Pad',
      canonical_url: 'https://anua.com/products/pdrn-100-hyaluronic-acid-glow-pad-1',
      destination_url: 'https://anua.com/products/pdrn-100-hyaluronic-acid-glow-pad-1',
      seed_data: {
        title: 'PDRN 100 Hyaluronic Acid Glow Pad',
        snapshot: {
          title: 'PDRN 100 Hyaluronic Acid Glow Pad',
          canonical_url: 'https://anua.com/products/pdrn-100-hyaluronic-acid-glow-pad-1',
        },
      },
    };
    const rawFacts = {
      contract_version: 'commerce_facts.v1',
      market_id: 'US',
      currency_target: 'USD',
      regional_price: {
        amount: 23,
        currency: 'USD',
        observed_currency: 'USD',
        confidence: 'medium',
        market_switch_status: 'ok',
      },
      availability: { status: 'in_stock', confidence: 'medium' },
      shipping: { status: 'unknown', confidence: 'unknown' },
      promotions: [],
      returns: { status: 'unknown', confidence: 'unknown' },
    };

    expect(
      findCommerceFactsForBackfill(row, row, {
        offers_v2: [
          {
            url_canonical: 'https://anua.com/products/pdrn-100-hyaluronic-acid-glow-pad',
            product_title: 'PDRN 100 Hyaluronic Acid Glow Pad',
            commerce_facts_v1: rawFacts,
          },
        ],
      }),
    ).toBe(rawFacts);
  });

  test('prefers matching parent PDP offer over alternate pack sku when commerce facts contain multiple same-title offers', () => {
    const row = {
      id: 'eps_oil_lala',
      external_product_id: 'ext_oil_lala',
      market: 'US',
      title: 'Oil La La',
      canonical_url: 'https://kravebeauty.com/products/oil-la-la',
      destination_url: 'https://kravebeauty.com/products/oil-la-la',
      image_url: 'https://cdn.example.com/oil-la-la.png',
      price_amount: 28,
      price_currency: 'EUR',
      availability: 'in_stock',
      seed_data: {
        title: 'Oil La La',
        variants: [
          {
            sku: 'K105-01-0000-EU',
            variant_id: '40070946979915',
            option_value: '1 Pack - 45 mL',
            price: '28.00',
            currency: 'EUR',
            stock: 'In Stock',
          },
          {
            sku: 'K250-00-0000',
            variant_id: '40070946979916',
            option_value: '2 Pack - 2x45 mL',
            price: '50.00',
            currency: 'EUR',
            stock: 'In Stock',
          },
        ],
        snapshot: {
          title: 'Oil La La',
          canonical_url: 'https://kravebeauty.com/products/oil-la-la',
          price_amount: 28,
          price_currency: 'EUR',
          variants: [
            {
              sku: 'K105-01-0000-EU',
              variant_id: '40070946979915',
              option_value: '1 Pack - 45 mL',
              price: '28.00',
              currency: 'EUR',
              stock: 'In Stock',
            },
            {
              sku: 'K250-00-0000',
              variant_id: '40070946979916',
              option_value: '2 Pack - 2x45 mL',
              price: '50.00',
              currency: 'EUR',
              stock: 'In Stock',
            },
          ],
        },
      },
    };
    const onePackFacts = {
      contract_version: 'commerce_facts.v1',
      market_id: 'US',
      currency_target: 'USD',
      regional_price: {
        amount: 28,
        currency: 'USD',
        observed_currency: 'USD',
        display_raw: '28.00',
        confidence: 'medium',
        market_switch_status: 'ok',
      },
      availability: { status: 'in_stock', confidence: 'medium' },
      shipping: { status: 'unknown', confidence: 'unknown' },
      promotions: [],
      returns: { status: 'unknown', confidence: 'unknown' },
    };
    const twoPackFacts = {
      contract_version: 'commerce_facts.v1',
      market_id: 'US',
      currency_target: 'USD',
      regional_price: {
        amount: 50,
        currency: 'USD',
        observed_currency: 'USD',
        display_raw: '50.00',
        compare_at_amount: 56,
        compare_at_currency: 'USD',
        confidence: 'medium',
        market_switch_status: 'ok',
      },
      availability: { status: 'in_stock', confidence: 'medium' },
      shipping: { status: 'unknown', confidence: 'unknown' },
      promotions: [],
      returns: { status: 'unknown', confidence: 'unknown' },
    };
    const responseV2 = {
      offers_v2: [
        {
          url_canonical: 'https://kravebeauty.com/products/duo-oil-la-la',
          product_title: 'Duo Oil La La',
          variant_sku: 'K250-00-0000',
          commerce_facts_v1: twoPackFacts,
        },
        {
          url_canonical: 'https://kravebeauty.com/products/oil-la-la',
          product_title: 'Oil La La',
          variant_sku: 'K105-01-0000-EU',
          commerce_facts_v1: onePackFacts,
        },
        {
          url_canonical: 'https://kravebeauty.com/products/oil-la-la',
          product_title: 'Oil La La',
          variant_sku: 'K250-00-0000',
          commerce_facts_v1: twoPackFacts,
        },
      ],
    };

    expect(findCommerceFactsOfferForBackfill(row, row, responseV2)).toMatchObject({
      url_canonical: 'https://kravebeauty.com/products/oil-la-la',
      variant_sku: 'K105-01-0000-EU',
      commerce_facts_v1: onePackFacts,
    });
    expect(findCommerceFactsForBackfill(row, row, responseV2)).toBe(onePackFacts);

    const payload = enrichPayloadWithCommerceFacts({
      row,
      payload: { changed: false, nextRow: row },
      responseV2,
      market: 'US',
    });

    expect(payload.commerce_facts_v2.gate.status).toBe('pass');
    expect(payload.nextRow.price_amount).toBe(28);
    expect(payload.nextRow.price_currency).toBe('USD');
    expect(payload.nextRow.seed_data.snapshot.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sku: 'K105-01-0000-EU',
          price: '28.00',
          currency: 'USD',
        }),
        expect.objectContaining({
          sku: 'K250-00-0000',
          price: '50.00',
          currency: 'USD',
        }),
      ]),
    );
  });

  test('buildSeedUpdatePayload quarantines low-quality PDP fields instead of persisting them to snapshot', () => {
    const row = {
      id: 'eps_quarantine_1',
      title: 'Glow Pad',
      canonical_url: 'https://example.com/products/glow-pad',
      destination_url: 'https://example.com/products/glow-pad',
      image_url: '',
      price_amount: 23,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Example',
        pdp_description_raw: 'Legacy fallback description',
        pdp_ingredients_raw: 'Legacy ingredients',
        snapshot: {
          title: 'Glow Pad',
          canonical_url: 'https://example.com/products/glow-pad',
          pdp_description_raw: 'Legacy fallback description',
          pdp_ingredients_raw: 'Legacy ingredients',
        },
      },
    };

    const response = {
      mode: 'puppeteer',
      diagnostics: {},
      products: [
        {
          title: 'Glow Pad',
          url: 'https://example.com/products/glow-pad',
          image_url: 'https://cdn.example.com/glow-pad.jpg',
          image_urls: ['https://cdn.example.com/glow-pad.jpg'],
          variant_skus: ['GP-001'],
          variants: [
            {
              id: 'v1',
              sku: 'GP-001',
              url: 'https://example.com/products/glow-pad',
              option_name: 'Title',
              option_value: 'Default Title',
              price: '23.00',
              currency: 'USD',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/glow-pad.jpg',
              image_urls: ['https://cdn.example.com/glow-pad.jpg'],
            },
          ],
          field_quality_summary: {
            description_raw: {
              source_origin: 'browser_fallback',
              source_quality_status: 'quarantined',
              source_kinds: ['browser_fallback:description_raw'],
              reason_codes: ['quarantined_source_kind'],
            },
            details_sections: {
              source_origin: 'browser_fallback',
              source_quality_status: 'quarantined',
              source_kinds: ['browser_fallback:details_sections'],
              reason_codes: ['quarantined_source_kind'],
            },
            ingredients_raw: {
              source_origin: 'image_vision',
              source_quality_status: 'quarantined',
              source_kinds: ['product_image_vision'],
              reason_codes: ['quarantined_source_kind'],
            },
            active_ingredients_raw: {
              source_origin: 'image_vision',
              source_quality_status: 'quarantined',
              source_kinds: ['product_image_vision'],
              reason_codes: ['quarantined_source_kind'],
            },
            how_to_use_raw: {
              source_origin: 'browser_fallback',
              source_quality_status: 'quarantined',
              source_kinds: ['browser_fallback:how_to_use_raw'],
              reason_codes: ['quarantined_source_kind'],
            },
            faq_items: {
              source_origin: 'browser_fallback',
              source_quality_status: 'quarantined',
              source_kinds: ['browser_fallback:faq_items'],
              reason_codes: ['quarantined_source_kind'],
            },
          },
          quarantined_pdp_fields: {
            description_raw: 'Fallback description from browser scrape.',
            details_sections: [
              { heading: 'Benefits', body: 'Recovered from browser fallback.' },
            ],
            ingredients_raw: 'Water, Glycerin, Niacinamide',
            active_ingredients_raw: 'Niacinamide',
            how_to_use_raw: 'Apply after cleansing.',
            faq_items: [
              { question: 'Can I use this daily?', answer: 'Yes.' },
            ],
          },
        },
      ],
      variants: [],
    };

    const payload = buildSeedUpdatePayload(row, response, row.destination_url);

    expect(payload.nextRow.seed_data.pdp_description_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.pdp_ingredients_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.pdp_description_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.pdp_ingredients_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.pdp_field_quality_summary.description_raw.source_quality_status).toBe('quarantined');
    expect(payload.nextRow.seed_data.snapshot_quarantine).toEqual(
      expect.objectContaining({
        contract_version: 'external_seed.snapshot_quarantine.v1',
        extractor_mode: 'puppeteer',
      }),
    );
    expect(payload.nextRow.seed_data.snapshot_quarantine.fields.description_raw).toBe(
      'Fallback description from browser scrape.',
    );
    expect(payload.nextRow.seed_data.snapshot_quarantine.fields.ingredients_raw).toBe(
      'Water, Glycerin, Niacinamide',
    );
  });

  test('buildSeedUpdatePayload strips legacy variant shadow containers while preserving approved variants', () => {
    const row = {
      id: 'eps_variant_shadow_cleanup',
      title: 'Cream Skin Toner & Moisturizer',
      canonical_url: 'https://us.laneige.com/products/cream-skin-toner-moisturizer',
      destination_url: 'https://us.laneige.com/products/cream-skin-toner-moisturizer',
      image_url: 'https://cdn.example.com/cream-skin.jpg',
      price_amount: 36,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        variants: [{ sku: 'legacy-root-1', option_name: 'Title', option_value: 'Default Title' }],
        skus: [{ sku: 'legacy-root-sku' }],
        variantOptions: [{ name: 'Title', values: ['Default Title'] }],
        product: {
          variants: [{ sku: 'legacy-root-product-variant' }],
          choices: [{ name: 'Title', values: ['Default Title'] }],
        },
        snapshot_quarantine: {
          contract_version: 'external_seed.snapshot_quarantine.v1',
          fields: { description_raw: 'old fallback' },
        },
        snapshot: {
          canonical_url: 'https://us.laneige.com/products/cream-skin-toner-moisturizer',
          skus: [{ sku: 'legacy-snapshot-sku' }],
          variant_options: [{ name: 'Title', values: ['Default Title'] }],
          product: {
            variants: [{ sku: 'legacy-snapshot-product-variant' }],
            skus: [{ sku: 'legacy-snapshot-product-sku' }],
          },
          snapshot_quarantine: {
            contract_version: 'external_seed.snapshot_quarantine.v1',
            fields: { faq_items: [{ question: 'Help', answer: 'Fallback' }] },
          },
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        mode: 'puppeteer',
        diagnostics: {},
        products: [
          {
            title: 'Cream Skin Toner & Moisturizer',
            url: 'https://us.laneige.com/products/cream-skin-toner-moisturizer',
            image_url: 'https://cdn.example.com/cream-skin.jpg',
            image_urls: ['https://cdn.example.com/cream-skin.jpg'],
            variants: [
              {
                id: 'v170',
                sku: '170ML',
                url: 'https://us.laneige.com/products/cream-skin-toner-moisturizer',
                option_name: 'Size',
                option_value: '170mL',
                price: '36.00',
                currency: 'USD',
                stock: 'In Stock',
                image_url: 'https://cdn.example.com/cream-skin.jpg',
                image_urls: ['https://cdn.example.com/cream-skin.jpg'],
              },
              {
                id: 'v320',
                sku: '320ML',
                url: 'https://us.laneige.com/products/cream-skin-toner-moisturizer',
                option_name: 'Size',
                option_value: '320mL',
                price: '48.00',
                currency: 'USD',
                stock: 'In Stock',
                image_url: 'https://cdn.example.com/cream-skin.jpg',
                image_urls: ['https://cdn.example.com/cream-skin.jpg'],
              },
            ],
          },
        ],
        variants: [],
      },
      row.destination_url,
    );

    expect(payload.nextRow.seed_data.variants).toHaveLength(2);
    expect(payload.nextRow.seed_data.snapshot.variants).toHaveLength(2);
    expect(payload.nextRow.seed_data.skus).toBeUndefined();
    expect(payload.nextRow.seed_data.variantOptions).toBeUndefined();
    expect(payload.nextRow.seed_data.product?.variants).toBeUndefined();
    expect(payload.nextRow.seed_data.product?.choices).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.skus).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.variant_options).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.product?.variants).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.product?.skus).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.snapshot_quarantine).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot_quarantine).toEqual(
      expect.objectContaining({
        contract_version: 'external_seed.snapshot_quarantine.v1',
      }),
    );
  });

  test('buildSeedUpdatePayload clears stale synthetic legacy descriptions when extractor cannot recover approved copy', () => {
    const row = {
      id: 'eps_synthetic_cleanup',
      title: 'Fallback Serum',
      canonical_url: 'https://example.com/products/fallback-serum',
      destination_url: 'https://example.com/products/fallback-serum',
      image_url: 'https://cdn.example.com/fallback-serum.jpg',
      price_amount: 29,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        description: 'OFFICIAL: Hydrating serum. /// SOCIAL HIGHLIGHTS: customer service.',
        seed_description_origin: 'synthetic_summary',
        snapshot: {
          canonical_url: 'https://example.com/products/fallback-serum',
          description: 'OFFICIAL: Hydrating serum. /// SOCIAL HIGHLIGHTS: customer service.',
          seed_description_origin: 'synthetic_summary',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        mode: 'puppeteer',
        diagnostics: {},
        products: [
          {
            title: 'Fallback Serum',
            url: 'https://example.com/products/fallback-serum',
            image_url: 'https://cdn.example.com/fallback-serum.jpg',
            image_urls: ['https://cdn.example.com/fallback-serum.jpg'],
            variants: [
              {
                id: 'v1',
                sku: 'SERUM-1',
                url: 'https://example.com/products/fallback-serum',
                option_name: 'Title',
                option_value: 'Default Title',
                price: '29.00',
                currency: 'USD',
                stock: 'In Stock',
                image_url: 'https://cdn.example.com/fallback-serum.jpg',
                image_urls: ['https://cdn.example.com/fallback-serum.jpg'],
              },
            ],
          },
        ],
        variants: [],
      },
      row.destination_url,
    );

    expect(payload.nextRow.seed_data.description).toBeUndefined();
    expect(payload.nextRow.seed_data.seed_description_origin).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.description).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.seed_description_origin).toBeUndefined();
    expect(payload.nextRow.seed_data.derived.recall.retrieval_body || '').not.toMatch(/SOCIAL HIGHLIGHTS/i);
  });

  test('keeps explicit seed brand when building catalog extract requests', () => {
    const row = {
      id: 'eps_rarebeauty_1',
      market: 'US',
      domain: 'rarebeauty.com',
      title: 'Stay Vulnerable Glossy Lip Balm',
      seed_data: {
        brand: 'Rare Beauty',
      },
    };

    expect(buildExtractRequestBody('https://rarebeauty.com/products/stay-vulnerable-glossy-lip-balm', row)).toEqual({
      brand: 'Rare Beauty',
      domain: 'https://rarebeauty.com/products/stay-vulnerable-glossy-lip-balm',
      limit: 50,
      market: 'US',
    });
  });

  test('uses source domain brand instead of product title for known catalog backfill domains', () => {
    const row = {
      id: 'eps_kylie_1',
      market: 'US',
      domain: 'kyliecosmetics.com',
      title: 'Plumping Powder Matte Lip',
      seed_data: {
        snapshot: {
          canonical_url: 'https://kyliecosmetics.com/products/plumping-powder-matte-lip',
        },
      },
    };

    expect(buildExtractRequestBody('https://kyliecosmetics.com/products/plumping-powder-matte-lip', row)).toEqual({
      brand: 'Kylie Cosmetics',
      domain: 'https://kyliecosmetics.com/products/plumping-powder-matte-lip',
      limit: 50,
      market: 'US',
    });
  });

  test('canonicalizes noisy stored brand casing for known direct-brand domains', () => {
    const row = {
      id: 'eps_kylie_2',
      market: 'US',
      domain: 'kyliecosmetics.com',
      title: 'Plumping Powder Matte Lip',
      seed_data: {
        brand: 'kylie cosmetics',
      },
    };

    expect(buildExtractRequestBody('https://kyliecosmetics.com/products/plumping-powder-matte-lip', row)).toEqual({
      brand: 'Kylie Cosmetics',
      domain: 'https://kyliecosmetics.com/products/plumping-powder-matte-lip',
      limit: 50,
      market: 'US',
    });
  });

  test('matches locale-normalized product URLs when choosing the representative product', () => {
    const row = {
      canonical_url: 'https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html',
      destination_url: 'https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html',
      seed_data: {
        snapshot: {
          canonical_url: 'https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html',
        },
      },
    };

    const product = chooseRepresentativeProduct(
      {
        products: [
          {
            title: 'UV Filters SPF 45 Serum',
            url: 'https://theordinary.com/en-us/uv-filters-spf-45-serum-100720.html',
          },
        ],
      },
      'https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html',
      row,
    );

    expect(product.url).toBe('https://theordinary.com/en-us/uv-filters-spf-45-serum-100720.html');
    expect(normalizeComparableUrlKey(product.url)).toBe(
      normalizeComparableUrlKey('https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html'),
    );
  });

  test('matches singular and plural product PDP paths when choosing the representative product', () => {
    const row = {
      canonical_url: 'https://www.tomfordbeauty.com/product/gel-eyeliner?shade=02_Cocoa',
      destination_url: 'https://www.tomfordbeauty.com/product/gel-eyeliner?shade=02_Cocoa',
      seed_data: {
        snapshot: {
          canonical_url: 'https://www.tomfordbeauty.com/product/gel-eyeliner?shade=02_Cocoa',
        },
      },
    };

    const product = chooseRepresentativeProduct(
      {
        products: [
          {
            title: 'Gel Eyeliner',
            url: 'https://www.tomfordbeauty.com/products/gel-eyeliner',
          },
        ],
      },
      'https://www.tomfordbeauty.com/product/gel-eyeliner?shade=02_Cocoa',
      row,
    );

    expect(product.url).toBe('https://www.tomfordbeauty.com/products/gel-eyeliner');
    expect(normalizeComparableUrlKey(product.url)).toBe(
      normalizeComparableUrlKey('https://www.tomfordbeauty.com/product/gel-eyeliner?shade=02_Cocoa'),
    );
  });

  test('matches duplicate Shopify PDP handles when choosing the representative product among multiple candidates', () => {
    const row = {
      title: 'Heartleaf Centella Red Spot Cream',
      canonical_url: 'https://anua.com/products/heartleaf-centella-red-spot-cream-1',
      destination_url: 'https://anua.com/products/heartleaf-centella-red-spot-cream-1',
      seed_data: {
        snapshot: {
          canonical_url: 'https://anua.com/products/heartleaf-centella-red-spot-cream-1',
          title: 'Heartleaf Centella Red Spot Cream',
        },
      },
    };

    const product = chooseRepresentativeProduct(
      {
        products: [
          {
            title: 'Heartleaf Centella Red Spot Cream US',
            url: 'https://anua.com/products/heartleaf-centella-red-spot-cream',
          },
          {
            title: 'Heartleaf 70 Daily Lotion',
            url: 'https://anua.com/products/heartleaf-70-daily-lotion',
          },
        ],
      },
      'https://anua.com/products/heartleaf-centella-red-spot-cream-1',
      row,
    );

    expect(product.url).toBe('https://anua.com/products/heartleaf-centella-red-spot-cream');
  });

  test('normalizes locale-prefixed seed targets to the requested market locale', () => {
    expect(
      normalizeTargetUrlForMarket(
        'https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html',
        'US',
      ),
    ).toBe('https://theordinary.com/en-us/uv-filters-spf-45-serum-100720.html');
  });

  test('does not accept an unrelated fallback product for direct PDP targets', () => {
    const row = {
      canonical_url: 'https://theordinary.com/en-us/the-clear-set-100630.html',
      destination_url: 'https://theordinary.com/en-us/the-clear-set-100630.html',
      seed_data: {
        snapshot: {
          canonical_url: 'https://theordinary.com/en-us/the-clear-set-100630.html',
        },
      },
    };

    const product = chooseRepresentativeProduct(
      {
        products: [
          {
            title: 'Promotional Terms & Conditions',
            url: 'https://theordinary.com/en-nl/contact-us.html',
          },
        ],
      },
      'https://theordinary.com/en-us/the-clear-set-100630.html',
      row,
    );

    expect(product).toBeNull();
  });

  test('does not accept a stale collection destination as the representative for a direct PDP target', () => {
    const row = {
      title: 'Melt Awf Jelly Oil Makeup-Melting Cleanser',
      canonical_url: 'https://fentybeauty.com/products/melt-awf-jelly-oil-makeup-melting-cleanser',
      destination_url: 'https://fentybeauty.com/en-nl/collections/skincare-cleanser',
      seed_data: {
        snapshot: {
          title: 'Melt Awf Jelly Oil Makeup-Melting Cleanser',
          canonical_url: 'https://fentybeauty.com/products/melt-awf-jelly-oil-makeup-melting-cleanser',
          destination_url: 'https://fentybeauty.com/en-nl/collections/skincare-cleanser',
        },
      },
    };

    const product = chooseRepresentativeProduct(
      {
        products: [
          {
            title: 'Cleanser',
            url: 'https://fentybeauty.com/en-nl/collections/skincare-cleanser',
          },
        ],
      },
      'https://fentybeauty.com/products/melt-awf-jelly-oil-makeup-melting-cleanser',
      row,
    );

    expect(product).toBeNull();
  });

  test('accepts a verified Shopify direct-PDP redirect replacement', () => {
    const row = {
      title: 'Cosmic Kylie Jenner 2.0 50ml & Pen Spray Duo',
      canonical_url: 'https://kyliecosmetics.com/products/cosmic-kylie-jenner-2-0-50ml-pen-spray-duo',
      destination_url: 'https://kyliecosmetics.com/products/cosmic-kylie-jenner-2-0-50ml-pen-spray-duo',
      seed_data: {
        snapshot: {
          canonical_url: 'https://kyliecosmetics.com/products/cosmic-kylie-jenner-2-0-50ml-pen-spray-duo',
        },
      },
    };

    const product = chooseRepresentativeProduct(
      {
        products: [
          {
            title: 'Cosmic Kylie Jenner 2.0 50ml & Pen Spray Gift Set',
            url: 'https://kyliecosmetics.com/en-bl/products/cosmic-kylie-jenner-2-0-50ml-pen-spray-gift-set',
          },
        ],
      },
      'https://kyliecosmetics.com/products/cosmic-kylie-jenner-2-0-50ml-pen-spray-duo',
      row,
    );

    expect(product.url).toBe(
      'https://kyliecosmetics.com/en-bl/products/cosmic-kylie-jenner-2-0-50ml-pen-spray-gift-set',
    );
  });

  test('normalizes same-host locale-prefixed replacement PDP URLs to the seed storefront', () => {
    const row = {
      id: 'eps_kylie_redirected_duo',
      external_product_id: 'ext_kylie_redirected_duo',
      title: 'Cosmic Kylie Jenner 2.0 50ml & Pen Spray Duo',
      canonical_url: 'https://kyliecosmetics.com/products/cosmic-kylie-jenner-2-0-50ml-pen-spray-duo',
      destination_url: 'https://kyliecosmetics.com/products/cosmic-kylie-jenner-2-0-50ml-pen-spray-duo',
      price_amount: 66,
      price_currency: 'USD',
      seed_data: {
        snapshot: {
          canonical_url: 'https://kyliecosmetics.com/products/cosmic-kylie-jenner-2-0-50ml-pen-spray-duo',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Cosmic Kylie Jenner 2.0 50ml & Pen Spray Gift Set',
            url: 'https://kyliecosmetics.com/en-bl/products/cosmic-kylie-jenner-2-0-50ml-pen-spray-gift-set',
            product_kind: 'bundle',
            description_raw: 'A fragrance gift set with a full-size bottle and pen spray.',
            image_urls: ['https://cdn.shopify.com/s/files/example/gift-set.jpg?v=1'],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://kyliecosmetics.com/products/cosmic-kylie-jenner-2-0-50ml-pen-spray-duo',
    );

    expect(payload.nextRow.canonical_url).toBe(
      'https://kyliecosmetics.com/products/cosmic-kylie-jenner-2-0-50ml-pen-spray-gift-set',
    );
    expect(payload.nextRow.seed_data.snapshot.canonical_url).toBe(
      'https://kyliecosmetics.com/products/cosmic-kylie-jenner-2-0-50ml-pen-spray-gift-set',
    );
  });

  test('blocks cross-product PDP writes when preserved seed title conflicts with extracted product', () => {
    const row = {
      id: 'eps_fenty_dry_brush',
      title: 'Dry Brush-Cleaning Sponge',
      canonical_url: 'https://fentybeauty.com/products/dry-brush-cleaning-sponge',
      destination_url: 'https://fentybeauty.com/products/dry-brush-cleaning-sponge',
      image_url: 'https://cdn.example.com/dry-brush.jpg',
      price_amount: 18,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'Dry Brush-Cleaning Sponge',
        snapshot: {
          title: 'Dry Brush-Cleaning Sponge',
          canonical_url: 'https://fentybeauty.com/products/dry-brush-cleaning-sponge',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Jumbo Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter',
            url: 'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream-with-tropical-oils-shea-butter-vanilla-dream',
            description_raw: 'A whipped body cream.',
            variants: [],
          },
        ],
        variants: [],
        diagnostics: {
          discovery_strategy: 'shopify_json',
        },
      },
      'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream-with-tropical-oils-shea-butter-vanilla-dream',
    );

    expect(payload.blocked).toEqual(
      expect.objectContaining({
        reason: 'cross_product_title_drift',
        existing_title: 'Dry Brush-Cleaning Sponge',
        extracted_title: 'Jumbo Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter',
      }),
    );
    expect(payload.nextRow.title).toBe('Dry Brush-Cleaning Sponge');
    expect(payload.nextRow.canonical_url).toBe('https://fentybeauty.com/products/dry-brush-cleaning-sponge');
    expect(payload.nextRow.seed_data.snapshot.diagnostics.catalog_backfill_blocked.reason).toBe(
      'cross_product_title_drift',
    );
  });

  test('repairs nested stale seed titles when the current row already matches the extracted PDP', () => {
    const row = {
      id: 'eps_fenty_nested_stale_title',
      title: 'Jumbo Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter',
      canonical_url: 'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream',
      destination_url: 'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream',
      price_amount: 36,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: "Fenty Skin Travel-Size Start'r Set with Mineral SPF",
        snapshot: {
          title: "Fenty Skin Travel-Size Start'r Set with Mineral SPF",
          canonical_url: 'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Jumbo Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter',
            url: 'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream',
            description_raw: 'A whipped body cream.',
            image_urls: ['https://cdn.shopify.com/s/files/example/fenty-body-cream.jpg?v=1'],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: {
          discovery_strategy: 'shopify_json',
        },
      },
      'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream',
    );

    expect(payload.blocked).toBeUndefined();
    expect(payload.nextRow.title).toBe('Jumbo Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter');
    expect(payload.nextRow.seed_data.title).toBe('Jumbo Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter');
    expect(payload.nextRow.seed_data.snapshot.title).toBe('Jumbo Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter');
    expect(payload.nextRow.seed_data.snapshot.diagnostics?.catalog_backfill_blocked).toBeUndefined();
  });

  test('syncs seed_data title when a refreshed PDP passes identity checks', () => {
    const row = {
      id: 'eps_fenty_body_cream',
      title: 'Jumbo Butta Drop Whipped Oil Body Cream',
      canonical_url: 'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream',
      destination_url: 'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream',
      price_amount: 36,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'Jumbo Butta Drop Whipped Oil Body Cream',
        snapshot: {
          title: 'Jumbo Butta Drop Whipped Oil Body Cream',
          canonical_url: 'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Jumbo Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter',
            url: 'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream',
            description_raw: 'A whipped body cream with tropical oils and shea butter.',
            variants: [],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream',
    );

    expect(payload.blocked).toBeUndefined();
    expect(payload.nextRow.title).toBe('Jumbo Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter');
    expect(payload.nextRow.seed_data.title).toBe(
      'Jumbo Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter',
    );
    expect(payload.nextRow.seed_data.snapshot.title).toBe(
      'Jumbo Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter',
    );
  });

  test('uses target URL overrides to recover polluted rows before extraction', async () => {
    const recoveredUrl = 'https://fentybeauty.com/products/dry-brush-cleaning-sponge';
    const row = {
      id: 'eps_fenty_dry_brush',
      external_product_id: 'ext_dry_brush',
      title: 'Jumbo Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter',
      market: 'US',
      canonical_url:
        'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream-with-tropical-oils-shea-butter-vanilla-dream',
      destination_url:
        'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream-with-tropical-oils-shea-butter-vanilla-dream',
      seed_data: {
        title: 'Dry Brush-Cleaning Sponge',
        pdp_details_sections: [
          {
            heading: 'Details',
            body: 'A whipped body cream that buttas you up.',
            source_kind: 'stale_previous_product',
          },
        ],
        pdp_ingredients_raw: '7 Luxe Oils, Shea Butter, Mango Butter',
        pdp_how_to_use_raw: 'Apply all over body once a day.',
        raw_ingredient_text_clean: 'ORYZA SATIVA (RICE) BRAN OIL, SHEA BUTTER',
        ingredient_tokens: ['rice bran oil', 'shea butter'],
        key_ingredients: ['Rice Bran Oil', 'Shea Butter'],
        ingredient_intel: {
          inci_raw: 'ORYZA SATIVA (RICE) BRAN OIL, SHEA BUTTER',
        },
        pdp_faq_items: [
          {
            question: 'Is this a body cream?',
            answer: 'Yes.',
            source_kind: 'stale_previous_product',
          },
        ],
        snapshot: {
          title: 'Dry Brush-Cleaning Sponge',
          canonical_url:
            'https://fentybeauty.com/products/jumbo-butta-drop-whipped-oil-body-cream-with-tropical-oils-shea-butter-vanilla-dream',
          pdp_details_sections: [
            {
              heading: 'Details',
              body: 'A whipped body cream that buttas you up.',
              source_kind: 'stale_previous_product',
            },
          ],
          pdp_ingredients_raw: '7 Luxe Oils, Shea Butter, Mango Butter',
          pdp_how_to_use_raw: 'Apply all over body once a day.',
          raw_ingredient_text_clean: 'ORYZA SATIVA (RICE) BRAN OIL, SHEA BUTTER',
          ingredient_tokens: ['rice bran oil', 'shea butter'],
          key_ingredients: ['Rice Bran Oil', 'Shea Butter'],
          ingredient_intel: {
            inci_raw: 'ORYZA SATIVA (RICE) BRAN OIL, SHEA BUTTER',
          },
        },
      },
    };

    jest.spyOn(axios, 'post').mockResolvedValueOnce({
      data: {
        products: [
          {
            title: 'Dry Brush-Cleaning Sponge',
            url: recoveredUrl,
            description_raw: 'A dry brush cleaning sponge.',
            variants: [],
          },
        ],
        variants: [],
        diagnostics: {},
      },
    });

    const result = await processRow(row, {
      dryRun: true,
      baseUrl: 'https://catalog.test',
      validateImageHealth: false,
      expandVariants: false,
      targetUrlOverrides: {
        ext_dry_brush: recoveredUrl,
      },
    });

    expect(axios.post.mock.calls[0][1].domain).toBe(recoveredUrl);
    expect(result.status).toBe('dry_run');
    expect(result.targetUrl).toBe(recoveredUrl);
    expect(result.payload.blocked).toBeUndefined();
    expect(result.payload.nextRow.title).toBe('Dry Brush-Cleaning Sponge');
    expect(result.payload.nextRow.seed_data.title).toBe('Dry Brush-Cleaning Sponge');
    expect(result.payload.nextRow.canonical_url).toBe(recoveredUrl);
    expect(result.payload.nextRow.seed_data.pdp_details_sections).toBeUndefined();
    expect(result.payload.nextRow.seed_data.pdp_ingredients_raw).toBeUndefined();
    expect(result.payload.nextRow.seed_data.pdp_how_to_use_raw).toBeUndefined();
    expect(result.payload.nextRow.seed_data.pdp_faq_items).toBeUndefined();
    expect(result.payload.nextRow.seed_data.raw_ingredient_text_clean).toBeUndefined();
    expect(result.payload.nextRow.seed_data.ingredient_tokens).toBeUndefined();
    expect(result.payload.nextRow.seed_data.key_ingredients).toBeUndefined();
    expect(result.payload.nextRow.seed_data.ingredient_intel).toBeUndefined();
    expect(result.payload.nextRow.seed_data.snapshot.pdp_details_sections).toBeUndefined();
    expect(result.payload.nextRow.seed_data.snapshot.pdp_ingredients_raw).toBeUndefined();
    expect(result.payload.nextRow.seed_data.snapshot.pdp_how_to_use_raw).toBeUndefined();
    expect(result.payload.nextRow.seed_data.snapshot.raw_ingredient_text_clean).toBeUndefined();
    expect(result.payload.nextRow.seed_data.snapshot.ingredient_tokens).toBeUndefined();
    expect(result.payload.nextRow.seed_data.snapshot.key_ingredients).toBeUndefined();
    expect(result.payload.nextRow.seed_data.snapshot.ingredient_intel).toBeUndefined();
  });

  test('skips direct PDP backfill when extractor only returns unrelated collection products', async () => {
    const row = {
      id: 'eps_tomford_missing_handle',
      title: 'Shade and Illuminate Soft Radiance Foundation SPF 50',
      market: 'US',
      canonical_url:
        'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=9.7_Cool_Dusk',
      destination_url:
        'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=9.7_Cool_Dusk',
      seed_data: {
        snapshot: {
          canonical_url:
            'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=9.7_Cool_Dusk',
        },
      },
    };

    jest
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({
        data: {
          products: [
            {
              title: 'Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+',
              url: 'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation-broad-spectrum-spf-50',
              description_raw: 'A different product.',
              variants: [],
            },
          ],
          variants: [],
          diagnostics: {
            http_trace: [
              {
                url: 'https://www.tomfordbeauty.com/products/shade-and-illuminate-soft-radiance-foundation-spf-50.js',
                status: 404,
              },
              {
                url: 'https://www.tomfordbeauty.com/collections/makeup',
                status: 200,
              },
            ],
          },
        },
      });

    const result = await processRow(row, {
      dryRun: true,
      baseUrl: 'https://catalog.test',
      validateImageHealth: false,
      expandVariants: false,
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('representative_product_not_found');
    expect(result.payload.candidate_product_urls).toEqual([
      'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation-broad-spectrum-spf-50',
    ]);
  });

  test('skips direct PDP backfill when extractor returns no products', async () => {
    const row = {
      id: 'eps_kylie_empty_pdp',
      title: 'Chrome Makeup Bag',
      market: 'US',
      canonical_url: 'https://kyliecosmetics.com/products/chrome-makeup-bag',
      destination_url: 'https://kyliecosmetics.com/products/chrome-makeup-bag',
      seed_data: {
        image_urls: ['https://cdn.example.com/stale.jpg'],
        snapshot: {
          canonical_url: 'https://kyliecosmetics.com/products/chrome-makeup-bag',
          image_urls: ['https://cdn.example.com/stale.jpg'],
        },
      },
    };

    jest
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({
        data: {
          products: [],
          variants: [],
          diagnostics: {
            extraction_status: 'empty',
          },
        },
      });

    const result = await processRow(row, {
      dryRun: true,
      baseUrl: 'https://catalog.test',
      validateImageHealth: false,
      expandVariants: false,
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('catalog_empty_direct_pdp');
    expect(result.payload.diagnostics).toEqual({ extraction_status: 'empty' });
  });

  test('recovers direct Shopify PDP 404 from public products.json by exact handle', async () => {
    const targetUrl = 'https://www.skin1004.com/products/poremizing-glow-wrapping-mask';
    const imageUrl =
      'https://cdn.shopify.com/s/files/1/0590/4538/0253/files/poremizing-glow-wrapping-mask.png?v=1';
    const row = {
      id: 'eps_skin1004_geo_hidden',
      external_product_id: 'ext_skin1004_geo_hidden',
      title: 'Poremizing Glow Wrapping Mask',
      market: 'US',
      canonical_url: targetUrl,
      destination_url: targetUrl,
      price_currency: 'USD',
      seed_data: {
        title: 'Poremizing Glow Wrapping Mask',
        pdp_how_to_use_raw: 'Use according to the merchant directions for this product.',
        strict_pdp_source_blocker_v1: {
          reason_codes: ['official_pdp_http_404'],
          unsafe_source: true,
        },
        pdp_field_quality_summary: {
          how_to_use_raw: {
            source_origin: 'pivota_force_fill',
            source_quality_status: 'force_filled_reviewed_pattern',
          },
        },
        snapshot: {
          title: 'Poremizing Glow Wrapping Mask',
          canonical_url: targetUrl,
          pdp_how_to_use_raw: 'Use according to the merchant directions for this product.',
          strict_pdp_source_blocker_v1: {
            reason_codes: ['official_pdp_http_404'],
            unsafe_source: true,
          },
          external_seed_snapshot_contract: {
            authoritative: true,
            legacy_fields_quarantined: true,
          },
          pdp_field_quality_summary: {
            how_to_use_raw: {
              source_origin: 'pivota_force_fill',
              source_quality_status: 'force_filled_reviewed_pattern',
            },
          },
        },
      },
    };

    jest
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({
        data: {
          products: [],
          variants: [],
          diagnostics: {
            discovery_strategy: 'shopify_json',
            failure_category: 'no_product_urls',
            http_trace: [
              { url: `${targetUrl}.js`, status: 404 },
              { url: targetUrl, status: 404 },
            ],
          },
        },
      });
    jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          products: [
            {
              id: 9355674386678,
              title: 'Poremizing Glow Wrapping Mask',
              handle: 'poremizing-glow-wrapping-mask',
              vendor: 'SKIN1004',
              product_type: 'Mask',
              tags: [],
              body_html:
                '<p><strong>What It Is:</strong><br>A bouncy gel type wrapping mask that peels off to reveal visibly refined pores.</p><p><strong>Product Benefits:</strong><br>Pore Refining, Firming, Radiance</p><p><strong>Key Ingredients:</strong><br>Centella Asiatica Extract, Mineral Salts</p>',
              variants: [
                {
                  id: 50574080000123,
                  title: '75ml',
                  option1: '75ml',
                  sku: 'USSKM001',
                  available: true,
                  price: '18.00',
                  compare_at_price: '20.00',
                },
              ],
              images: [
                {
                  src: imageUrl,
                  variant_ids: [50574080000123],
                },
              ],
              options: [{ name: 'Size', values: ['75ml'] }],
            },
          ],
        },
      });

    const result = await processRow(row, {
      dryRun: true,
      baseUrl: 'https://catalog.test',
      validateImageHealth: false,
      expandVariants: false,
    });

    expect(result.status).toBe('dry_run');
    expect(result.payload.nextRow.seed_data.snapshot.diagnostics.recovery_strategy).toBe(
      'shopify_products_json_handle_fallback',
    );
    expect(result.payload.nextRow.price_amount).toBe(18);
    expect(result.payload.nextRow.availability).toBe('in_stock');
    expect(result.payload.nextRow.seed_data.pdp_description_raw).toContain('bouncy gel type wrapping mask');
    expect(result.payload.nextRow.seed_data.pdp_details_sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heading: 'Product Benefits', body: 'Pore Refining, Firming, Radiance' }),
        expect.objectContaining({ heading: 'Key Ingredients', body: 'Centella Asiatica Extract, Mineral Salts' }),
      ]),
    );
    expect(result.payload.nextRow.seed_data.pdp_how_to_use_raw).toBeUndefined();
    expect(result.payload.nextRow.seed_data.raw_ingredient_text_clean).toBeUndefined();
    expect(result.payload.nextRow.seed_data.inci_list).toBeUndefined();
    expect(result.payload.nextRow.seed_data.active_ingredients).toBeUndefined();
    expect(result.payload.nextRow.seed_data.snapshot.active_ingredients).toBeUndefined();
    expect(result.payload.nextRow.seed_data.ingredient_intel?.active_ingredients).toBeUndefined();
    expect(result.payload.nextRow.seed_data.snapshot.ingredient_intel?.active_ingredients).toBeUndefined();
    expect(result.payload.nextRow.seed_data.strict_pdp_source_blocker_v1).toBeUndefined();
    expect(result.payload.nextRow.seed_data.snapshot.strict_pdp_source_blocker_v1).toBeUndefined();
    expect(result.payload.nextRow.seed_data.pdp_field_quality_summary.description_raw).toMatchObject({
      source_origin: 'shopify_products_json',
      source_quality_status: 'medium',
    });
    expect(result.payload.nextRow.seed_data.variants).toEqual([
      expect.objectContaining({
        sku: 'USSKM001',
        option_name: 'Size',
        option_value: '75ml',
        price: '18.00',
        stock: 'In Stock',
      }),
    ]);
  });

  test('splits Shopify Full INCI copy out of how-to during handle fallback', async () => {
    const targetUrl = 'https://roundlab.com/products/birch-moisturizing-hand-cream';
    const imageUrl = 'https://cdn.shopify.com/s/files/1/0651/7656/8022/files/birch_hand_cream_3.webp?v=1776117448';
    const row = {
      id: 'eps_roundlab_hand_cream',
      external_product_id: 'ext_roundlab_hand_cream',
      title: 'Birch Moisturizing Hand Cream',
      canonical_url: targetUrl,
      destination_url: targetUrl,
      price_amount: null,
      price_currency: 'USD',
      availability: 'unknown',
      seed_data: { snapshot: {} },
    };

    jest
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({
        data: {
          products: [],
          variants: [],
          diagnostics: {
            discovery_strategy: 'shopify_json',
            failure_category: 'no_product_urls',
          },
        },
      });
    jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          products: [
            {
              id: 9569001000001,
              title: 'Birch Moisturizing Hand Cream',
              handle: 'birch-moisturizing-hand-cream',
              vendor: 'Round Lab',
              product_type: 'Hand Cream',
              tags: [],
              body_html:
                '<p><strong>How to Use</strong><br>Apply an appropriate amount to clean, dry hands.<br>Gently massage until fully absorbed.<br>Reapply as needed throughout the day.<br><br>Good For<br>Dry or rough hands<br><br>Full INCI<br>Water, Betula Platyphylla Japonica Juice, Glycerin, Butylene Glycol, Caprylic/Capric Triglyceride, Cetearyl Alcohol, Glyceryl Stearate, Panthenol, 1,2-Hexanediol, Carbomer, Tromethamine, Ethylhexylglycerin, Sodium Hyaluronate, Disodium EDTA</p>',
              variants: [
                {
                  id: 50610000000001,
                  title: 'Default Title',
                  option1: 'Default Title',
                  sku: 'RL-HAND-CREAM',
                  available: true,
                  price: '8.50',
                  compare_at_price: null,
                },
              ],
              images: [{ src: imageUrl }],
              options: [{ name: 'Title', values: ['Default Title'] }],
            },
          ],
        },
      });

    const result = await processRow(row, {
      dryRun: true,
      baseUrl: 'https://catalog.test',
      validateImageHealth: false,
      expandVariants: false,
    });

    expect(result.status).toBe('dry_run');
    expect(result.payload.nextRow.seed_data.pdp_how_to_use_raw).toBe(
      'Apply an appropriate amount to clean, dry hands. Gently massage until fully absorbed. Reapply as needed throughout the day.',
    );
    expect(result.payload.nextRow.seed_data.pdp_how_to_use_raw).not.toMatch(/Good For|Full INCI|Betula/i);
    expect(result.payload.nextRow.seed_data.pdp_ingredients_raw).toBe(
      'Water, Betula Platyphylla Japonica Juice, Glycerin, Butylene Glycol, Caprylic/Capric Triglyceride, Cetearyl Alcohol, Glyceryl Stearate, Panthenol, 1,2-Hexanediol, Carbomer, Tromethamine, Ethylhexylglycerin, Sodium Hyaluronate, Disodium EDTA',
    );
    expect(result.payload.nextRow.seed_data.pdp_field_quality_summary.ingredients_raw).toMatchObject({
      source_origin: 'shopify_products_json',
      source_quality_status: 'medium',
    });
  });

  test('recovers the original PDP target from diagnostics when the stored URL drifted to contact-us', () => {
    const row = {
      canonical_url: 'https://theordinary.com/en-us/contact-us.html',
      destination_url: 'https://theordinary.com/en-us/contact-us.html',
      seed_data: {
        snapshot: {
          diagnostics: {
            http_trace: [
              { url: 'https://theordinary.com/products.json?limit=1', status: 404 },
              { url: 'https://theordinary.com/en-us/the-clear-set-100630.html', status: 404 },
              { url: 'https://theordinary.com/contact-us.html', status: 200 },
            ],
          },
        },
      },
    };

    expect(recoverTargetUrlFromDiagnostics(row)).toBe('https://theordinary.com/en-us/the-clear-set-100630.html');
    expect(pickSeedTargetUrl(row)).toBe('https://theordinary.com/en-us/the-clear-set-100630.html');
  });

  test('preserves existing images and variants when extraction returns empty', () => {
    const row = {
      id: 'eps_1',
      title: 'Existing Product',
      canonical_url: 'https://example.com/p/existing-product',
      destination_url: 'https://example.com/p/existing-product',
      image_url: 'https://example.com/existing.jpg',
      price_amount: 25,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        image_url: 'https://example.com/existing.jpg',
        image_urls: ['https://example.com/existing.jpg', 'https://example.com/existing-2.jpg'],
        snapshot: {
          canonical_url: 'https://example.com/p/existing-product',
          image_urls: ['https://example.com/existing.jpg', 'https://example.com/existing-2.jpg'],
          variants: [
            {
              sku: 'EXISTING-001',
              variant_id: 'EXISTING-001',
              price: '25.00',
              currency: 'USD',
              stock: 'In Stock',
              image_url: 'https://example.com/existing.jpg',
              image_urls: ['https://example.com/existing.jpg', 'https://example.com/existing-2.jpg'],
            },
          ],
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [],
        variants: [],
        diagnostics: { failure_category: 'bot_challenge' },
      },
      'https://example.com/p/existing-product',
    );

    expect(payload.nextRow.image_url).toBe('https://example.com/existing.jpg');
    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://example.com/existing.jpg',
      'https://example.com/existing-2.jpg',
    ]);
    expect(payload.nextRow.seed_data.snapshot.variants).toHaveLength(1);
    expect(payload.nextRow.seed_data.snapshot.diagnostics).toEqual({ failure_category: 'bot_challenge' });
  });

  test('drops polluted fallback variants when a contact-us row is recovered to a direct PDP target', () => {
    const row = {
      id: 'eps_contact_drift',
      title: 'Promotional Terms & Conditions',
      canonical_url: 'https://theordinary.com/en-us/contact-us.html',
      destination_url: 'https://theordinary.com/en-us/contact-us.html',
      image_url: '',
      price_amount: null,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'The Clear Set',
        snapshot: {
          canonical_url: 'https://theordinary.com/en-us/contact-us.html',
          variants: [
            {
              sku: 'CONTACT-US',
              variant_id: 'CONTACT-US',
              url: 'https://theordinary.com/en-us/contact-us.html',
              price: '',
              currency: 'USD',
              stock: 'In Stock',
              description: 'Our Customer Happiness team is here to help.',
            },
          ],
          diagnostics: {
            http_trace: [
              { url: 'https://theordinary.com/en-us/the-clear-set-100630.html', status: 404 },
              { url: 'https://theordinary.com/contact-us.html', status: 200 },
            ],
          },
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [],
        variants: [],
        diagnostics: { failure_category: 'no_product_urls' },
      },
      'https://theordinary.com/en-us/the-clear-set-100630.html',
    );

    expect(payload.nextRow.title).toBe('The Clear Set');
    expect(payload.nextRow.canonical_url).toBe('https://theordinary.com/en-us/the-clear-set-100630.html');
    expect(payload.nextRow.destination_url).toBe('https://theordinary.com/en-us/the-clear-set-100630.html');
    expect(payload.nextRow.seed_data.snapshot.variants).toEqual([]);
    expect(payload.nextRow.seed_data.snapshot.diagnostics).toEqual({ failure_category: 'no_product_urls' });
  });

  test('syncs top-level seed description to the refreshed variant description', () => {
    const row = {
      id: 'eps_salicylic',
      title: 'Salicylic Acid 2% Solution',
      canonical_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
      destination_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
      image_url: 'https://example.com/salicylic.jpg',
      price_amount: 6.7,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'Salicylic Acid 2% Solution',
        description: 'Ein gezieltes Serum für die zu Unreinheiten neigende Haut.',
        snapshot: {
          canonical_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
          description: 'Ein gezieltes Serum für die zu Unreinheiten neigende Haut.',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Salicylic Acid 2% Solution',
            url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
            variants: [
              {
                id: '769915231731',
                sku: '769915231731',
                description:
                  'Formulated with Salicylic Acid for acne, this water-based Beta Hydroxy Acid (BHA) serum contains a 2% concentration to offer surface-level exfoliation.',
              },
            ],
          },
        ],
        variants: [
          {
            id: '769915231731',
            sku: '769915231731',
            product_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
            url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
            description:
              'Formulated with Salicylic Acid for acne, this water-based Beta Hydroxy Acid (BHA) serum contains a 2% concentration to offer surface-level exfoliation.',
            image_url: 'https://example.com/salicylic.jpg',
            image_urls: ['https://example.com/salicylic.jpg'],
            price: '6.70',
            currency: 'USD',
            stock: 'In Stock',
          },
        ],
        diagnostics: { failure_category: null },
      },
      'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
    );

    expect(payload.nextRow.seed_data.description).toBe(
      'Formulated with Salicylic Acid for acne, this water-based Beta Hydroxy Acid (BHA) serum contains a 2% concentration to offer surface-level exfoliation.',
    );
    expect(payload.nextRow.seed_data.snapshot.description).toBe(
      'Formulated with Salicylic Acid for acne, this water-based Beta Hydroxy Acid (BHA) serum contains a 2% concentration to offer surface-level exfoliation.',
    );
  });

  test('persists extracted PDP FAQ items into seed_data and snapshot', () => {
    const row = {
      id: 'eps_pixi_clarity',
      title: 'Clarity Tonic Travel Size',
      canonical_url: 'https://pixibeauty.com/products/clarity-tonic',
      destination_url: 'https://pixibeauty.com/products/clarity-tonic',
      image_url: 'https://example.com/clarity.jpg',
      price_amount: 15,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'Clarity Tonic Travel Size',
        snapshot: {
          canonical_url: 'https://pixibeauty.com/products/clarity-tonic',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Clarity Tonic Travel Size',
            url: 'https://pixibeauty.com/products/clarity-tonic',
            image_url: 'https://example.com/clarity.jpg',
            image_urls: ['https://example.com/clarity.jpg'],
            variant_skus: ['82154'],
            variants: [
              {
                sku: '82154',
                variant_id: '82154',
                url: 'https://pixibeauty.com/products/clarity-tonic',
                price: '15.00',
                currency: 'USD',
                stock: 'In Stock',
                image_url: 'https://example.com/clarity.jpg',
                image_urls: ['https://example.com/clarity.jpg'],
              },
            ],
            description_raw: 'Clarifying tonic with potent AHAs.',
            details_sections: [
              { heading: 'How to Use', body: 'Use AM & PM after cleansing.', source_kind: 'accordion_control' },
            ],
            how_to_use_raw: 'Use AM & PM after cleansing.',
            faq_items: [
              {
                question: 'What percentage of salicylic acid does this product contain?',
                answer: "We don't disclose the percentage.",
                source_kind: 'okendo_questions_api',
                source_url: 'https://pixibeauty.com/products/clarity-tonic',
                source_title: 'Product Questions',
              },
            ],
            field_capture_status: {
              description_raw: 'present',
              details_sections: 'present',
              ingredients_raw: 'missing',
              active_ingredients_raw: 'missing',
              how_to_use_raw: 'present',
              faq_items: 'present',
            },
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://pixibeauty.com/products/clarity-tonic',
    );

    expect(payload.nextRow.seed_data.pdp_faq_items).toEqual([
      {
        question: 'What percentage of salicylic acid does this product contain?',
        answer: "We don't disclose the percentage.",
        source_kind: 'okendo_questions_api',
        source_url: 'https://pixibeauty.com/products/clarity-tonic',
        source_title: 'Product Questions',
      },
    ]);
    expect(payload.nextRow.seed_data.snapshot.pdp_faq_items).toEqual(payload.nextRow.seed_data.pdp_faq_items);
    expect(payload.nextRow.seed_data.pdp_field_capture_status.faq_items).toBe('present');
  });

  test('persists PDP raw fields and provenance when extractor returns module-level product data', () => {
    const row = {
      id: 'eps_rare_spf',
      title: 'Positive Light Tinted Moisturizer Broad Spectrum SPF 20 Sunscreen',
      canonical_url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
      destination_url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
      image_url: '',
      price_amount: 32,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        description: 'OFFICIAL: stale synthetic summary',
        snapshot: {
          canonical_url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Positive Light Tinted Moisturizer Broad Spectrum SPF 20 Sunscreen',
            url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
            description_raw: 'A breathable tinted moisturizer with SPF 20.',
            details_sections: [
              {
                heading: 'Ingredients',
                body: 'Titanium Dioxide 3.4%, Zinc Oxide 14.37%',
                source_kind: 'accordion_ingredients',
              },
              {
                heading: 'How to Use',
                body: 'Apply before sun exposure.',
                source_kind: 'accordion_how_to_use',
                media_urls: ['https://cdn.example.com/spf-routine-step.jpg'],
              },
            ],
            content_image_urls: ['https://cdn.example.com/spf-routine-step.jpg'],
            ingredients_raw: 'Titanium Dioxide 3.4%, Zinc Oxide 14.37%',
            active_ingredients_raw: 'Titanium Dioxide, Zinc Oxide',
            how_to_use_raw: 'Apply before sun exposure.',
            faq_items: [
              {
                question: 'NEED HELP? NEED HELP?',
                answer: 'TRACK MY ORDER SERVICES SHIPPING & RETURNS FAQS STORE LOCATOR CONTACT US',
                source_kind: 'merchant_faq',
                source_url: 'https://rarebeauty.com/pages/faqs',
              },
              {
                question: 'Can I wear this every day?',
                answer: 'Yes, apply before sun exposure as part of your daytime routine.',
                source_kind: 'merchant_faq',
              },
            ],
            field_capture_status: {
              description_raw: 'present',
              details_sections: 'present',
              ingredients_raw: 'present',
              active_ingredients_raw: 'present',
              how_to_use_raw: 'present',
            },
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
    );

    expect(payload.nextRow.seed_data.pdp_description_raw).toBe('A breathable tinted moisturizer with SPF 20.');
    expect(payload.nextRow.seed_data.pdp_ingredients_raw).toBe('Titanium Dioxide 3.4%, Zinc Oxide 14.37%');
    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).toBe('Titanium Dioxide, Zinc Oxide');
    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).toBe('Apply before sun exposure.');
    expect(payload.nextRow.seed_data.pdp_faq_items).toEqual([
      {
        question: 'Can I wear this every day?',
        answer: 'Yes, apply before sun exposure as part of your daytime routine.',
        source_kind: 'merchant_faq',
      },
    ]);
    expect(payload.nextRow.seed_data.seed_description_origin).toBe('pdp_product_description');
    expect(payload.nextRow.seed_data.content_image_urls).toEqual([
      'https://cdn.example.com/spf-routine-step.jpg',
    ]);
    expect(payload.nextRow.seed_data.pdp_field_capture_status).toEqual({
      description_raw: 'present',
      details_sections: 'present',
      ingredients_raw: 'present',
      active_ingredients_raw: 'present',
      how_to_use_raw: 'present',
      faq_items: 'present',
    });
    expect(payload.nextRow.seed_data.snapshot.pdp_details_sections).toEqual([
      {
        heading: 'Ingredients',
        body: 'Titanium Dioxide 3.4%, Zinc Oxide 14.37%',
        source_kind: 'accordion_ingredients',
      },
      {
        heading: 'How to Use',
        body: 'Apply before sun exposure.',
        source_kind: 'accordion_how_to_use',
      },
    ]);
    expect(payload.nextRow.seed_data.snapshot.pdp_faq_items).toEqual([
      {
        question: 'Can I wear this every day?',
        answer: 'Yes, apply before sun exposure as part of your daytime routine.',
        source_kind: 'merchant_faq',
      },
    ]);
    expect(payload.nextRow.seed_data.snapshot.content_image_urls).toEqual([
      'https://cdn.example.com/spf-routine-step.jpg',
    ]);
  });

  test('persists extractor product kind and structured bundle components', () => {
    const row = {
      id: 'eps_kylie_calendar',
      title: '12 Days of Kylie Advent Calendar',
      canonical_url: 'https://kyliecosmetics.com/products/kylie-advent-calendar-2025',
      destination_url: 'https://kyliecosmetics.com/products/kylie-advent-calendar-2025',
      image_url: '',
      price_amount: 199,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        product_kind: 'single_formula',
        bundle_components: [{ name: 'stale serum', source_kind: 'legacy' }],
        snapshot: {
          product_kind: 'single_formula',
          bundle_components: [{ name: 'stale serum', source_kind: 'legacy' }],
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: '12 Days of Kylie Advent Calendar',
            url: 'https://kyliecosmetics.com/products/kylie-advent-calendar-2025',
            description_raw: 'A limited edition beauty advent calendar.',
            product_kind: 'bundle',
            bundle_components: [
              {
                name: 'Lip Glaze',
                quantity: 'one',
                source_kind: 'shopify_body_html_labeled_sections',
                raw_text: 'one Lip Glaze',
              },
              {
                name: 'Mini Fragrance',
                source_kind: 'shopify_body_html_labeled_sections',
              },
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      'https://kyliecosmetics.com/products/kylie-advent-calendar-2025',
    );

    expect(payload.nextRow.seed_data.product_kind).toBe('bundle');
    expect(payload.nextRow.seed_data.bundle_components).toEqual([
      {
        name: 'Lip Glaze',
        quantity: 'one',
        source_kind: 'shopify_body_html_labeled_sections',
        raw_text: 'one Lip Glaze',
      },
      {
        name: 'Mini Fragrance',
        source_kind: 'shopify_body_html_labeled_sections',
      },
    ]);
    expect(payload.nextRow.seed_data.snapshot.product_kind).toBe('bundle');
    expect(payload.nextRow.seed_data.snapshot.bundle_components).toEqual(
      payload.nextRow.seed_data.bundle_components,
    );
  });

  test('marks refreshed snapshots authoritative and clears legacy PDP shadow fields on writeback', () => {
    const row = {
      id: 'eps_refresh_authoritative',
      title: 'Barrier Serum',
      canonical_url: 'https://example.com/products/barrier-serum',
      destination_url: 'https://example.com/products/barrier-serum',
      image_url: 'https://cdn.example.com/legacy.jpg',
      price_amount: 38,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        description: 'Legacy soup description',
        details_sections: [{ heading: 'Legacy', body: 'Legacy details' }],
        faq_items: [{ question: 'Legacy Q?', answer: 'Legacy A.' }],
        how_to_use: 'Legacy how to use',
        snapshot: {
          description: 'Legacy soup description',
          details_sections: [{ heading: 'Legacy', body: 'Legacy details' }],
          faq_items: [{ question: 'Legacy Q?', answer: 'Legacy A.' }],
          how_to_use: 'Legacy how to use',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            url: 'https://example.com/products/barrier-serum',
            canonical_url: 'https://example.com/products/barrier-serum',
            title: 'Barrier Serum',
            description: 'Daily barrier support serum.',
            image_urls: ['https://cdn.example.com/barrier-serum.jpg'],
            variants: [],
            details_sections: [
              { heading: 'Overview', body: 'Daily barrier support serum.' },
              { heading: 'How to Use', body: 'Apply after cleansing.' },
            ],
            faq_items: [
              { question: 'Can I layer this under cream?', answer: 'Yes, use before moisturizer.', source_kind: 'merchant_faq' },
            ],
            pdp_how_to_use_raw: 'Apply after cleansing.',
            diagnostics: { failure_category: null },
          },
        ],
      },
      'https://example.com/products/barrier-serum',
    );

    expect(payload.nextRow.seed_data.external_seed_snapshot_contract).toEqual(
      expect.objectContaining({
        contract_version: 'external_seed.snapshot_contract.v1',
        authoritative: true,
        structured_fields_authoritative: true,
        legacy_fields_quarantined: true,
        replace_strategy: 'replace_not_merge',
      }),
    );
    expect(payload.nextRow.seed_data.snapshot.external_seed_snapshot_contract).toEqual(
      expect.objectContaining({
        contract_version: 'external_seed.snapshot_contract.v1',
        authoritative: true,
        structured_fields_authoritative: true,
        legacy_fields_quarantined: true,
        replace_strategy: 'replace_not_merge',
      }),
    );
    expect(payload.nextRow.seed_data.details_sections).toBeUndefined();
    expect(payload.nextRow.seed_data.faq_items).toBeUndefined();
    expect(payload.nextRow.seed_data.how_to_use).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.details_sections).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.faq_items).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.how_to_use).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.pdp_details_sections).toEqual([
      { heading: 'Overview', body: 'Daily barrier support serum.', source_kind: 'unknown' },
      { heading: 'How to Use', body: 'Apply after cleansing.', source_kind: 'unknown' },
    ]);
    expect(payload.nextRow.seed_data.snapshot.pdp_faq_items).toEqual([
      { question: 'Can I layer this under cream?', answer: 'Yes, use before moisturizer.', source_kind: 'merchant_faq' },
    ]);
  });

  test('preserves existing PDP content when a later authoritative extract returns empty fields', () => {
    const row = {
      id: 'eps_preserve_existing_content',
      external_product_id: 'ext_preserve_existing_content',
      title: 'Preserve Serum',
      canonical_url: 'https://example.com/products/preserve-serum',
      destination_url: 'https://example.com/products/preserve-serum',
      seed_data: {
        pdp_description_raw: 'Existing approved description with enough detail for the product page.',
        pdp_how_to_use_raw: 'Apply two drops after cleansing and before moisturizer.',
        pdp_ingredients_raw: 'Water, Glycerin, Niacinamide',
        snapshot: {
          pdp_description_raw: 'Existing approved description with enough detail for the product page.',
          pdp_how_to_use_raw: 'Apply two drops after cleansing and before moisturizer.',
          pdp_ingredients_raw: 'Water, Glycerin, Niacinamide',
          product_kind: 'single_formula',
          pdp_field_quality_summary: {
            description_raw: { source_quality_status: 'low', reason_codes: ['missing_source_kind'] },
            ingredients_raw: { source_quality_status: 'low', reason_codes: ['missing_source_kind'] },
            how_to_use_raw: { source_quality_status: 'low', reason_codes: ['missing_source_kind'] },
          },
          external_seed_snapshot_contract: {
            contract_version: 'external_seed.snapshot_contract.v1',
            authoritative: true,
            legacy_fields_quarantined: true,
          },
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Preserve Serum',
            url: 'https://example.com/products/preserve-serum',
            product_kind: 'single_formula',
            description_raw: '',
            details_sections: [],
            ingredients_raw: '',
            pdp_how_to_use_raw: '',
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://example.com/products/preserve-serum',
    );

    expect(payload.nextRow.seed_data.pdp_description_raw).toBe(
      'Existing approved description with enough detail for the product page.',
    );
    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).toBe(
      'Apply two drops after cleansing and before moisturizer.',
    );
    expect(payload.nextRow.seed_data.pdp_ingredients_raw).toBe('Water, Glycerin, Niacinamide');
    expect(payload.nextRow.seed_data.snapshot.pdp_how_to_use_raw).toBe(
      'Apply two drops after cleansing and before moisturizer.',
    );
  });

  test('splits encoded Fenty accordion copy into structured PDP sections', () => {
    const fentyAccordion =
      'RECHARGEABLE MIRROR WITH 5X MAGNIFICATION\n\n' +
      'GIVE IT TO ME QUICK\n' +
      'This ain&rsquo;t your average mirror&mdash;it&rsquo;s really the trick of all trades. Keep it at your vanity, pack it in your suitcase, even charge your phone with it.\n\n' +
      'TELL ME MORE\n' +
      '- Adjustable brightness\n' +
      '- 5X magnification for close-up detail\n' +
      '- Wireless charging for your phone\n\n' +
      'Dimensions with base:\n' +
      '- Height: 14.4"\n' +
      '- Width: 6.9"\n\n' +
      'Dimensions - mirror only:\n' +
      '- Height: 8.2"\n' +
      '- Width: 6.9"';
    const row = {
      id: 'eps_fenty_mirror',
      external_product_id: 'ext_fenty_mirror',
      title: 'Fenty Beauty - LED Vanity Mirror',
      canonical_url: 'https://fentybeauty.com/products/led-vanity-mirror',
      destination_url: 'https://fentybeauty.com/products/led-vanity-mirror',
      price_amount: 40,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/led-vanity-mirror',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'LED Vanity Mirror',
            url: 'https://fentybeauty.com/products/led-vanity-mirror',
            description_raw: fentyAccordion,
            details_sections: [
              {
                heading: 'Details',
                body: fentyAccordion,
                source_kind: 'shopify_encoded_accordion_attr',
              },
              {
                heading: 'HEAVY ON THE HYDRATION',
                body: 'Make a splash in juicy makeup, skincare + haircare must-haves.',
                source_kind: 'shopify_encoded_accordion_attr',
              },
            ],
            variants: [
              {
                id: 'mirror-default',
                sku: 'MIRROR-DEFAULT',
                title: 'Default Title',
                description: fentyAccordion,
                price: '40.00',
                currency: 'USD',
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://fentybeauty.com/products/led-vanity-mirror',
    );

    expect(payload.nextRow.seed_data.pdp_description_raw).toContain("This ain't your average mirror");
    expect(payload.nextRow.seed_data.pdp_description_raw).not.toMatch(/TELL ME MORE|Dimensions with base/i);
    expect(payload.nextRow.seed_data.description).toContain("This ain't your average mirror");
    expect(payload.nextRow.seed_data.pdp_details_sections).toEqual([
      {
        heading: 'Overview',
        body: expect.stringContaining("This ain't your average mirror"),
        source_kind: 'shopify_encoded_accordion_attr',
      },
      {
        heading: 'Details',
        body: expect.stringContaining('Adjustable brightness'),
        source_kind: 'shopify_encoded_accordion_attr',
      },
      {
        heading: 'Dimensions',
        body: expect.stringContaining('Dimensions with base:'),
        source_kind: 'shopify_encoded_accordion_attr',
      },
    ]);
    expect(payload.nextRow.seed_data.pdp_details_sections[1].body).not.toMatch(/GIVE IT TO ME QUICK/i);
    expect(JSON.stringify(payload.nextRow.seed_data.pdp_details_sections)).not.toMatch(/HEAVY ON THE HYDRATION|must-haves/i);
    expect(payload.nextRow.seed_data.variants[0].description).toContain("This ain't your average mirror");
    expect(payload.nextRow.seed_data.variants[0].description).not.toMatch(/GIVE IT TO ME QUICK|TELL ME MORE/i);

    const identityPayload = buildIdentityListingSourcePayload(row, payload.nextRow);
    expect(identityPayload.source_listing_ref).toBe('external_seed:ext_fenty_mirror');
    expect(identityPayload.product.pdp_description_raw).toContain("This ain't your average mirror");
    expect(identityPayload.product.pdp_details_sections.map((section) => section.heading)).toEqual([
      'Overview',
      'Details',
      'Dimensions',
    ]);
    expect(JSON.stringify(identityPayload.product)).not.toMatch(/GIVE IT TO ME QUICK|TELL ME MORE|HEAVY ON THE HYDRATION|must-haves/i);
  });

  test('clears formula-only PDP fields from non-formula products', () => {
    const row = {
      id: 'eps_kylie_towel',
      external_product_id: 'ext_kylie_towel',
      title: 'Hooded Bath Towel',
      canonical_url: 'https://kyliecosmetics.com/products/hooded-bath-towel',
      destination_url: 'https://kyliecosmetics.com/products/hooded-bath-towel',
      seed_data: {
        pdp_ingredients_raw: 'Water, Zinc Oxide.',
        pdp_active_ingredients_raw: 'Zinc Oxide 10%',
        pdp_how_to_use_raw: 'Apply generously.',
        active_ingredients: ['Zinc Oxide'],
        snapshot: {
          canonical_url: 'https://kyliecosmetics.com/products/hooded-bath-towel',
          pdp_ingredients_raw: 'Water, Zinc Oxide.',
          pdp_active_ingredients_raw: 'Zinc Oxide 10%',
          pdp_how_to_use_raw: 'Apply generously.',
          activeIngredients: ['Zinc Oxide'],
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Hooded Bath Towel',
            url: 'https://kyliecosmetics.com/products/hooded-bath-towel',
            product_kind: 'general_merchandise',
            description_raw: 'A soft hooded towel for bath time.',
            details_sections: [
              {
                heading: 'Details',
                body: 'Made with cotton terry.',
                source_kind: 'shopify_body_html_labeled_sections',
              },
              {
                heading: 'How to Use',
                body: 'Apply generously.',
                source_kind: 'shopify_body_html_labeled_sections',
              },
              {
                heading: 'Ingredients',
                body: 'Water, Zinc Oxide.',
                source_kind: 'shopify_body_html_labeled_sections',
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://kyliecosmetics.com/products/hooded-bath-towel',
    );

    expect(payload.nextRow.seed_data.product_kind).toBe('general_merchandise');
    expect(payload.nextRow.seed_data.pdp_ingredients_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.active_ingredients).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.pdp_ingredients_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.pdp_active_ingredients_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.pdp_how_to_use_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.activeIngredients).toBeUndefined();
    expect(payload.nextRow.seed_data.pdp_details_sections).toEqual([
      {
        heading: 'Details',
        body: 'Made with cotton terry.',
        source_kind: 'shopify_body_html_labeled_sections',
      },
    ]);
  });

  test('suppresses storefront boilerplate descriptions instead of writing them to PDP fields', () => {
    const boilerplate =
      "Fenty Beauty by Rihanna was created with promise of inclusion for all women. With an unmatched offering of shades and colors for ALL skin tones, you'll never look elsewhere for your beauty staples. Browse our foundation line, lip colors, and so much more.";
    const row = {
      id: 'eps_fenty_bag',
      external_product_id: 'ext_fenty_bag',
      title: 'Fenty Skin Jelly Cherry Bag',
      canonical_url: 'https://fentybeauty.com/products/fenty-skin-jelly-cherry-bag',
      destination_url: 'https://fentybeauty.com/products/fenty-skin-jelly-cherry-bag',
      price_amount: 18,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        description: boilerplate,
        pdp_description_raw: boilerplate,
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/fenty-skin-jelly-cherry-bag',
          description: boilerplate,
          pdp_description_raw: boilerplate,
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Fenty Skin Jelly Cherry Bag',
            url: 'https://fentybeauty.com/products/fenty-skin-jelly-cherry-bag',
            description_raw: boilerplate,
            details_sections: [
              {
                heading: 'Tell us about yourself',
                body: "We'll never show your full name or email Enter your name Enter your name Enter a valid email e.g. example@example.com Enter a valid email e.g. example@example.com Please fill all of the required fields Submit",
                source_kind: 'heading_sibling',
              },
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://fentybeauty.com/products/fenty-skin-jelly-cherry-bag',
    );

    expect(payload.nextRow.seed_data.description).toBeUndefined();
    expect(payload.nextRow.seed_data.pdp_description_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.pdp_details_sections).toBeUndefined();
    expect(payload.nextRow.seed_data.seed_description_origin).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.description).toBe('');
    expect(payload.nextRow.seed_data.snapshot.pdp_description_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.pdp_details_sections).toBeUndefined();
    expect(payload.nextRow.seed_data.derived.recall.retrieval_body).not.toMatch(
      /foundation line|lip colors|all skin tones|tell us about yourself|valid email|required fields/i,
    );
  });

  test('persists canonical pdp_* fields from catalog extraction into seed snapshot', () => {
    const row = {
      id: 'eps_boj_sunscreen',
      external_product_id: 'ext_boj_sunscreen',
      title: 'Relief Sun : Rice + Probiotics (SPF50+ PA++++)',
      canonical_url: 'https://beautyofjoseon.com/products/relief-sun-rice-probiotics-spf50-pa-uk',
      destination_url: 'https://beautyofjoseon.com/products/relief-sun-rice-probiotics-spf50-pa-uk',
      image_url: '',
      price_amount: 18,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        snapshot: {
          canonical_url: 'https://beautyofjoseon.com/products/relief-sun-rice-probiotics-spf50-pa-uk',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Relief Sun : Rice + Probiotics (SPF50+ PA++++)',
            url: 'https://beautyofjoseon.com/products/relief-sun-rice-probiotics-spf50-pa-uk',
            pdp_description_raw: 'A daily sunscreen with rice extract and probiotics.',
            pdp_details_sections: [
              {
                heading: 'How to Use',
                body: 'Apply as the last morning skincare step.',
              },
              {
                heading: 'Ingredients',
                body: 'Water, Dibutyl Adipate, Propanediol, Niacinamide',
              },
            ],
            pdp_ingredients_raw: 'Water, Dibutyl Adipate, Propanediol, Niacinamide',
            pdp_how_to_use_raw: 'Apply as the last morning skincare step.',
            pdp_faq_items: [
              {
                question: 'Can I use it daily?',
                answer: 'Yes, use as the last morning skincare step.',
                source_kind: 'merchant_faq',
              },
            ],
            pdp_field_capture_status: {
              details_sections: 'present',
              ingredients_raw: 'present',
              how_to_use_raw: 'present',
              faq_items: 'present',
            },
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      'https://beautyofjoseon.com/products/relief-sun-rice-probiotics-spf50-pa-uk',
    );

    expect(payload.changed).toBe(true);
    expect(payload.nextRow.seed_data.pdp_description_raw).toBe(
      'A daily sunscreen with rice extract and probiotics.',
    );
    expect(payload.nextRow.seed_data.pdp_details_sections).toHaveLength(2);
    expect(payload.nextRow.seed_data.pdp_ingredients_raw).toBe(
      'Water, Dibutyl Adipate, Propanediol, Niacinamide',
    );
    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).toBe(
      'Apply as the last morning skincare step.',
    );
    expect(payload.nextRow.seed_data.pdp_faq_items).toEqual([
      {
        question: 'Can I use it daily?',
        answer: 'Yes, use as the last morning skincare step.',
        source_kind: 'merchant_faq',
      },
    ]);
    expect(payload.nextRow.seed_data.pdp_field_capture_status).toEqual({
      description_raw: 'present',
      details_sections: 'present',
      ingredients_raw: 'present',
      how_to_use_raw: 'present',
      faq_items: 'present',
    });
  });

  test('matches direct PDP extraction by exact title when localized canonical URL changes', () => {
    const row = {
      id: 'eps_boj_rice_probiotics',
      external_product_id: 'ext_boj_rice_probiotics',
      title: 'Relief Sun : Rice + Probiotics (SPF50+ PA++++)',
      canonical_url: 'https://beautyofjoseon.com/products/relief-sun-rice-probiotics-spf50-pa-uk',
      destination_url: 'https://beautyofjoseon.com/products/relief-sun-rice-probiotics-spf50-pa-uk',
      image_url: '',
      price_amount: 18,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        snapshot: {
          canonical_url: 'https://beautyofjoseon.com/products/relief-sun-rice-probiotics-spf50-pa-uk',
          title: 'Relief Sun : Rice + Probiotics (SPF50+ PA++++)',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
            url: 'https://nl.beautyofjoseon.com/products/relief-sun-aqua-fresh',
            details_sections: [{ heading: 'How to Use', body: 'Apply the aqua-fresh sunscreen.' }],
            variants: [],
          },
          {
            title: 'Relief Sun : Rice + Probiotics (SPF50+ PA++++)',
            url: 'https://nl.beautyofjoseon.com/products/relief-sun-rice-probiotics',
            description_raw: 'A daily sunscreen with rice extract and probiotics.',
            details_sections: [
              {
                heading: 'How to Use',
                body: 'After cleansing, apply a few drops of toner with your hands or a cotton pad.',
              },
              {
                heading: 'How to Use',
                body: 'Apply evenly as the last step in your morning skincare routine.',
              },
              {
                heading: 'Ingredients',
                body: 'Water, Dibutyl Adipate, Propanediol, Niacinamide',
              },
            ],
            ingredients_raw: 'Water, Dibutyl Adipate, Propanediol, Niacinamide',
            how_to_use_raw: 'After cleansing, apply a few drops of toner with your hands or a cotton pad.',
            faq_items: [
              {
                question: 'Can I use it every day?',
                answer: 'Yes, use it as the last step in your morning skincare routine.',
                source_kind: 'merchant_faq',
              },
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      'https://beautyofjoseon.com/products/relief-sun-rice-probiotics-spf50-pa-uk',
    );

    expect(payload.changed).toBe(true);
    expect(payload.nextRow.canonical_url).toBe('https://nl.beautyofjoseon.com/products/relief-sun-rice-probiotics');
    expect(payload.nextRow.seed_data.pdp_details_sections).toEqual([
      {
        heading: 'How to Use',
        body: 'Apply evenly as the last step in your morning skincare routine.',
        source_kind: 'unknown',
      },
      {
        heading: 'Ingredients',
        body: 'Water, Dibutyl Adipate, Propanediol, Niacinamide',
        source_kind: 'unknown',
      },
    ]);
    expect(payload.nextRow.seed_data.pdp_ingredients_raw).toBe(
      'Water, Dibutyl Adipate, Propanediol, Niacinamide',
    );
    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).toBe(
      'Apply evenly as the last step in your morning skincare routine.',
    );
    expect(payload.nextRow.seed_data.pdp_faq_items).toEqual([
      {
        question: 'Can I use it every day?',
        answer: 'Yes, use it as the last step in your morning skincare routine.',
        source_kind: 'merchant_faq',
      },
    ]);
  });

  test('marks PDP field capture status as present when raw fields exist even if extractor status is stale', () => {
    const row = {
      id: 'eps_fenty_fat_water',
      title: 'Fat Water Niacinamide Pore-Refining Toner Serum',
      canonical_url: 'https://fentybeauty.com/products/fat-water-niacinamide-pore-refining-toner-serum-with-barbados-cherry',
      destination_url: 'https://fentybeauty.com/products/fat-water-niacinamide-pore-refining-toner-serum-with-barbados-cherry',
      image_url: '',
      price_amount: 12.6,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        seed_description_origin: 'pdp_variant_description',
        snapshot: {},
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Fat Water Niacinamide Pore-Refining Toner Serum with Barbados Cherry',
            url: 'https://fentybeauty.com/products/fat-water-niacinamide-pore-refining-toner-serum-with-barbados-cherry',
            description_raw: 'A serum-toner hybrid that refines pores.',
            details_sections: [
              {
                heading: 'Ingredients',
                body: 'Niacinamide, Barbados Cherry, Australian Lemon Myrtle',
                source_kind: 'accordion_ingredients',
              },
            ],
            ingredients_raw: 'Niacinamide, Barbados Cherry, Australian Lemon Myrtle',
            field_capture_status: {
              description_raw: 'missing',
              details_sections: 'missing',
              ingredients_raw: 'missing',
              active_ingredients_raw: 'missing',
              how_to_use_raw: 'missing',
            },
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      'https://fentybeauty.com/products/fat-water-niacinamide-pore-refining-toner-serum-with-barbados-cherry',
    );

    expect(payload.nextRow.seed_data.pdp_field_capture_status).toEqual({
      description_raw: 'present',
      details_sections: 'present',
      ingredients_raw: 'present',
      active_ingredients_raw: 'missing',
      how_to_use_raw: 'missing',
    });
    expect(payload.nextRow.seed_data.snapshot.pdp_field_capture_status).toEqual({
      description_raw: 'present',
      details_sections: 'present',
      ingredients_raw: 'present',
      active_ingredients_raw: 'missing',
      how_to_use_raw: 'missing',
    });
  });

  test('uses full How to Use section when extractor raw usage is truncated', () => {
    const row = {
      id: 'eps_sun_stick',
      title: 'Daily Soothing Sun Shield SPF50+ PA++++',
      canonical_url: 'https://haruharuwonder.com/products/haruharuwonder-black-bamboo-daily-soothing-sun-shield-spf50-pa-20g',
      destination_url: 'https://haruharuwonder.com/products/haruharuwonder-black-bamboo-daily-soothing-sun-shield-spf50-pa-20g',
      image_url: '',
      price_amount: 22,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: { snapshot: {} },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: row.title,
            url: row.canonical_url,
            description_raw: 'A portable SPF stick.',
            how_to_use_raw: '1. At the last step of your skincare routine, twist the base to expose',
            details_sections: [
              {
                heading: 'How to Use',
                body: '1. At the last step of your skincare routine, twist the base to expose about 0.5cm of the stick and swipe it thoroughly across any exposed skin. 2. Reapply every 2 hours for optimal protection.',
                source_kind: 'description_delimited_section',
              },
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      row.canonical_url,
    );

    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).toContain('about 0.5cm');
    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).toContain('Reapply every 2 hours');
  });

  test('uses full sunscreen How To section when extractor raw usage is only a heading placeholder', () => {
    const row = {
      id: 'eps_ole_spf',
      title: 'Banana Bright Mineral Sunscreen SPF 30',
      canonical_url: 'https://olehenriksen.com/products/banana-bright-mineral-sunscreen-spf-30',
      destination_url: 'https://olehenriksen.com/products/banana-bright-mineral-sunscreen-spf-30',
      image_url: '',
      price_amount: 35,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: { snapshot: {} },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: row.title,
            url: row.canonical_url,
            product_kind: 'single_formula',
            description_raw: 'A daily broad spectrum mineral SPF 30 sunscreen.',
            how_to_use_raw: 'HOW TO',
            details_sections: [
              {
                heading: 'How to Use',
                body: 'HOW TO',
                source_kind: 'accordion_how_to_use',
              },
              {
                heading: 'HOW TO',
                body: 'After moisturizer, apply generously and evenly to your face and neck 15 minutes before sun exposure and reapply at least every two hours.',
                source_kind: 'heading_sibling',
              },
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      row.canonical_url,
    );

    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).toContain('apply generously');
    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).toContain('reapply at least every two hours');
  });

  test('derives sunscreen active ingredients from official key ingredients section', () => {
    const row = {
      id: 'eps_ole_spf_ingredients',
      title: 'Banana Bright Mineral Sunscreen SPF 30',
      canonical_url: 'https://olehenriksen.com/products/banana-bright-mineral-sunscreen-spf-30',
      destination_url: 'https://olehenriksen.com/products/banana-bright-mineral-sunscreen-spf-30',
      image_url: '',
      price_amount: 35,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: { snapshot: {} },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: row.title,
            url: row.canonical_url,
            product_kind: 'single_formula',
            description_raw: 'A daily broad spectrum mineral SPF 30 sunscreen.',
            ingredients_raw: 'List: Aqua/Water/Eau, Zinc Oxide, Niacinamide.',
            details_sections: [
              {
                heading: 'Ingredients',
                body: '16.3 Zinc Oxide\n\nCreates a physical barrier on your skin.\n\nEnhanced Vitamin C (Ascorbic Acid)\n\nBrightens.\n\nNiacinamide\n\nSupports clearer-looking skin.\n\nAloe Leaf Juice\n\nHydrates.\n\nFull Ingredients List: Aqua/Water/Eau, Zinc Oxide, Niacinamide.',
                source_kind: 'heading_sibling',
              },
            ],
            variants: [],
            field_quality_summary: {
              details_sections: {
                source_origin: 'shopify_json',
                source_quality_status: 'high',
                source_kinds: ['heading_sibling'],
                reason_codes: [],
              },
              active_ingredients_raw: {
                source_origin: 'unknown',
                source_quality_status: 'low',
                source_kinds: [],
                reason_codes: ['missing_source_kind'],
              },
            },
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      row.canonical_url,
    );

    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).toContain('Zinc Oxide 16.3%');
    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).toContain('Enhanced Vitamin C (Ascorbic Acid)');
    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).toContain('Niacinamide');
    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).not.toContain('Creates a physical barrier');
    expect(payload.nextRow.seed_data.active_ingredients).toEqual([
      'Zinc Oxide 16.3%',
      'Enhanced Vitamin C (Ascorbic Acid)',
      'Niacinamide',
      'Aloe Leaf Juice',
    ]);
    expect(payload.nextRow.seed_data.ingredient_tokens).toEqual([
      'Zinc Oxide 16.3%',
      'Enhanced Vitamin C (Ascorbic Acid)',
      'Niacinamide',
      'Aloe Leaf Juice',
    ]);
    expect(
      payload.nextRow.seed_data.pdp_field_quality_summary.active_ingredients_raw,
    ).toEqual(
      expect.objectContaining({
        source_origin: 'shopify_json',
        source_quality_status: 'high',
        source_kinds: expect.arrayContaining(['derived_details_section_ingredients']),
        reason_codes: [],
      }),
    );
    expect(payload.nextRow.seed_data.ingredient_intel.inci_normalized).toBeUndefined();
    expect(payload.nextRow.seed_data.ingredient_intel.authoritative).toBeUndefined();
  });

  test('derives regulatory active ingredients from labeled active inactive INCI blocks', () => {
    const row = {
      id: 'eps_skin1004_sun_serum',
      title: 'Hyalu-Cica Water-Fit Sun Serum UV',
      canonical_url: 'https://www.skin1004.com/products/hyalu-cica-water-fit-sun-serum-uv',
      destination_url: 'https://www.skin1004.com/products/hyalu-cica-water-fit-sun-serum-uv',
      image_url: '',
      price_amount: 24,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: { snapshot: {} },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: row.title,
            url: row.canonical_url,
            product_kind: 'single_formula',
            description_raw: '<!--td {border: 1px solid #cccccc;}--> What it is: A lightweight serum sunscreen.',
            ingredients_raw:
              'Active ingredients : Avobenzone* 2.7%, Homosalate 13.6%, Octisalate* 4.5%, Octocrylene 9%\n\nInactive ingredients : Water, Panthenol, Centella Asiatica Extract',
            how_to_use_raw:
              'Hyalu-Cica Water-Fit Sun Serum UV\nAt the last step of basic skincare, evenly apply on areas exposed to UV rays such as face, neck, arms, and legs.',
            details_sections: [
              {
                heading: 'Benefits',
                body: 'Lightweight, UV Protection, Hydrating',
                source_kind: 'shopify_body_html_labeled_section',
              },
            ],
            variants: [],
            field_quality_summary: {
              description_raw: {
                source_origin: 'shopify_json',
                source_quality_status: 'high',
                source_kinds: ['shopify_description'],
                reason_codes: [],
              },
              details_sections: {
                source_origin: 'shopify_json',
                source_quality_status: 'high',
                source_kinds: ['shopify_body_html_labeled_section'],
                reason_codes: [],
              },
              ingredients_raw: {
                source_origin: 'unknown',
                source_quality_status: 'low',
                source_kinds: [],
                reason_codes: ['missing_source_kind'],
              },
              active_ingredients_raw: {
                source_origin: 'unknown',
                source_quality_status: 'low',
                source_kinds: [],
                reason_codes: ['missing_source_kind'],
              },
            },
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      row.canonical_url,
    );

    expect(payload.nextRow.seed_data.pdp_description_raw).not.toMatch(/td \{border/i);
    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).toBe(
      'At the last step of basic skincare, evenly apply on areas exposed to UV rays such as face, neck, arms, and legs.',
    );
    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).toBe(
      'Avobenzone 2.7%\nHomosalate 13.6%\nOctisalate 4.5%\nOctocrylene 9%',
    );
    expect(payload.nextRow.seed_data.active_ingredients).toEqual([
      'Avobenzone 2.7%',
      'Homosalate 13.6%',
      'Octisalate 4.5%',
      'Octocrylene 9%',
    ]);
    expect(payload.nextRow.seed_data.pdp_field_quality_summary.ingredients_raw).toEqual(
      expect.objectContaining({
        source_origin: 'shopify_json',
        source_quality_status: 'high',
        source_kinds: expect.arrayContaining(['derived_labeled_ingredients_from_source_context']),
      }),
    );
    expect(payload.nextRow.seed_data.pdp_field_quality_summary.active_ingredients_raw).toEqual(
      expect.objectContaining({
        source_origin: 'shopify_json',
        source_quality_status: 'high',
        source_kinds: expect.arrayContaining(['derived_labeled_active_ingredients_from_inci']),
        reason_codes: [],
      }),
    );
  });

  test('derives active ingredients from existing labeled INCI when refreshed extractor omits INCI', () => {
    const row = {
      id: 'eps_skin1004_existing_inci',
      title: 'Hyalu-Cica Water-Fit Sun Serum UV',
      canonical_url: 'https://www.skin1004.com/products/hyalu-cica-water-fit-sun-serum-uv',
      destination_url: 'https://www.skin1004.com/products/hyalu-cica-water-fit-sun-serum-uv',
      image_url: '',
      price_amount: 24,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        pdp_ingredients_raw:
          'Active ingredients : Avobenzone* 2.7%, Homosalate 13.6%, Octisalate* 4.5%, Octocrylene 9%\n\nInactive ingredients : Water, Panthenol',
        snapshot: {
          pdp_ingredients_raw:
            'Active ingredients : Avobenzone* 2.7%, Homosalate 13.6%, Octisalate* 4.5%, Octocrylene 9%\n\nInactive ingredients : Water, Panthenol',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: row.title,
            url: row.canonical_url,
            product_kind: 'single_formula',
            description_raw: 'A lightweight serum sunscreen.',
            details_sections: [
              {
                heading: 'Benefits',
                body: 'Lightweight, UV Protection, Hydrating',
                source_kind: 'shopify_body_html_labeled_section',
              },
            ],
            variants: [],
            field_quality_summary: {
              description_raw: {
                source_origin: 'shopify_json',
                source_quality_status: 'high',
                source_kinds: ['shopify_description'],
                reason_codes: [],
              },
              details_sections: {
                source_origin: 'shopify_json',
                source_quality_status: 'high',
                source_kinds: ['shopify_body_html_labeled_section'],
                reason_codes: [],
              },
            },
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      row.canonical_url,
    );

    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).toBe(
      'Avobenzone 2.7%\nHomosalate 13.6%\nOctisalate 4.5%\nOctocrylene 9%',
    );
    expect(payload.nextRow.seed_data.active_ingredients).toEqual([
      'Avobenzone 2.7%',
      'Homosalate 13.6%',
      'Octisalate 4.5%',
      'Octocrylene 9%',
    ]);
    expect(payload.nextRow.seed_data.pdp_field_quality_summary.active_ingredients_raw).toEqual(
      expect.objectContaining({
        source_origin: 'shopify_json',
        source_quality_status: 'high',
        source_kinds: expect.arrayContaining(['derived_labeled_active_ingredients_from_existing_inci']),
        reason_codes: [],
      }),
    );
  });

  test('reapplies approved PDP ingredient fields after legacy enrichment changes structured arrays', () => {
    const row = reapplyApprovedPdpIngredientFieldsToRow({
      seed_data: {
        pdp_ingredients_raw: 'List: Aqua/Water/Eau, Zinc Oxide, Niacinamide.',
        pdp_active_ingredients_raw:
          'Zinc Oxide 16.3%\nEnhanced Vitamin C (Ascorbic Acid)\nNiacinamide',
        active_ingredients: ['Panthenol (B5)', 'Zinc PCA'],
        key_ingredients: ['Panthenol (B5)', 'Zinc PCA'],
        ingredient_tokens: ['Panthenol (B5)', 'Zinc PCA'],
        ingredient_intel: {
          active_ingredients: ['Panthenol (B5)', 'Zinc PCA'],
          key_ingredients: ['Panthenol (B5)', 'Zinc PCA'],
          inci_normalized: ['Panthenol (B5)', 'Zinc PCA'],
          authoritative: {
            active_items: ['Zinc PCA'],
          },
        },
        snapshot: {
          pdp_ingredients_raw: 'List: Aqua/Water/Eau, Zinc Oxide, Niacinamide.',
          pdp_active_ingredients_raw:
            'Zinc Oxide 16.3%\nEnhanced Vitamin C (Ascorbic Acid)\nNiacinamide',
          active_ingredients: ['Panthenol (B5)', 'Zinc PCA'],
          key_ingredients: ['Panthenol (B5)', 'Zinc PCA'],
          ingredient_tokens: ['Panthenol (B5)', 'Zinc PCA'],
          ingredient_intel: {
            active_ingredients: ['Panthenol (B5)', 'Zinc PCA'],
            key_ingredients: ['Panthenol (B5)', 'Zinc PCA'],
            inci_normalized: ['Panthenol (B5)', 'Zinc PCA'],
            authoritative: {
              active_items: ['Zinc PCA'],
            },
          },
        },
      },
    });

    const expectedActives = [
      'Zinc Oxide 16.3%',
      'Enhanced Vitamin C (Ascorbic Acid)',
      'Niacinamide',
    ];
    expect(row.seed_data.active_ingredients).toEqual(expectedActives);
    expect(row.seed_data.key_ingredients).toEqual(expectedActives);
    expect(row.seed_data.ingredient_tokens).toEqual(expectedActives);
    expect(row.seed_data.raw_ingredient_text_clean).toBe(
      'List: Aqua/Water/Eau, Zinc Oxide, Niacinamide.',
    );
    expect(row.seed_data.inci_list).toBe('List: Aqua/Water/Eau, Zinc Oxide, Niacinamide.');
    expect(row.seed_data.ingredient_intel.inci_normalized).toBeUndefined();
    expect(row.seed_data.ingredient_intel.authoritative).toBeUndefined();
    expect(row.seed_data.snapshot.active_ingredients).toEqual(expectedActives);
    expect(row.seed_data.snapshot.ingredient_intel.inci_normalized).toBeUndefined();
    expect(row.seed_data.snapshot.ingredient_intel.authoritative).toBeUndefined();
  });

  test('preserves reviewed source-backed active arrays when active raw contains explanatory copy', () => {
    const row = reapplyApprovedPdpIngredientFieldsToRow({
      seed_data: {
        pdp_active_ingredients_raw:
          'SALICYLIC ACID (BHA)\nOTC-LEVEL, EXFOLIATES SKIN, TARGETS + TREATS ACNE',
        active_ingredients: ['Salicylic acid'],
        reviewed_active_ingredients_v1: {
          contract_version: 'external_seed.reviewed_active_ingredients.v1',
          status: 'approved',
        },
        ingredient_intel: {
          active_ingredients: ['Salicylic acid'],
        },
        snapshot: {
          pdp_active_ingredients_raw:
            'SALICYLIC ACID (BHA)\nOTC-LEVEL, EXFOLIATES SKIN, TARGETS + TREATS ACNE',
          active_ingredients: ['Salicylic acid'],
          reviewed_active_ingredients_v1: {
            contract_version: 'external_seed.reviewed_active_ingredients.v1',
            status: 'approved',
          },
          ingredient_intel: {
            active_ingredients: ['Salicylic acid'],
          },
        },
      },
    });

    expect(row.seed_data.active_ingredients).toEqual(['Salicylic acid']);
    expect(row.seed_data.ingredient_intel.active_ingredients).toEqual(['Salicylic acid']);
    expect(row.seed_data.active_ingredients).not.toContain('OTC-LEVEL, EXFOLIATES SKIN, TARGETS + TREATS ACNE');
    expect(row.seed_data.snapshot.active_ingredients).toEqual(['Salicylic acid']);
  });

  test('reviewed active contract wins over newly extracted active array during backfill', () => {
    const seedData = applyReviewedActiveIngredientContract({
      active_ingredients: ['Peptides', 'Lactic acid'],
      ingredient_intel: {
        active_ingredients: ['Peptides', 'Lactic acid'],
      },
      reviewed_active_ingredients_v1: {
        contract_version: 'external_seed.reviewed_active_ingredients.v1',
        status: 'approved',
        active_ingredients: ['Peptides'],
      },
      snapshot: {
        active_ingredients: ['Peptides', 'Lactic acid'],
        ingredient_intel: {
          active_ingredients: ['Peptides', 'Lactic acid'],
        },
      },
    });

    expect(seedData.active_ingredients).toEqual(['Peptides']);
    expect(seedData.ingredient_intel.active_ingredients).toEqual(['Peptides']);
    expect(seedData.snapshot.active_ingredients).toEqual(['Peptides']);
    expect(seedData.snapshot.ingredient_intel.active_ingredients).toEqual(['Peptides']);
  });

  test('post-enrichment ingredient reapply preserves reviewed active contract', () => {
    const row = reapplyApprovedPdpIngredientFieldsToRow({
      seed_data: {
        pdp_active_ingredients_raw: 'Peptides\nLactic acid',
        active_ingredients: ['Peptides', 'Lactic acid'],
        ingredient_intel: {
          active_ingredients: ['Peptides', 'Lactic acid'],
        },
        reviewed_active_ingredients_v1: {
          contract_version: 'external_seed.reviewed_active_ingredients.v1',
          status: 'approved',
          active_ingredients: ['Peptides'],
        },
        snapshot: {
          pdp_active_ingredients_raw: 'Peptides\nLactic acid',
          active_ingredients: ['Peptides', 'Lactic acid'],
          ingredient_intel: {
            active_ingredients: ['Peptides', 'Lactic acid'],
          },
        },
      },
    });

    expect(row.seed_data.active_ingredients).toEqual(['Peptides']);
    expect(row.seed_data.ingredient_intel.active_ingredients).toEqual(['Peptides']);
    expect(row.seed_data.snapshot.active_ingredients).toEqual(['Peptides']);
    expect(row.seed_data.snapshot.ingredient_intel.active_ingredients).toEqual(['Peptides']);
  });

  test('post-enrichment ingredient reapply enforces reviewed contract even without raw PDP active text', () => {
    const row = reapplyApprovedPdpIngredientFieldsToRow({
      seed_data: {
        active_ingredients: ['Peptides', 'Lactic acid'],
        ingredient_intel: {
          active_ingredients: ['Peptides', 'Lactic acid'],
        },
        snapshot: {
          active_ingredients: ['Peptides', 'Lactic acid'],
          ingredient_intel: {
            active_ingredients: ['Peptides', 'Lactic acid'],
          },
          reviewed_active_ingredients_v1: {
            contract_version: 'external_seed.reviewed_active_ingredients.v1',
            status: 'approved',
            active_ingredients: ['Peptides'],
          },
        },
      },
    });

    expect(row.seed_data.active_ingredients).toEqual(['Peptides']);
    expect(row.seed_data.ingredient_intel.active_ingredients).toEqual(['Peptides']);
    expect(row.seed_data.snapshot.active_ingredients).toEqual(['Peptides']);
    expect(row.seed_data.snapshot.ingredient_intel.active_ingredients).toEqual(['Peptides']);
  });

  test('cleans polluted PDP ingredients and active ingredient tails before seed writes', () => {
    const row = {
      id: 'eps_body_oil',
      title: 'Daily Smoothing Body Oil',
      canonical_url: 'https://haruharuwonder.com/products/haruharuwonder-black-bamboo-daily-smoothing-body-oil-200ml',
      destination_url: 'https://haruharuwonder.com/products/haruharuwonder-black-bamboo-daily-smoothing-body-oil-200ml',
      image_url: '',
      price_amount: 24,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: { snapshot: {} },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: row.title,
            url: row.canonical_url,
            description_raw: 'A smoothing body oil.',
            ingredients_raw:
              'Key Ingredients - Urea - Moisturizes\n\nIngredients\n\nWater, Glycerin, Urea, Mandelic Acid, Squalane, Linalool Details The Smoothing Body Oil is a milk-type oil.',
            active_ingredients_raw:
              'Urea - Moisturizes\n\nMandelic Acid (AHA) - Exfoliates\nFree From:\n- Sulfates\nFull Ingredients',
            details_sections: [],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      row.canonical_url,
    );

    expect(payload.nextRow.seed_data.pdp_ingredients_raw).toBe(
      'Water, Glycerin, Urea, Mandelic Acid, Squalane, Linalool',
    );
    expect(payload.nextRow.seed_data.pdp_ingredients_raw).not.toMatch(/Details|milk-type/i);
    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).toBe(
      'Urea - Moisturizes\n\nMandelic Acid (AHA) - Exfoliates',
    );
    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).not.toMatch(/Free From|Full Ingredients/i);
  });

  test('removes stale narrative ingredient fallback when catalog has no INCI', () => {
    const row = {
      id: 'eps_roundlab_mask',
      title: 'Camellia Deep Collagen V Lifting Gel Mask',
      canonical_url: 'https://roundlab.com/products/camellia-deep-collagen-v-lifting-gel-mask',
      destination_url: 'https://roundlab.com/products/camellia-deep-collagen-v-lifting-gel-mask',
      image_url: '',
      price_amount: 6,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        pdp_ingredients_raw:
          'Round Lab is inspired by and encapsulates natural ingredients from the Korean Peninsula – where clean water, mountain peaks and gusty winds meet. Known as the beauty capital of the world, it is a land gifted with natural resources and ingredients with powerful vitality that breathes vibrancy and purity into skin.',
        snapshot: {
          pdp_ingredients_raw:
            'Round Lab is inspired by and encapsulates natural ingredients from the Korean Peninsula – where clean water, mountain peaks and gusty winds meet. Known as the beauty capital of the world, it is a land gifted with natural resources and ingredients with powerful vitality that breathes vibrancy and purity into skin.',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: row.title,
            url: row.canonical_url,
            description_raw: 'A hydrogel chin strap mask.',
            active_ingredients_raw:
              'Jeju Camellia Flower Extract • Multi-Weight Collagen • 8-Peptide Complex • Caffeine • Niacinamide',
            how_to_use_raw: 'Apply after cleansing and toning. Relax for 20-30 minutes.',
            details_sections: [],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      row.canonical_url,
    );

    expect(payload.nextRow.seed_data.pdp_ingredients_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.pdp_ingredients_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).toMatch(/Jeju Camellia Flower Extract/i);
  });

  test('removes punctuation-only active ingredient fallback when catalog has no active block', () => {
    const row = {
      id: 'eps_roundlab_sampler',
      title: 'Round Lab Sheet Mask Sampler - 9pc',
      canonical_url: 'https://roundlab.com/products/roundlab-mask-sampler',
      destination_url: 'https://roundlab.com/products/roundlab-mask-sampler',
      image_url: '',
      price_amount: 30,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        pdp_active_ingredients_raw: '–',
        pdp_field_capture_status: {
          active_ingredients_raw: 'present',
        },
        snapshot: {
          pdp_active_ingredients_raw: '–',
          pdp_field_capture_status: {
            active_ingredients_raw: 'present',
          },
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: row.title,
            url: row.canonical_url,
            description_raw: 'A set of sheet masks.',
            details_sections: [
              {
                heading: 'Clean & gentle formula',
                body: 'Free from harsh ingredients, making it safe for all skin types.',
                source_kind: 'shopify_body_html_section',
              },
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      row.canonical_url,
    );

    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.pdp_active_ingredients_raw).toBeUndefined();
    expect(payload.nextRow.seed_data.pdp_field_capture_status.active_ingredients_raw).toBe('missing');
  });

  test('cleans PDP detail section tails before seed writes', () => {
    const row = {
      id: 'eps_sun_stick',
      title: 'Daily Soothing Sun Shield SPF50+ PA++++',
      canonical_url: 'https://haruharuwonder.com/products/haruharuwonder-black-bamboo-daily-soothing-sun-shield-spf50-pa-20g',
      destination_url: 'https://haruharuwonder.com/products/haruharuwonder-black-bamboo-daily-soothing-sun-shield-spf50-pa-20g',
      image_url: '',
      price_amount: 22,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: { snapshot: {} },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: row.title,
            url: row.canonical_url,
            description_raw: 'A portable SPF stick.',
            details_sections: [
              {
                heading: 'Key Ingredients',
                body:
                  'Niacinamide - Brightens / Provides pigmentation care\n\nAdenosine - Reduces fine lines\nFree from:\nToxic additives\nFull Ingredients',
                source_kind: 'description_delimited_section',
              },
              {
                heading: 'Details',
                body:
                  'Benefits: A white-cast free vegan chemical sun stick with broad spectrum SPF50+ PA++++. Free of potentially harmful additives',
                source_kind: 'description_delimited_section',
              },
              {
                heading: 'Benefits',
                body:
                  'A white-cast free vegan chemical sun stick with broad spectrum SPF50+ PA++++. Free of potentially harmful additives',
                source_kind: 'description_delimited_section',
              },
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      row.canonical_url,
    );

    const sections = payload.nextRow.seed_data.pdp_details_sections;
    expect(sections).toContainEqual(
      expect.objectContaining({
        heading: 'Key Ingredients',
        body: 'Niacinamide - Brightens / Provides pigmentation care\n\nAdenosine - Reduces fine lines',
      }),
    );
    expect(sections.map((section) => section.body).join('\n')).not.toMatch(/Free from|Full Ingredients|potentially harmful/i);
    expect(sections.filter((section) => section.heading === 'Benefits')).toHaveLength(1);
  });

  test('clears stale top-level seed description when a blocked seed still has no product URLs', () => {
    const row = {
      id: 'eps_blocked_collection',
      title: 'The Hair & Scalp Collection',
      canonical_url: 'https://theordinary.com/en-us/the-hair-and-scalp-collection-300127.html',
      destination_url: 'https://theordinary.com/en-us/the-hair-and-scalp-collection-300127.html',
      image_url: '',
      price_amount: 0,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'The Hair & Scalp Collection',
        description: 'Eine tägliche Kollektion für gesünder aussehendes Haar und Kopfhaut.',
        snapshot: {
          canonical_url: 'https://theordinary.com/en-us/the-hair-and-scalp-collection-300127.html',
          description: 'Eine tägliche Kollektion für gesünder aussehendes Haar und Kopfhaut.',
          diagnostics: { failure_category: 'no_product_urls' },
        },
        variants: [],
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [],
        variants: [],
        diagnostics: { failure_category: 'no_product_urls' },
      },
      'https://theordinary.com/en-us/the-hair-and-scalp-collection-300127.html',
    );

    expect(payload.nextRow.seed_data.description).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.description).toBe('');
    expect(payload.nextRow.seed_data.snapshot.diagnostics).toEqual({ failure_category: 'no_product_urls' });
  });

  test('preserves manual description overrides even when the refreshed seed remains blocked', () => {
    const row = {
      id: 'eps_manual_clear_set',
      title: 'The Clear Set',
      canonical_url: 'https://theordinary.com/en-us/the-clear-set-100630.html',
      destination_url: 'https://theordinary.com/en-us/the-clear-set-100630.html',
      image_url: '',
      price_amount: 0,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'The Clear Set',
        description: 'A 3-step regimen with Salicylic Acid 2% Solution for clearer skin',
        manual_overrides: {
          description: 'A 3-step regimen with Salicylic Acid 2% Solution for clearer skin',
        },
        snapshot: {
          canonical_url: 'https://theordinary.com/en-us/the-clear-set-100630.html',
          description: '',
          diagnostics: { failure_category: 'no_product_urls' },
        },
        variants: [],
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [],
        variants: [],
        diagnostics: { failure_category: 'no_product_urls' },
      },
      'https://theordinary.com/en-us/the-clear-set-100630.html',
    );

    expect(payload.nextRow.seed_data.description).toBe(
      'A 3-step regimen with Salicylic Acid 2% Solution for clearer skin',
    );
  });

  test('applies manual image overrides when extraction and stored seed images are both empty', () => {
    const row = {
      id: 'eps_patyka_bundle',
      title: 'Duo Mousse Nettoyante Detox - BOUTIQUE SPA',
      canonical_url: 'https://patyka.com/products/duo-mousse-nettoyante-detox-boutique-spa',
      destination_url: 'https://patyka.com/products/duo-mousse-nettoyante-detox-boutique-spa',
      image_url: '',
      price_amount: 23.85,
      price_currency: 'EUR',
      availability: 'in_stock',
      seed_data: {
        brand: 'Patyka',
        snapshot: {
          canonical_url: 'https://patyka.com/products/duo-mousse-nettoyante-detox-boutique-spa',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [],
        variants: [],
        diagnostics: { failure_category: null },
      },
      'https://patyka.com/products/duo-mousse-nettoyante-detox-boutique-spa',
    );

    expect(payload.nextRow.image_url).toBe(
      'https://cdn.shopify.com/s/files/1/2139/2967/files/Duo_Mousse_Nettoyante_Detox_-_Packshot.jpg?v=1750422282',
    );
    expect(payload.nextRow.seed_data.image_urls).not.toContain(
      'https://cdn.shopify.com/s/files/1/2139/2967/files/Mousse_Nettoyante_Detox_-_Texture.jpg?v=1763980849',
    );
    expect(payload.nextRow.seed_data.snapshot.diagnostics).toEqual(
      expect.objectContaining({
        failure_category: null,
        manual_image_override: expect.objectContaining({
          applied: true,
          source: 'manual_seed_override',
        }),
      }),
    );
  });

  test('comparableSeedData ignores enrichment synced_at churn for idempotent postchecks', () => {
    const base = comparableSeedData({
      ingredient_intel: {
        external_seed_enrichment: {
          source: 'pdp_ingredient_fields',
          synced_at: '2026-03-23T01:00:00.000Z',
        },
      },
      snapshot: {
        extracted_at: '2026-03-23T01:00:00.000Z',
        ingredient_intel: {
          external_seed_enrichment: {
            source: 'pdp_ingredient_fields',
            synced_at: '2026-03-23T01:00:00.000Z',
          },
        },
      },
    });
    const next = comparableSeedData({
      ingredient_intel: {
        external_seed_enrichment: {
          source: 'pdp_ingredient_fields',
          synced_at: '2026-03-23T02:00:00.000Z',
        },
      },
      snapshot: {
        extracted_at: '2026-03-23T02:00:00.000Z',
        ingredient_intel: {
          external_seed_enrichment: {
            source: 'pdp_ingredient_fields',
            synced_at: '2026-03-23T02:00:00.000Z',
          },
        },
      },
    });

    expect(base).toEqual(next);
    expect(base.ingredient_intel.external_seed_enrichment.synced_at).toBeNull();
    expect(base.snapshot.ingredient_intel.external_seed_enrichment.synced_at).toBeNull();
  });

  test('comparableSeedData ignores object key ordering churn inside pdp sections and variants', () => {
    const before = comparableSeedData({
      pdp_details_sections: [
        {
          body: 'Water, Glycerin',
          heading: 'Ingredients',
          source_kind: 'accordion_button',
        },
      ],
      variants: [
        {
          sku: '83008',
          url: 'https://pixibeauty.example.com/products/rose-ceramide-cream',
          price: '24.00',
          stock: 'In Stock',
          currency: 'USD',
          image_url: 'https://example.com/rose.jpg',
          image_urls: ['https://example.com/rose.jpg'],
          variant_id: '12268097536096',
          description: '',
          option_name: 'Title',
          option_value: 'Default Title',
        },
      ],
      snapshot: {
        pdp_details_sections: [
          {
            body: 'Water, Glycerin',
            heading: 'Ingredients',
            source_kind: 'accordion_button',
          },
        ],
        variants: [
          {
            sku: '83008',
            url: 'https://pixibeauty.example.com/products/rose-ceramide-cream',
            price: '24.00',
            stock: 'In Stock',
            currency: 'USD',
            image_url: 'https://example.com/rose.jpg',
            image_urls: ['https://example.com/rose.jpg'],
            variant_id: '12268097536096',
            description: '',
            option_name: 'Title',
            option_value: 'Default Title',
          },
        ],
      },
    });

    const after = comparableSeedData({
      pdp_details_sections: [
        {
          heading: 'Ingredients',
          body: 'Water, Glycerin',
          source_kind: 'accordion_button',
        },
      ],
      variants: [
        {
          sku: '83008',
          variant_id: '12268097536096',
          url: 'https://pixibeauty.example.com/products/rose-ceramide-cream',
          option_name: 'Title',
          option_value: 'Default Title',
          price: '24.00',
          currency: 'USD',
          stock: 'In Stock',
          image_url: 'https://example.com/rose.jpg',
          image_urls: ['https://example.com/rose.jpg'],
          description: '',
        },
      ],
      snapshot: {
        pdp_details_sections: [
          {
            heading: 'Ingredients',
            body: 'Water, Glycerin',
            source_kind: 'accordion_button',
          },
        ],
        variants: [
          {
            sku: '83008',
            variant_id: '12268097536096',
            url: 'https://pixibeauty.example.com/products/rose-ceramide-cream',
            option_name: 'Title',
            option_value: 'Default Title',
            price: '24.00',
            currency: 'USD',
            stock: 'In Stock',
            image_url: 'https://example.com/rose.jpg',
            image_urls: ['https://example.com/rose.jpg'],
            description: '',
          },
        ],
      },
    });

    expect(before).toEqual(after);
  });

  test('drops decorative extracted images and stale active ingredients during backfill refresh', () => {
    const row = {
      id: 'eps_tom_ford_cleanup',
      title: 'TOM FORD RESEARCH Cleansing Concentrate',
      canonical_url: 'https://www.tomfordbeauty.com/products/tom-ford-research-cleansing-concentrate',
      destination_url: 'https://www.tomfordbeauty.com/products/tom-ford-research-cleansing-concentrate',
      image_url: 'https://www.tomfordbeauty.com/cdn/shop/files/Menu.svg?v=1771253635&width=24',
      price_amount: 100,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Tom Ford Beauty',
        active_ingredients: ['Glycerin', 'Hyaluronic acid'],
        image_urls: [
          'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774376808',
          'https://www.tomfordbeauty.com/cdn/shop/files/tf_sku_T93Y01_2000x2000_0.png?v=1774376808&width=2000',
          'https://www.tomfordbeauty.com/cdn/shop/files/Menu.svg?v=1771253635&width=24',
          'https://sdcdn.io/tf/tf_sku_TAGL01_2000x2000_0.png?width=650px&height=750px',
        ],
        snapshot: {
          canonical_url: 'https://www.tomfordbeauty.com/products/tom-ford-research-cleansing-concentrate',
          image_urls: [
            'https://www.tomfordbeauty.com/cdn/shop/files/icon-cart.svg?v=1758691434&width=24',
          ],
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'TOM FORD RESEARCH Cleansing Concentrate',
            url: 'https://www.tomfordbeauty.com/products/tom-ford-research-cleansing-concentrate',
            image_url: 'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
              'https://www.tomfordbeauty.com/cdn/shop/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807&width=2000',
              'https://www.tomfordbeauty.com/cdn/shop/files/Menu.svg?v=1771253635&width=24',
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://www.tomfordbeauty.com/products/tom-ford-research-cleansing-concentrate',
    );

    expect(payload.nextRow.image_url).toBe(
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
    );
    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
    ]);
    expect(payload.nextRow.seed_data.snapshot.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
    ]);
    expect(payload.nextRow.seed_data.active_ingredients).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.active_ingredients).toBeUndefined();
  });

  test('persists extracted size evidence and size detail labels during backfill refresh', () => {
    const row = {
      id: 'eps_rare_primer_mini',
      title: 'Always an Optimist Pore Diffusing Primer Mini',
      canonical_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
      destination_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
      price_amount: 17,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Rare Beauty',
        snapshot: {
          canonical_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
          variants: [],
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Always an Optimist Pore Diffusing Primer Mini',
            url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
            image_url: 'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-Travel-SKU.jpg?v=1762270689',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-Travel-SKU.jpg?v=1762270689',
            ],
            volume: '15ml',
            product_volume: '0.50 fl oz',
            size_detail_label: '0.50 fl oz / 15 mL',
            variants: [
              {
                id: '39265890762887',
                sku: 'FGPAOP0002M4',
                url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini?variant=39265890762887',
                option_name: 'Size',
                option_value: '15ml',
                price: '17.00',
                currency: 'USD',
                stock: 'In Stock',
                image_url: 'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-Travel-SKU.jpg?v=1762270689',
                image_urls: [
                  'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-Travel-SKU.jpg?v=1762270689',
                ],
                ad_copy: '',
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
    );

    expect(payload.nextRow.seed_data.volume).toBe('15ml');
    expect(payload.nextRow.seed_data.product_volume).toBe('0.50 fl oz');
    expect(payload.nextRow.seed_data.size_detail_label).toBe('0.50 fl oz / 15 mL');
    expect(payload.nextRow.seed_data.snapshot.volume).toBe('15ml');
    expect(payload.nextRow.seed_data.snapshot.product_volume).toBe('0.50 fl oz');
    expect(payload.nextRow.seed_data.snapshot.size_detail_label).toBe('0.50 fl oz / 15 mL');
    expect(payload.nextRow.seed_data.variants[0]).toEqual(
      expect.objectContaining({
        option_name: 'Size',
        option_value: '15ml',
      }),
    );
  });

  test('infers size detail labels from extracted quantitative variant evidence when explicit label is absent', () => {
    const row = {
      id: 'seed-find-comfort-mini',
      market: 'US',
      tool: '*',
      destination_url: 'https://rarebeauty.com/products/find-comfort-mini-body-essentials-awaken-confidence',
      canonical_url: 'https://rarebeauty.com/products/find-comfort-mini-body-essentials-awaken-confidence',
      domain: 'rarebeauty.com',
      title: 'Find Comfort Mini Body Essentials - Awaken Confidence',
      image_url: 'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/find-comfort-kit.jpg?v=1',
      price_amount: 28,
      price_currency: 'USD',
      availability: 'in_stock',
      status: 'active',
      external_product_id: 'ext_rare_kit_mini',
      seed_data: {
        brand: 'Rare Beauty',
        snapshot: {
          title: 'Find Comfort Mini Body Essentials - Awaken Confidence',
          canonical_url: 'https://rarebeauty.com/products/find-comfort-mini-body-essentials-awaken-confidence',
          destination_url: 'https://rarebeauty.com/products/find-comfort-mini-body-essentials-awaken-confidence',
          variants: [
            {
              variant_id: 'rare-kit-mini-default',
              title: '75ml',
              option_name: 'Size',
              option_value: '75ml',
              price: '28.00',
              currency: 'USD',
            },
          ],
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Find Comfort Mini Body Essentials - Awaken Confidence',
            url: 'https://rarebeauty.com/products/find-comfort-mini-body-essentials-awaken-confidence',
            image_url: 'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/find-comfort-kit.jpg?v=1',
            image_urls: ['https://cdn.shopify.com/s/files/1/0314/1143/7703/products/find-comfort-kit.jpg?v=1'],
            variants: [
              {
                id: 'rare-kit-mini-default',
                sku: 'FIND-COMFORT-MINI',
                url: 'https://rarebeauty.com/products/find-comfort-mini-body-essentials-awaken-confidence?variant=1',
                option_name: 'Size',
                option_value: '75ml',
                title: '75ml',
                price: '28.00',
                currency: 'USD',
                stock: 'In Stock',
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://rarebeauty.com/products/find-comfort-mini-body-essentials-awaken-confidence',
    );

    expect(payload.nextRow.seed_data.size_detail_label).toBe('75 mL');
    expect(payload.nextRow.seed_data.snapshot.size_detail_label).toBe('75 mL');
  });

  test('extracts anchored net weight evidence for single-SKU placeholder variants', () => {
    const row = {
      id: 'seed_medicube_red_succinic',
      market: 'US',
      tool: '*',
      destination_url: 'https://medicube.us/products/red-succinic-acid-peel',
      canonical_url: 'https://medicube.us/products/red-succinic-acid-peel',
      domain: 'medicube.us',
      title: '21% Red Succinic Acid Cleansing Booster Serum',
      image_url: 'https://cdn.shopify.com/s/files/1/0156/3905/2336/files/red-succinic.jpg?v=1',
      price_amount: 20.5,
      price_currency: 'USD',
      availability: 'in_stock',
      status: 'active',
      external_product_id: 'ext_59522af9624198656cc8881b',
      seed_data: {
        brand: 'Medicube',
        snapshot: {
          title: '21% Red Succinic Acid Cleansing Booster Serum',
          canonical_url: 'https://medicube.us/products/red-succinic-acid-peel',
          destination_url: 'https://medicube.us/products/red-succinic-acid-peel',
          variants: [
            {
              variant_id: '40118361587760',
              title: 'SINGLE',
              option_name: 'Option',
              option_value: 'SINGLE',
              price: '20.50',
              currency: 'USD',
            },
          ],
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: '21% Red Succinic Acid Cleansing Booster Serum',
            url: 'https://medicube.us/products/red-succinic-acid-peel',
            image_url: 'https://cdn.shopify.com/s/files/1/0156/3905/2336/files/red-succinic.jpg?v=1',
            image_urls: ['https://cdn.shopify.com/s/files/1/0156/3905/2336/files/red-succinic.jpg?v=1'],
            description:
              '<p style=\"color: #c8002f\">An Acne Cleansing Booster Serum.<br />Net weight: 40 g | 1.41 oz.</p>' +
              '<p>Tip! Pour 700ml of lukewarm water in the sink and apply a drop.</p>',
            variants: [
              {
                id: '40118361587760',
                sku: 'PMEUS55003R00',
                url: 'https://medicube.us/products/red-succinic-acid-peel',
                option_name: 'Option',
                option_value: 'SINGLE',
                title: 'SINGLE',
                price: '20.50',
                currency: 'USD',
                stock: 'In Stock',
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://medicube.us/products/red-succinic-acid-peel',
    );

    expect(payload.nextRow.seed_data.net_content).toBe('40 g');
    expect(payload.nextRow.seed_data.net_size).toBe('1.41 oz');
    expect(payload.nextRow.seed_data.size_detail_label).toBe('1.41 oz / 40 g');
    expect(payload.nextRow.seed_data.snapshot.net_content).toBe('40 g');
    expect(payload.nextRow.seed_data.snapshot.net_size).toBe('1.41 oz');
    expect(payload.nextRow.seed_data.snapshot.size_detail_label).toBe('1.41 oz / 40 g');
  });

  test('hydrates single-SKU placeholder variants from direct PDP anchored size evidence during processRow', async () => {
    const row = {
      id: 'seed_medicube_red_succinic_process',
      market: 'US',
      tool: '*',
      destination_url: 'https://medicube.us/products/red-succinic-acid-peel',
      canonical_url: 'https://medicube.us/products/red-succinic-acid-peel',
      domain: 'medicube.us',
      title: '21% Red Succinic Acid Cleansing Booster Serum',
      image_url: 'https://cdn.shopify.com/s/files/1/0156/3905/2336/files/red-succinic.jpg?v=1',
      price_amount: 20.5,
      price_currency: 'USD',
      availability: 'in_stock',
      status: 'active',
      external_product_id: 'ext_59522af9624198656cc8881b',
      seed_data: {
        brand: 'Medicube',
        snapshot: {
          title: '21% Red Succinic Acid Cleansing Booster Serum',
          canonical_url: 'https://medicube.us/products/red-succinic-acid-peel',
          destination_url: 'https://medicube.us/products/red-succinic-acid-peel',
          variants: [
            {
              variant_id: '40118361587760',
              title: 'SINGLE',
              option_name: 'Option',
              option_value: 'SINGLE',
              price: '20.50',
              currency: 'USD',
            },
          ],
        },
      },
    };

    const postSpy = jest.spyOn(axios, 'post').mockResolvedValueOnce({
      data: {
        products: [
          {
            title: '21% Red Succinic Acid Cleansing Booster Serum',
            url: 'https://medicube.us/products/red-succinic-acid-peel',
            image_url: 'https://cdn.shopify.com/s/files/1/0156/3905/2336/files/red-succinic.jpg?v=1',
            image_urls: ['https://cdn.shopify.com/s/files/1/0156/3905/2336/files/red-succinic.jpg?v=1'],
            description:
              '<p>Tip! Pour 700ml of lukewarm water in the sink and apply a drop.</p>',
            variants: [
              {
                id: '40118361587760',
                sku: 'PMEUS55003R00',
                url: 'https://medicube.us/products/red-succinic-acid-peel',
                option_name: 'Option',
                option_value: 'SINGLE',
                title: 'SINGLE',
                price: '20.50',
                currency: 'USD',
                stock: 'In Stock',
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
    });
    const getSpy = jest.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data:
        '<html><body><p style="color:#c8002f">An Acne Cleansing Booster Serum.<br />Net weight: 40 g | 1.41 oz.</p></body></html>',
      headers: { 'content-type': 'text/html' },
    });

    const result = await processRow(row, {
      dryRun: true,
      baseUrl: 'https://catalog.test',
      validateImageHealth: false,
      expandVariants: false,
      includeCommerceFacts: false,
      skipInsights: true,
      targetUrlOverrides: {},
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('dry_run');
    expect(result.payload.nextRow.seed_data.net_content).toBe('40 g');
    expect(result.payload.nextRow.seed_data.net_size).toBe('1.41 oz');
    expect(result.payload.nextRow.seed_data.size_detail_label).toBe('1.41 oz / 40 g');
    expect(result.payload.nextRow.seed_data.snapshot.net_content).toBe('40 g');
    expect(result.payload.nextRow.seed_data.snapshot.net_size).toBe('1.41 oz');
    expect(result.payload.nextRow.seed_data.snapshot.size_detail_label).toBe('1.41 oz / 40 g');
  });

  test('writes a cleaned derived recall document during catalog backfill', () => {
    const row = {
      id: 'eps_recall_doc_1',
      title: 'Fenty Beauty - Instant Reset Overnight Recovery Gel-Cream',
      canonical_url: 'https://fentyskin.com/products/instant-reset-overnight-recovery-gel-cream',
      destination_url: 'https://fentyskin.com/products/instant-reset-overnight-recovery-gel-cream',
      price_amount: 42,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Fenty Skin',
        description:
          'OFFICIAL: A night moisturizer for skin recovery. /// SOCIAL HIGHLIGHTS: customer service.',
        snapshot: {
          canonical_url: 'https://fentyskin.com/products/instant-reset-overnight-recovery-gel-cream',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Instant Reset Overnight Recovery Gel-Cream',
            url: 'https://fentyskin.com/products/instant-reset-overnight-recovery-gel-cream',
            description_raw:
              'A plush overnight gel-cream that helps recharge skin with hydration and barrier support.',
            details_sections: [
              { heading: 'Overview', body: 'A plush overnight gel-cream for hydrated, rested-looking skin.' },
              { heading: 'Support', body: 'Customer service, privacy policy and donation terms.' },
            ],
            variants: [
              {
                id: 'SKU-OVN-1',
                sku: 'SKU-OVN-1',
                description:
                  'A plush overnight gel-cream that helps recharge skin with hydration and barrier support.',
                price: '42.00',
                currency: 'USD',
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://fentyskin.com/products/instant-reset-overnight-recovery-gel-cream',
    );

    expect(payload.nextRow.seed_data.derived.recall).toEqual(
      expect.objectContaining({
        retrieval_title: 'Instant Reset Overnight Recovery Gel-Cream',
        retrieval_summary: expect.stringContaining('A plush overnight gel-cream'),
        brand: 'Fenty Skin',
      }),
    );
    expect(payload.nextRow.seed_data.derived.recall.retrieval_body).not.toMatch(
      /customer service|privacy policy|donation/i,
    );
  });

  test('preserves base PDP scope while retaining extractor variant deep links for expansion', () => {
    const row = {
      id: 'eps_inn_extreme',
      external_product_id: 'ext_parent_extreme',
      market: 'US',
      tool: 'creator_agents',
      title: 'Extreme Cream',
      canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
      destination_url: 'https://innbeautyproject.com/products/extreme-cream',
      image_url: 'https://cdn.example.com/full-size.jpg',
      price_amount: 44,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'INNBEAUTY Project',
        snapshot: {
          canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Extreme Cream',
            url: 'https://innbeautyproject.com/products/extreme-cream',
            image_url: 'https://cdn.example.com/full-size.jpg',
            image_urls: ['https://cdn.example.com/full-size.jpg', 'https://cdn.example.com/refill.jpg'],
            variants: [
              {
                id: '41148734668848',
                sku: '0190',
                option_name: 'Option',
                option_value: 'Full Size',
                price: '50.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://innbeautyproject.com/products/extreme-cream',
                image_url: 'https://cdn.example.com/full-size.jpg',
                image_urls: ['https://cdn.example.com/full-size.jpg'],
              },
              {
                id: '41148734701616',
                sku: '0191',
                option_name: 'Option',
                option_value: 'Refill',
                price: '44.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://innbeautyproject.com/products/extreme-cream',
                image_url: 'https://cdn.example.com/refill.jpg',
                image_urls: ['https://cdn.example.com/refill.jpg'],
              },
            ],
          },
        ],
        variants: [
          {
            id: '41148734668848',
            sku: '0190',
            deep_link: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734668848',
            product_url: 'https://innbeautyproject.com/products/extreme-cream',
          },
          {
            id: '41148734701616',
            sku: '0191',
            deep_link: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
            product_url: 'https://innbeautyproject.com/products/extreme-cream',
          },
        ],
        diagnostics: {},
      },
      'https://innbeautyproject.com/products/extreme-cream',
    );

    expect(payload.nextRow.destination_url).toBe('https://innbeautyproject.com/products/extreme-cream');
    expect(payload.nextRow.price_amount).toBe(44);
    expect(payload.nextRow.seed_data.selected_variant_id).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.variants[0]).toEqual(
      expect.objectContaining({
        variant_id: '41148734668848',
        url: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734668848',
      }),
    );
  });

  test('builds exact-item child seeds from variant deep links without mutating the base seed identity', () => {
    const row = {
      id: 'eps_inn_extreme',
      external_product_id: 'ext_parent_extreme',
      market: 'US',
      tool: 'creator_agents',
      domain: 'innbeautyproject.com',
      title: 'Extreme Cream',
      canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
      destination_url: 'https://innbeautyproject.com/products/extreme-cream',
      image_url: 'https://cdn.example.com/full-size.jpg',
      price_amount: 44,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'INNBEAUTY Project',
        snapshot: {
          canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
        },
      },
    };
    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Extreme Cream',
            url: 'https://innbeautyproject.com/products/extreme-cream',
            variants: [
              {
                id: '41148734668848',
                sku: '0190',
                option_name: 'Option',
                option_value: 'Full Size',
                price: '50.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://innbeautyproject.com/products/extreme-cream',
                deep_link: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734668848',
                image_url: 'https://cdn.example.com/full-size.jpg',
                image_urls: ['https://cdn.example.com/full-size.jpg'],
              },
              {
                id: '41148734701616',
                sku: '0191',
                option_name: 'Option',
                option_value: 'Refill',
                price: '44.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://innbeautyproject.com/products/extreme-cream',
                deep_link: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
                image_url: 'https://cdn.example.com/refill.jpg',
                image_urls: ['https://cdn.example.com/refill.jpg'],
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://innbeautyproject.com/products/extreme-cream',
    );

    const rows = buildVariantSeedRows(row, payload);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^epsv_[0-9a-f]{24}$/),
        external_product_id: expect.stringMatching(/^ext_[0-9a-f]{24}$/),
        destination_url: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734668848',
        price_amount: 50,
        image_url: 'https://cdn.example.com/full-size.jpg',
      }),
    );
    expect(rows[0].seed_data).toEqual(
      expect.objectContaining({
        source_listing_scope: 'variant',
        parent_external_product_id: 'ext_parent_extreme',
        selected_variant_id: '41148734668848',
        default_variant_id: '41148734668848',
        variant_title: 'Full Size',
      }),
    );
    expect(rows[0].seed_data.snapshot.variants).toHaveLength(1);
    expect(rows[1].seed_data.variant_title).toBe('Refill');
    expect(rows[1].price_amount).toBe(44);
  });

  test('selects exact variant fields when refreshing a variant deep-link seed', () => {
    const row = {
      id: 'epsv_inn_extreme_refill',
      external_product_id: 'ext_variant_refill',
      market: 'US',
      tool: 'creator_agents',
      title: 'Extreme Cream',
      canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
      destination_url: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
      image_url: 'https://cdn.example.com/refill.jpg',
      price_amount: 44,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'INNBEAUTY Project',
        source_listing_scope: 'variant',
        parent_external_product_id: 'ext_parent_extreme',
        selected_variant_id: '41148734701616',
        snapshot: {
          canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
          destination_url: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Extreme Cream',
            url: 'https://innbeautyproject.com/products/extreme-cream',
            image_url: 'https://cdn.example.com/full-size.jpg',
            image_urls: ['https://cdn.example.com/full-size.jpg', 'https://cdn.example.com/refill.jpg'],
            variants: [
              {
                id: '41148734668848',
                sku: '0190',
                option_name: 'Option',
                option_value: 'Full Size',
                price: '50.00',
                currency: 'USD',
                stock: 'In Stock',
                deep_link: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734668848',
                image_url: 'https://cdn.example.com/full-size.jpg',
                image_urls: ['https://cdn.example.com/full-size.jpg'],
              },
              {
                id: '41148734701616',
                sku: '0191',
                option_name: 'Option',
                option_value: 'Refill',
                price: '44.00',
                currency: 'USD',
                stock: 'In Stock',
                deep_link: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
                image_url: 'https://cdn.example.com/refill.jpg',
                image_urls: ['https://cdn.example.com/refill.jpg'],
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
    );

    expect(payload.nextRow.destination_url).toBe(
      'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
    );
    expect(payload.nextRow.price_amount).toBe(44);
    expect(payload.nextRow.image_url).toBe('https://cdn.example.com/refill.jpg');
    expect(payload.nextRow.seed_data.image_urls).toEqual(['https://cdn.example.com/refill.jpg']);
    expect(payload.nextRow.seed_data.selected_variant_id).toBe('41148734701616');
    expect(payload.nextRow.seed_data.variant_title).toBe('Refill');
    expect(buildVariantSeedRows(row, payload)).toEqual([]);
  });

  test('merges product gallery when selected variant only repeats the product thumbnail', () => {
    const row = {
      id: 'eps_boj_daily_tinted_dn350',
      external_product_id: 'ext_7b89e40cf21f7b8782783e15',
      market: 'US',
      tool: 'creator_agents',
      title: 'Daily Tinted Fluid Sunscreen DN350',
      canonical_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
      destination_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
      image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg',
      price_amount: 10,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Beauty of Joseon',
        selected_variant_id: '52402575442292',
        snapshot: {
          canonical_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
          selected_variant_id: '52402575442292',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Daily Tinted Fluid Sunscreen DN350',
            url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
            image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Daily-Tinted-Fluid-Sunscreen-DN350_Beauty-of-Joseon_59516391-51502368031092.jpg?v=1763451773',
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/241127JOSEON0307_1.webp?v=1770142124',
            ],
            variants: [
              {
                id: '52402575442292',
                sku: '01BU013',
                option_name: 'Size',
                option_value: '1.69 fl. oz. (50ml)',
                price: '10.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
                image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
                image_urls: [
                  'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
                ],
              },
              {
                id: '52402575475060',
                sku: '01BU027',
                option_name: 'Size',
                option_value: '0.23 fl. oz. (7ml)',
                price: '2.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
                image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
                image_urls: [
                  'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
                ],
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
    );

    expect(payload.nextRow.image_url).toBe(
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
    );
    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Daily-Tinted-Fluid-Sunscreen-DN350_Beauty-of-Joseon_59516391-51502368031092.jpg?v=1763451773',
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/241127JOSEON0307_1.webp?v=1770142124',
    ]);
    expect(payload.nextRow.seed_data.snapshot.image_urls).toEqual(payload.nextRow.seed_data.image_urls);
  });

  test('merges PDP content images when selected variant images are a product gallery subset', () => {
    const row = {
      id: 'eps_boj_daily_tinted_dn350',
      external_product_id: 'ext_7b89e40cf21f7b8782783e15',
      market: 'US',
      tool: 'creator_agents',
      title: 'Daily Tinted Fluid Sunscreen DN350',
      canonical_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
      destination_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
      image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg',
      price_amount: 10,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Beauty of Joseon',
        selected_variant_id: '52402575442292',
        snapshot: {
          canonical_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
          selected_variant_id: '52402575442292',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Daily Tinted Fluid Sunscreen DN350',
            url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
            image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Daily-Tinted-Fluid-Sunscreen-DN350_Beauty-of-Joseon_59516391-51502368031092.jpg?v=1763451773',
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Untitled_design_95.jpg?v=1763500000',
            ],
            variants: [
              {
                id: '52402575442292',
                sku: '01BU013',
                option_name: 'Size',
                option_value: '1.69 fl. oz. (50ml)',
                price: '10.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
                image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
                image_urls: [
                  'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
                  'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Daily-Tinted-Fluid-Sunscreen-DN350_Beauty-of-Joseon_59516391-51502368031092.jpg?v=1763451773',
                ],
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
    );

    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Daily-Tinted-Fluid-Sunscreen-DN350_Beauty-of-Joseon_59516391-51502368031092.jpg?v=1763451773',
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Untitled_design_95.jpg?v=1763500000',
    ]);
  });

  test('promotes richer selected variant galleries to top-level seed images', () => {
    const row = {
      id: 'eps_rare_mini',
      external_product_id: 'ext_b8adb51e4b986a2b0bfb69c4',
      market: 'US',
      tool: 'creator_agents',
      title: 'Find Comfort Body & Hair Fragrance Mist Mini',
      canonical_url: 'https://rarebeauty.com/products/find-comfort-body-hair-fragrance-mist-mini',
      destination_url: 'https://rarebeauty.com/products/find-comfort-body-hair-fragrance-mist-mini',
      image_url: 'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
      price_amount: 18,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Rare Beauty',
        selected_variant_id: '44731790315607',
        snapshot: {
          canonical_url: 'https://rarebeauty.com/products/find-comfort-body-hair-fragrance-mist-mini',
          selected_variant_id: '44731790315607',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Find Comfort Body & Hair Fragrance Mist Mini',
            url: 'https://rarebeauty.com/products/find-comfort-body-hair-fragrance-mist-mini',
            image_url:
              'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
              'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI.jpg?v=1740424689',
            ],
            variants: [
              {
                id: '44731790315607',
                sku: 'RB-FC-MINI',
                option_name: 'Size',
                option_value: 'Default',
                price: '18.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://rarebeauty.com/products/find-comfort-body-hair-fragrance-mist-mini',
                image_url:
                  'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
                image_urls: [
                  'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
                  'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI.jpg?v=1740424689',
                  'https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-1268x1268_%7Bwidth%7Dx.jpg?v=1740424675',
                  'https://www.rarebeauty.com/cdn/shop/files/IMPERFECT-CIRCLE-FC-BODY-HAIR-FRAGRANCE-MIST-MINI-800x864_%7Bwidth%7Dx.png?v=1740424658',
                ],
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://rarebeauty.com/products/find-comfort-body-hair-fragrance-mist-mini',
    );

    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI.jpg?v=1740424689',
    ]);
    expect(payload.nextRow.seed_data.snapshot.image_urls).toEqual(payload.nextRow.seed_data.image_urls);
    expect(payload.nextRow.seed_data.snapshot.variants[0].image_urls).toEqual(payload.nextRow.seed_data.image_urls);
    expect(payload.nextRow.seed_data.content_image_urls).toEqual([
      'https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-1268x1268_1024x.jpg?v=1740424675',
      'https://www.rarebeauty.com/cdn/shop/files/IMPERFECT-CIRCLE-FC-BODY-HAIR-FRAGRANCE-MIST-MINI-800x864_1024x.png?v=1740424658',
    ]);
  });

  test('filters sibling mini product images when promoting a single-product Rare gallery', () => {
    const row = {
      id: 'eps_rare_mini_context_filter',
      external_product_id: 'ext_b8adb51e4b986a2b0bfb69c4',
      market: 'US',
      tool: 'creator_agents',
      title: 'Find Comfort Body & Hair Fragrance Mist Mini',
      canonical_url: 'https://rarebeauty.com/products/find-comfort-body-hair-fragrance-mist-mini',
      destination_url: 'https://rarebeauty.com/products/find-comfort-body-hair-fragrance-mist-mini',
      image_url: 'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
      price_amount: 18,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Rare Beauty',
        selected_variant_id: '44731790315607',
        snapshot: {
          canonical_url: 'https://rarebeauty.com/products/find-comfort-body-hair-fragrance-mist-mini',
          selected_variant_id: '44731790315607',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Find Comfort Body & Hair Fragrance Mist Mini',
            url: 'https://rarebeauty.com/products/find-comfort-body-hair-fragrance-mist-mini',
            image_url:
              'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
              'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI.jpg?v=1740424689',
            ],
            variants: [
              {
                id: '44731790315607',
                sku: 'RB-FC-MINI',
                option_name: 'Size',
                option_value: 'Default',
                price: '18.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://rarebeauty.com/products/find-comfort-body-hair-fragrance-mist-mini',
                image_url:
                  'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
                image_urls: [
                  'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
                  'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI.jpg?v=1740424689',
                  'https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-1268x1268_%7Bwidth%7Dx.jpg?v=1740424675',
                  'https://www.rarebeauty.com/cdn/shop/files/IMPERFECT-CIRCLE-FC-BODY-HAIR-FRAGRANCE-MIST-MINI-800x864_%7Bwidth%7Dx.png?v=1740424658',
                  'https://www.rarebeauty.com/cdn/shop/files/ECOMM-FIND-COMFORT-BODY-LOTION-MINI-CLOSED_1024x.jpg?v=1762301243',
                  'https://www.rarebeauty.com/cdn/shop/files/ECOMM-FIND-COMFORT-EXFOLIATING-BODY-WASH-MINI_1024x.jpg?v=1762301245',
                ],
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://rarebeauty.com/products/find-comfort-body-hair-fragrance-mist-mini',
    );

    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-CLOSED.jpg?v=1762301243',
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/ECOMM-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI.jpg?v=1740424689',
    ]);
    expect(payload.nextRow.seed_data.snapshot.image_urls).toEqual(payload.nextRow.seed_data.image_urls);
    expect(payload.nextRow.seed_data.snapshot.variants[0].image_urls).toEqual(payload.nextRow.seed_data.image_urls);
    expect(payload.nextRow.seed_data.content_image_urls).toEqual([
      'https://www.rarebeauty.com/cdn/shop/files/PDP-USAGE-FIND-COMFORT-BODY-HAIR-FRAGRANCE-MIST-MINI-1268x1268_1024x.jpg?v=1740424675',
      'https://www.rarebeauty.com/cdn/shop/files/IMPERFECT-CIRCLE-FC-BODY-HAIR-FRAGRANCE-MIST-MINI-800x864_1024x.png?v=1740424658',
    ]);
  });

  test('filters collection and thumbnail group shots from single-product Rare body lotion galleries', () => {
    const row = {
      id: 'eps_rare_body_lotion',
      external_product_id: 'ext_8ed8e4a0ed758afbfe1a50fc',
      market: 'US',
      tool: 'creator_agents',
      title: 'Find Comfort Hydrating Body Lotion',
      canonical_url: 'https://rarebeauty.com/products/find-comfort-hydrating-body-lotion',
      destination_url: 'https://rarebeauty.com/products/find-comfort-hydrating-body-lotion',
      image_url: 'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/find-comfort-body-lotion-closed-1440x1952.jpg?v=1762289702',
      price_amount: 28,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Rare Beauty',
        snapshot: {
          canonical_url: 'https://rarebeauty.com/products/find-comfort-hydrating-body-lotion',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Find Comfort Hydrating Body Lotion',
            url: 'https://rarebeauty.com/products/find-comfort-hydrating-body-lotion',
            image_url:
              'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/find-comfort-body-lotion-closed-1440x1952.jpg?v=1762289702',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/find-comfort-body-lotion-closed-1440x1952.jpg?v=1762289702',
              'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/find-comfort-body-lotion-1440x1952.jpg?v=1701812958',
              'https://www.rarebeauty.com/cdn/shop/files/imperfect-circle-find-comfort-collection-800x864_1024x.png?v=1701811855',
              'https://www.rarebeauty.com/cdn/shop/files/pdp-bundle-thumbnail-fc-body-lotion-180x180_1024x.jpg?v=1709669070',
              'https://www.rarebeauty.com/cdn/shop/files/find-comfort-body-lotion-pump-01-1440x1952_120x120_crop_center.jpg?v=1762291295',
            ],
            variants: [
              {
                id: 'rb-body-lotion-default',
                sku: 'RB-BL-1',
                option_name: 'Title',
                option_value: 'Default Title',
                price: '28.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://rarebeauty.com/products/find-comfort-hydrating-body-lotion',
                image_url:
                  'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/find-comfort-body-lotion-closed-1440x1952.jpg?v=1762289702',
                image_urls: [
                  'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/find-comfort-body-lotion-closed-1440x1952.jpg?v=1762289702',
                  'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/find-comfort-body-lotion-1440x1952.jpg?v=1701812958',
                  'https://www.rarebeauty.com/cdn/shop/files/imperfect-circle-find-comfort-collection-800x864_1024x.png?v=1701811855',
                  'https://www.rarebeauty.com/cdn/shop/files/pdp-bundle-thumbnail-fc-body-lotion-180x180_1024x.jpg?v=1709669070',
                  'https://www.rarebeauty.com/cdn/shop/files/find-comfort-body-lotion-pump-01-1440x1952_120x120_crop_center.jpg?v=1762291295',
                ],
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://rarebeauty.com/products/find-comfort-hydrating-body-lotion',
    );

    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/find-comfort-body-lotion-closed-1440x1952.jpg?v=1762289702',
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/files/find-comfort-body-lotion-1440x1952.jpg?v=1701812958',
    ]);
    expect(payload.nextRow.seed_data.snapshot.image_urls).toEqual(payload.nextRow.seed_data.image_urls);
    expect(payload.nextRow.seed_data.snapshot.variants[0].image_urls).toEqual(payload.nextRow.seed_data.image_urls);
  });

  test('filters Rare navigation, sibling sku, and details assets from single-product primer galleries', () => {
    const row = {
      id: 'eps_rare_primer_fullsize',
      external_product_id: 'ext_rare_primer_fullsize',
      market: 'US',
      tool: 'creator_agents',
      title: 'Always an Optimist Pore Diffusing Primer',
      canonical_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer',
      destination_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer',
      image_url: 'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-SKU.jpg?v=1762270689',
      price_amount: 28,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Rare Beauty',
        snapshot: {
          canonical_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Always an Optimist Pore Diffusing Primer',
            url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer',
            image_url: 'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-SKU.jpg?v=1762270689',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-SKU.jpg?v=1762270689',
              'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-Open-SKU.jpg?v=1617149124',
              'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/diffusing-primer-swatch-1440x1952_490e7974-aa56-4c60-8643-38edfc1538a9.jpg?v=1617149024',
              'https://www.rarebeauty.com/cdn/shop/files/GNAV-SU26-SHOP-ALL.png?v=1774669137',
              'https://www.rarebeauty.com/cdn/shop/products/ILLUMINATING-PRIMER-28ML-SKU-1_6ffb264a-d678-4a6d-85a8-fa2924d6fd0f.jpg?v=1762201378',
              'https://www.rarebeauty.com/cdn/shop/products/4-IN-1-MIST-SKU-1_c9988cd0-b4d3-4fb7-b9e2-5e3a36bf5d05.jpg?v=1762200384',
              'https://www.rarebeauty.com/cdn/shop/products/Setting-Powder-Light-SKU.jpg?v=1762276083',
              'https://www.rarebeauty.com/cdn/shop/products/Powder-Brush-SKU.jpg?v=1762276046',
              'https://www.rarebeauty.com/cdn/shop/products/Eyeshadow-Primer-SKU.jpg?v=1762270691',
              'https://www.rarebeauty.com/cdn/shop/files/PDP-imperfect-circle-primers.png?v=1616543294',
              'https://www.rarebeauty.com/cdn/shop/files/PDP-details-image-1268x1268-pore-primer.jpg?v=1617041406',
            ],
            variants: [
              {
                id: 'rb-primer-default',
                sku: 'RB-PRIMER-FULL',
                option_name: 'Title',
                option_value: 'Default Title',
                price: '28.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer',
                image_url: 'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-SKU.jpg?v=1762270689',
                image_urls: [
                  'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-SKU.jpg?v=1762270689',
                  'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-Open-SKU.jpg?v=1617149124',
                  'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/diffusing-primer-swatch-1440x1952_490e7974-aa56-4c60-8643-38edfc1538a9.jpg?v=1617149024',
                  'https://www.rarebeauty.com/cdn/shop/files/GNAV-SU26-SHOP-ALL.png?v=1774669137',
                  'https://www.rarebeauty.com/cdn/shop/products/ILLUMINATING-PRIMER-28ML-SKU-1_6ffb264a-d678-4a6d-85a8-fa2924d6fd0f.jpg?v=1762201378',
                  'https://www.rarebeauty.com/cdn/shop/products/4-IN-1-MIST-SKU-1_c9988cd0-b4d3-4fb7-b9e2-5e3a36bf5d05.jpg?v=1762200384',
                  'https://www.rarebeauty.com/cdn/shop/products/Setting-Powder-Light-SKU.jpg?v=1762276083',
                  'https://www.rarebeauty.com/cdn/shop/products/Powder-Brush-SKU.jpg?v=1762276046',
                  'https://www.rarebeauty.com/cdn/shop/products/Eyeshadow-Primer-SKU.jpg?v=1762270691',
                  'https://www.rarebeauty.com/cdn/shop/files/PDP-imperfect-circle-primers.png?v=1616543294',
                  'https://www.rarebeauty.com/cdn/shop/files/PDP-details-image-1268x1268-pore-primer.jpg?v=1617041406',
                ],
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer',
    );

    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-SKU.jpg?v=1762270689',
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/Pore-Primer-Open-SKU.jpg?v=1617149124',
      'https://cdn.shopify.com/s/files/1/0314/1143/7703/products/diffusing-primer-swatch-1440x1952_490e7974-aa56-4c60-8643-38edfc1538a9.jpg?v=1617149024',
    ]);
    expect(payload.nextRow.seed_data.content_image_urls).toEqual([
      'https://www.rarebeauty.com/cdn/shop/files/PDP-imperfect-circle-primers.png?v=1616543294',
      'https://www.rarebeauty.com/cdn/shop/files/PDP-details-image-1268x1268-pore-primer.jpg?v=1617041406',
    ]);
  });

  test('keeps only real Fenty product gallery assets and strips shade-finder and award media', () => {
    const row = {
      id: 'eps_fenty_refill_clean',
      external_product_id: 'ext_fenty_refill_clean',
      market: 'US',
      tool: 'creator_agents',
      title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer Refill - EU',
      canonical_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
      destination_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
      image_url: 'https://fentybeauty.com/cdn/shop/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI.jpg?v=1762272037',
      price_amount: 44,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Fenty Beauty',
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer Refill - EU',
            url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
            image_url: 'https://fentybeauty.com/cdn/shop/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI.jpg?v=1762272037',
            image_urls: [
              'https://fentybeauty.com/cdn/shop/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI.jpg?v=1762272037',
              'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI_600x.jpg?v=1762272037',
              'https://fentybeauty.com/cdn/shop/t/12/assets/find-shade.png?v=111',
              'https://fentybeauty.com/cdn/shop/t/12/assets/try-shade.png?v=111',
              'https://fentybeauty.com/cdn/shop/t/12/assets/get-the-look.jpg?v=111',
              'https://fentybeauty.com/cdn/shop/files/FS844250_GLOBAL_HYDRA_VIZOR_INFOGRAPHICS_1200x1500_Ingredients.jpg?v=1762272037',
              'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/HYDRA-VIZOR-BADGE-AWARD.jpg?v=1762272037',
              'https://cdn.accentuate.io/8445381804077/1774977845944/allure_2025_3000x3000-(2).png?v=1774977845944&width=100',
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
    );

    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://fentybeauty.com/cdn/shop/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI.jpg?v=1762272037',
    ]);
    expect(payload.nextRow.seed_data.content_image_urls).toEqual([
      'https://fentybeauty.com/cdn/shop/files/FS844250_GLOBAL_HYDRA_VIZOR_INFOGRAPHICS_1200x1500_Ingredients.jpg?v=1762272037',
    ]);
  });

  test('re-filters preserved legacy Fenty content_image_urls before carrying them forward', () => {
    const row = {
      id: 'eps_fenty_legacy_content',
      external_product_id: 'ext_fenty_legacy_content',
      market: 'US',
      tool: 'creator_agents',
      title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer Refill - EU',
      canonical_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
      destination_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
      image_url: 'https://fentybeauty.com/cdn/shop/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI.jpg?v=1762272037',
      seed_data: {
        brand: 'Fenty Beauty',
        content_image_urls: [
          'https://fentybeauty.com/cdn/shop/files/FS844250_GLOBAL_HYDRA_VIZOR_INFOGRAPHICS_1200x1500_Ingredients.jpg?v=1762272037',
          'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/HYDRA-VIZOR-BADGE-AWARD.jpg?v=1762272037',
          'https://fentybeauty.com/cdn/shop/t/12/assets/find-shade.png?v=111',
        ],
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer Refill - EU',
            url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
            image_url: 'https://fentybeauty.com/cdn/shop/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI.jpg?v=1762272037',
            image_urls: [
              'https://fentybeauty.com/cdn/shop/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI.jpg?v=1762272037',
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer-refill-eu',
    );

    expect(payload.nextRow.seed_data.content_image_urls).toEqual([
      'https://fentybeauty.com/cdn/shop/files/FS844250_GLOBAL_HYDRA_VIZOR_INFOGRAPHICS_1200x1500_Ingredients.jpg?v=1762272037',
    ]);
  });

  test('moves Fenty texture and application assets into content_image_urls during backfill', () => {
    const row = {
      id: 'eps_fenty_hydra_mini_backfill',
      external_product_id: 'ext_fenty_hydra_mini_backfill',
      market: 'US',
      tool: 'creator_agents',
      title: 'Hydra Vizor Mini Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
      canonical_url: 'https://fentybeauty.com/products/hydra-vizor-mini-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
      destination_url: 'https://fentybeauty.com/products/hydra-vizor-mini-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
      image_url: 'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_POSTHOL2021_T2PRODUCT_ECOMM_MINI_HYDRA_VIZOR_US_1200x1500_FENTYVERSE.jpg?v=1762272039',
      price_amount: 26,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Fenty Beauty',
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/hydra-vizor-mini-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Hydra Vizor Mini Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
            url: 'https://fentybeauty.com/products/hydra-vizor-mini-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
            image_url: 'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_POSTHOL2021_T2PRODUCT_ECOMM_MINI_HYDRA_VIZOR_US_1200x1500_FENTYVERSE.jpg?v=1762272039',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_POSTHOL2021_T2PRODUCT_ECOMM_MINI_HYDRA_VIZOR_US_1200x1500_FENTYVERSE.jpg?v=1762272039',
              'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_TEXTURE_1200x1500_72DPI_0b694f77-059c-4f40-8c98-140fd70040a9.jpg?v=1760652647',
              'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_SUM25_MVP_T2BEAUTY_HYDRAVIZOR_APPLICATION_LIGHT_TAYLOR_108_1200X1500_72DPI.jpg?v=1760652808',
              'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_CONSUMER_PERCEPTION_1200x1500_72DPI_9d18259c-a31f-4ee6-80fc-c7fed71283ea.jpg?v=1760652647',
              'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_COMPARISON_1200x1500_72DPI_05e22d61-95ab-4f2d-b3a7-8df248edb9be.jpg?v=1760652647',
              'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_INGREDIENTS_1200x1500_72DPI_05c296d8-b761-4b8f-8d45-f861f5acf324.jpg?v=1760652647',
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://fentybeauty.com/products/hydra-vizor-mini-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
    );

    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_POSTHOL2021_T2PRODUCT_ECOMM_MINI_HYDRA_VIZOR_US_1200x1500_FENTYVERSE.jpg?v=1762272039',
    ]);
    expect(payload.nextRow.seed_data.content_image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_TEXTURE_1200x1500_72DPI_0b694f77-059c-4f40-8c98-140fd70040a9.jpg?v=1760652647',
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_SUM25_MVP_T2BEAUTY_HYDRAVIZOR_APPLICATION_LIGHT_TAYLOR_108_1200X1500_72DPI.jpg?v=1760652808',
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_CONSUMER_PERCEPTION_1200x1500_72DPI_9d18259c-a31f-4ee6-80fc-c7fed71283ea.jpg?v=1760652647',
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_COMPARISON_1200x1500_72DPI_05e22d61-95ab-4f2d-b3a7-8df248edb9be.jpg?v=1760652647',
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_INGREDIENTS_1200x1500_72DPI_05c296d8-b761-4b8f-8d45-f861f5acf324.jpg?v=1760652647',
    ]);
  });

  test('migrates legacy content-like Fenty gallery assets into content_image_urls when extractor returns only clean hero images', () => {
    const row = {
      id: 'eps_fenty_hydra_mini_legacy_gallery',
      external_product_id: 'ext_fenty_hydra_mini_legacy_gallery',
      market: 'US',
      tool: 'creator_agents',
      title: 'Hydra Vizor Mini Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
      canonical_url: 'https://fentybeauty.com/products/hydra-vizor-mini-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
      destination_url: 'https://fentybeauty.com/products/hydra-vizor-mini-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
      seed_data: {
        brand: 'Fenty Beauty',
        image_urls: [
          'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_POSTHOL2021_T2PRODUCT_ECOMM_MINI_HYDRA_VIZOR_US_1200x1500_FENTYVERSE.jpg?v=1762272039',
          'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_TEXTURE_1200x1500_72DPI_0b694f77-059c-4f40-8c98-140fd70040a9.jpg?v=1760652647',
          'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_SUM25_MVP_T2BEAUTY_HYDRAVIZOR_APPLICATION_LIGHT_TAYLOR_108_1200X1500_72DPI.jpg?v=1760652808',
        ],
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/hydra-vizor-mini-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Hydra Vizor Mini Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
            url: 'https://fentybeauty.com/products/hydra-vizor-mini-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
            image_url: 'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_POSTHOL2021_T2PRODUCT_ECOMM_MINI_HYDRA_VIZOR_US_1200x1500_FENTYVERSE.jpg?v=1762272039',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_POSTHOL2021_T2PRODUCT_ECOMM_MINI_HYDRA_VIZOR_US_1200x1500_FENTYVERSE.jpg?v=1762272039',
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://fentybeauty.com/products/hydra-vizor-mini-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
    );

    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_POSTHOL2021_T2PRODUCT_ECOMM_MINI_HYDRA_VIZOR_US_1200x1500_FENTYVERSE.jpg?v=1762272039',
    ]);
    expect(payload.nextRow.seed_data.content_image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS391353_Global_Hydra_Vizor_Mineral_Face_TEXTURE_1200x1500_72DPI_0b694f77-059c-4f40-8c98-140fd70040a9.jpg?v=1760652647',
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_SUM25_MVP_T2BEAUTY_HYDRAVIZOR_APPLICATION_LIGHT_TAYLOR_108_1200X1500_72DPI.jpg?v=1760652808',
    ]);
  });

  test('filters Fenty mini and refill sibling packshots out of full-size backfill gallery', () => {
    const row = {
      id: 'eps_fenty_hydra_full_backfill',
      external_product_id: 'ext_fenty_hydra_full_backfill',
      market: 'US',
      tool: 'creator_agents',
      title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
      canonical_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
      destination_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
      image_url: 'https://fentybeauty.com/cdn/shop/files/FS22_REFRESH_HYDRAVIZOR_PDP_FENTYVERSE_1200x.jpg?v=1762272034',
      price_amount: 45,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Fenty Beauty',
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
            url: 'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
            image_url: 'https://fentybeauty.com/cdn/shop/files/FS22_REFRESH_HYDRAVIZOR_PDP_FENTYVERSE_1200x.jpg?v=1762272034',
            image_urls: [
              'https://fentybeauty.com/cdn/shop/files/FS22_REFRESH_HYDRAVIZOR_PDP_FENTYVERSE_1200x.jpg?v=1762272034',
              'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS746400---HYDRA-VIZOR-FRANCHISE-UPDATE-081524_RIH_1200x1500_05.jpg?v=1767728388',
              'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_S23_T2PRODUCT_SILO_HYDRAVIZOR_REFILL_MINERAL_1200x1500_FENTYVERSEI.jpg?v=1762272036',
              'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS_POSTHOL2021_T2PRODUCT_ECOMM_MINI_HYDRA_VIZOR_US_1200x1500_FENTYVERSE.jpg?v=1762272039',
              'https://fentybeauty.com/cdn/shop/files/FS746400---HYDRA-VIZOR-FRANCHISE-UPDATE-081524_RIH_1200x1500_03_1350x1650.jpg?v=1760568262',
              'https://fentybeauty.com/cdn/shop/files/FS_SPR24_T2PRODUCT_ECOMM_HYDRAVIZOR_HUEZ_HOLDER_HOLDER_REFILL_SHADE_4_1200x1500_72_DPI_US_1350x1650.jpg?v=1762286285',
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://fentybeauty.com/products/hydra-vizor-broad-spectrum-mineral-spf-30-sunscreen-moisturizer',
    );

    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://fentybeauty.com/cdn/shop/files/FS22_REFRESH_HYDRAVIZOR_PDP_FENTYVERSE_1200x.jpg?v=1762272034',
      'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FS746400---HYDRA-VIZOR-FRANCHISE-UPDATE-081524_RIH_1200x1500_05.jpg?v=1767728388',
      'https://fentybeauty.com/cdn/shop/files/FS746400---HYDRA-VIZOR-FRANCHISE-UPDATE-081524_RIH_1200x1500_03_1350x1650.jpg?v=1760568262',
    ]);
  });

  test('preserves reviewed PDP content assets over thinner incoming extractor content', () => {
    const canonicalUrl = 'https://example.com/products/barrier-cream';
    const reviewedDescription =
      'A reviewed barrier cream with ceramides, panthenol, and ectoin that supports daily moisture recovery.';
    const reviewedSections = [
      { heading: 'Overview', body: reviewedDescription },
      { heading: 'How to Use', body: 'Apply after toner and before SPF.' },
    ];
    const reviewedQuality = {
      description_raw: {
        source_origin: 'shopify_json',
        source_quality_status: 'high',
      },
      details_sections: {
        source_origin: 'shopify_json',
        source_quality_status: 'high',
      },
    };
    const reviewedAsset = {
      contract_version: 'pivota.pdp_content_asset.v1',
      owner: 'pivota',
      fields: {
        description: {
          review_state: 'assistant_reviewed',
          overwrite_policy: 'preserve_best_available',
          source_origin: 'shopify_json',
          source_quality_status: 'high',
        },
        description_raw: {
          review_state: 'human_reviewed',
          overwrite_policy: 'preserve_best_available',
          source_origin: 'shopify_json',
          source_quality_status: 'high',
        },
        details_sections: {
          review_state: 'assistant_reviewed',
          overwrite_policy: 'preserve_best_available',
          source_origin: 'shopify_json',
          source_quality_status: 'high',
        },
      },
    };
    const row = {
      id: 'eps_asset_lock',
      external_product_id: 'ext_asset_lock',
      title: 'Barrier Cream',
      canonical_url: canonicalUrl,
      destination_url: canonicalUrl,
      price_amount: 24,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'Barrier Cream',
        description: reviewedDescription,
        pdp_description_raw: reviewedDescription,
        pdp_details_sections: reviewedSections,
        pdp_field_quality_summary: reviewedQuality,
        pdp_content_asset_v1: reviewedAsset,
        snapshot: {
          canonical_url: canonicalUrl,
          title: 'Barrier Cream',
          description: reviewedDescription,
          pdp_description_raw: reviewedDescription,
          pdp_details_sections: reviewedSections,
          pdp_field_quality_summary: reviewedQuality,
          pdp_content_asset_v1: reviewedAsset,
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        mode: 'puppeteer',
        products: [
          {
            title: 'Barrier Cream',
            url: canonicalUrl,
            description_raw: 'Barrier cream.',
            details_sections: [{ heading: 'Overview', body: 'Barrier cream.' }],
            field_quality_summary: reviewedQuality,
            variants: [
              {
                id: 'bc-default',
                sku: 'BC-DEFAULT',
                description: 'Barrier cream.',
                price: '24.00',
                currency: 'USD',
                stock: 'In Stock',
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      canonicalUrl,
    );

    expect(payload.nextRow.seed_data.description).toBe(reviewedDescription);
    expect(payload.nextRow.seed_data.pdp_description_raw).toBe(reviewedDescription);
    expect(payload.nextRow.seed_data.pdp_details_sections).toEqual([
      expect.objectContaining(reviewedSections[0]),
      expect.objectContaining(reviewedSections[1]),
    ]);
    expect(
      payload.nextRow.seed_data.snapshot_quarantine.preserved_candidates.description_raw,
    ).toEqual(
      expect.objectContaining({
        value: 'Barrier cream.',
        reason_code: 'preserve_reviewed_pivota_asset',
      }),
    );
    expect(payload.nextRow.seed_data.pdp_content_asset_v1.fields.description_raw.review_state).toBe(
      'human_reviewed',
    );
    expect(payload.nextRow.seed_data.snapshot.pdp_content_asset_v1.fields.details_sections.review_state).toBe(
      'assistant_reviewed',
    );
  });

  test('keeps reviewed details while still recovering incoming ingredients raw', () => {
    const canonicalUrl = 'https://example.com/products/oat-cream';
    const reviewedDescription = 'A reviewed moisturizer overview.';
    const reviewedSections = [
      { heading: 'Details', body: reviewedDescription },
      { heading: 'Benefits', body: 'Calms visible redness.' },
    ];
    const reviewedQuality = {
      description_raw: {
        source_origin: 'shopify_json',
        source_quality_status: 'high',
      },
      details_sections: {
        source_origin: 'shopify_json',
        source_quality_status: 'high',
      },
    };
    const reviewedAsset = {
      contract_version: 'pivota.pdp_content_asset.v1',
      owner: 'pivota',
      fields: {
        details_sections: {
          review_state: 'assistant_reviewed',
          overwrite_policy: 'preserve_best_available',
          source_origin: 'shopify_json',
          source_quality_status: 'high',
        },
      },
    };
    const row = {
      id: 'eps_reviewed_details_incoming_ingredients',
      external_product_id: 'ext_reviewed_details_incoming_ingredients',
      title: 'Oat Cream',
      canonical_url: canonicalUrl,
      destination_url: canonicalUrl,
      price_amount: 28,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'Oat Cream',
        description: reviewedDescription,
        pdp_description_raw: reviewedDescription,
        pdp_details_sections: reviewedSections,
        pdp_field_quality_summary: reviewedQuality,
        pdp_content_asset_v1: reviewedAsset,
        snapshot: {
          canonical_url: canonicalUrl,
          title: 'Oat Cream',
          description: reviewedDescription,
          pdp_description_raw: reviewedDescription,
          pdp_details_sections: reviewedSections,
          pdp_field_quality_summary: reviewedQuality,
          pdp_content_asset_v1: reviewedAsset,
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        mode: 'puppeteer',
        products: [
          {
            title: 'Oat Cream',
            url: canonicalUrl,
            description_raw: reviewedDescription,
            ingredients_raw:
              'Oat extract: Soothes irritation. Full Ingredients: Water (Aqua/Eau), Butylene Glycol, Squalane, Avena Sativa (Oat) Meal Extract. PETA-certified vegan and cruelty-free.',
            details_sections: [
              {
                heading: 'Ingredients',
                body:
                  'Oat extract: Soothes irritation and rebalances stressed skin. Trehalose: Helps bind water to skin to retain moisture. Squalane: Improves skin hydration and reduces moisture loss. Full Ingredients: Water (Aqua/Eau), Butylene Glycol, Caprylic/Capric Triglyceride, Squalane, 1,2-Hexanediol, Trehalose, Behenyl Alcohol, Ammonium Acryloyldimethyltaurate/VP Copolymer, Avena Sativa (Oat) Meal Extract. PETA-certified vegan and cruelty-free.',
                source_kind: 'accordion_ingredients',
              },
              {
                heading: 'Details',
                body: 'A thinner incoming overview that should not replace the reviewed details.',
                source_kind: 'accordion_control',
              },
            ],
            field_quality_summary: {
              ...reviewedQuality,
              ingredients_raw: {
                source_origin: 'retail_pdp',
                source_quality_status: 'medium',
                source_kinds: ['page_ingredients_section'],
                reason_codes: [],
              },
            },
            variants: [
              {
                id: 'oc-default',
                sku: 'OC-DEFAULT',
                description: reviewedDescription,
                price: '28.00',
                currency: 'USD',
                stock: 'In Stock',
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      canonicalUrl,
    );

    expect(payload.nextRow.seed_data.pdp_details_sections).toEqual([
      expect.objectContaining(reviewedSections[0]),
      expect.objectContaining(reviewedSections[1]),
    ]);
    expect(payload.nextRow.seed_data.pdp_ingredients_raw).toBe(
      'Water (Aqua/Eau), Butylene Glycol, Caprylic/Capric Triglyceride, Squalane, 1,2-Hexanediol, Trehalose, Behenyl Alcohol, Ammonium Acryloyldimethyltaurate/VP Copolymer, Avena Sativa (Oat) Meal Extract.',
    );
    expect(payload.nextRow.seed_data.snapshot.pdp_ingredients_raw).toBe(
      'Water (Aqua/Eau), Butylene Glycol, Caprylic/Capric Triglyceride, Squalane, 1,2-Hexanediol, Trehalose, Behenyl Alcohol, Ammonium Acryloyldimethyltaurate/VP Copolymer, Avena Sativa (Oat) Meal Extract.',
    );
  });

  test('persists merchant review preview content during catalog backfill refresh', () => {
    const canonicalUrl = 'https://example.com/products/rice-milk';
    const row = {
      id: 'eps_review_refresh_1',
      external_product_id: 'ext_review_refresh_1',
      title: 'Rice Milk',
      canonical_url: canonicalUrl,
      destination_url: canonicalUrl,
      price_amount: 24,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'Rice Milk',
        snapshot: {
          canonical_url: canonicalUrl,
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        mode: 'puppeteer',
        products: [
          {
            title: 'Rice Milk',
            url: canonicalUrl,
            review_summary: {
              rating: 4.8,
              review_count: 182,
              preview_items: [
                {
                  review_id: 'merchant_review_1',
                  rating: 5,
                  title: 'Hydrating layer',
                  text_snippet: 'Leaves skin calm and comfortable.',
                },
              ],
              questions: [
                {
                  question: 'Does it layer under sunscreen?',
                  answer: 'Yes.',
                  source: 'merchant_q_and_a',
                },
              ],
            },
            variants: [
              {
                id: 'rm-default',
                sku: 'RM-DEFAULT',
                price: '24.00',
                currency: 'USD',
                stock: 'In Stock',
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      canonicalUrl,
    );

    expect(payload.nextRow.seed_data.review_summary).toEqual(
      expect.objectContaining({
        rating: 4.8,
        review_count: 182,
        preview_items: [
          expect.objectContaining({
            review_id: 'merchant_review_1',
            title: 'Hydrating layer',
          }),
        ],
        questions: [
          expect.objectContaining({
            question: 'Does it layer under sunscreen?',
            answer: 'Yes.',
          }),
        ],
      }),
    );
    expect(payload.nextRow.seed_data.snapshot.review_summary).toEqual(
      expect.objectContaining({
        rating: 4.8,
        review_count: 182,
      }),
    );
  });
});
