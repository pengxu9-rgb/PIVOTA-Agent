const {
  buildManifestFromExtract,
  buildManifestFromSourceAttempts,
  productHasExplicitBrandSignal,
  computeExtractLimit,
  hasTransactionReadySeedSignals,
  looksLikeBundleLikeProduct,
  looksLikeNonProductCatalogPage,
  looksLikeSyntheticFallbackProduct,
  scorePreferredTitleMatch,
  sourceLooksBrandScoped,
  sourceHostLooksBrandOwned,
} = require('../../scripts/build_beauty_brand_external_seed_manifest.cjs');

describe('build_beauty_brand_external_seed_manifest', () => {
  test('maps catalog-intelligence brand extract products into seed creation manifest items', () => {
    const manifest = buildManifestFromExtract({
      brand: 'La Roche-Posay',
      domain: 'https://www.laroche-posay.us',
      market: 'US',
      limit: 10,
      extractDoc: {
        diagnostics: { source: 'catalog_extract' },
        products: [
          {
            title: 'Anthelios Ultra-Light Invisible Fluid SPF 50+',
            url: 'https://www.laroche-posay.us/anthelios-ultra-light-invisible-fluid-spf-50',
            image_url: 'https://cdn.example.com/anthelios.jpg',
            price: '$39.99',
            currency: 'USD',
            availability: 'in stock',
            variants: [
              {
                id: 'v1',
                sku: 'LRP-ANTHELIOS',
                url: 'https://www.laroche-posay.us/anthelios-ultra-light-invisible-fluid-spf-50',
                price: '$39.99',
                currency: 'USD',
                stock: 'In Stock',
                image_url: 'https://cdn.example.com/anthelios.jpg',
              },
            ],
          },
        ],
      },
    });

    expect(manifest.item_count).toBe(1);
    expect(manifest.items[0]).toEqual(
      expect.objectContaining({
        target_brand: 'La Roche-Posay',
        target_url: 'https://www.laroche-posay.us/anthelios-ultra-light-invisible-fluid-spf-50',
        market: 'US',
        seed_row: expect.objectContaining({
          market: 'US',
          title: 'Anthelios Ultra-Light Invisible Fluid SPF 50+',
          domain: 'laroche-posay.us',
          availability: 'in_stock',
          price_amount: 39.99,
        }),
      }),
    );
  });

  test('filters obvious bundle-like products and keeps the requested limit for single products', () => {
    const manifest = buildManifestFromExtract({
      brand: 'The Inkey List',
      domain: 'https://www.theinkeylist.com',
      market: 'US',
      limit: 1,
      extractDoc: {
        diagnostics: { source: 'catalog_extract' },
        products: [
          {
            title: 'Travel Essentials Routine',
            url: 'https://www.theinkeylist.com/products/travel-essentials-routine',
          },
          {
            title: 'Niacinamide Serum',
            url: 'https://www.theinkeylist.com/products/niacinamide-serum',
            image_url: 'https://cdn.example.com/niacinamide.jpg',
            price: '$12.00',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });

    expect(looksLikeBundleLikeProduct({ title: 'Travel Essentials Routine' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'FREE Hyaluronic Acid Serum 30ml' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: '[FreeGift] DIVE IN Multi Pad 2 sheets' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: '[Amazon] SOLID IN Lip Essence' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: "Glowin' Softly Hydration Heros" })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'SOLID IN Lip Essence', url: 'https://torriden.us/products/solid-in-lip-essence-set' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: '🎁 Glow Deep Serum : Rice + Alpha-Arbutin (100% off)' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Icon Gift Laneige Throw Blanket' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Laneige Magnetic Phone Grip Lipbalm Holder' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'SKIN1004 Signature Pouch' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Hyalu-Cica Water-Fit Sun Serum Value Pack' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Laneige Blue Crossbody Bag' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Laneige Hydration Hug Tumbler' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'LANEIGE x Baskin-Robbins™ Tie-Dye Crewneck' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Glaze Craze Tinted Lip Serum Blister' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Water Sleeping Mask (2mL)' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: '(Short-dated) Advanced Snail 96 Mucin Power Essence' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Round Lab Sheet Mask Sampler - 9pc' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'SPF! Canvas Tote Bag ($15 value)' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'BOGO PDRN Hyaluronic Acid Capsule 100 Serum Mask 10+10' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Daily Tinted Fluid Sunscreen Sachetbook (1g x 12 color) (100% off)', url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-sachetbook-sca_clone_freegift' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Dynasty Cream 10ml', url: 'https://beautyofjoseon.com/products/dynasty-cream-10ml', description: '*Gift with purchase only* Our best-selling creamy moisturizer.' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Relief Sun Aqua-Fresh 10ml', url: 'https://nl.beautyofjoseon.com/products/relief-sun-aqua-fresh-10ml-trial-kit' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Hanbok Scrunchie', url: 'https://beautyofjoseon.com/products/hanbok-scrunchie' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Icons to Go' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Cream Skin Mist Pump' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'LANEIGE Blue Ice Roller' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Laneige x Lights Lacquer Dream Nail Polish' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Laneige x Lights Lacquer Calling All Angels Nail Art' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Silky Pillowcase' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'LANEIGE Scrunchie' })).toBe(true);
    expect(looksLikeBundleLikeProduct({ title: 'Lip Sleeping Mask Topper' })).toBe(false);
    expect(looksLikeBundleLikeProduct({ title: 'JuicePop Box Lip Tint' })).toBe(false);
    expect(looksLikeBundleLikeProduct({ title: 'Matrixyl 10 Boosting Shot Ampoule', url: 'https://skin1004.com/products/matrixyl-10-boosting-shot-ampoule', description: 'With the power of Matrixyl and hyaluronic acid, the Boosting Shot helps provide intensive hydration.' })).toBe(false);
    expect(looksLikeBundleLikeProduct({ title: 'Niacinamide Serum' })).toBe(false);
    expect(manifest.extracted_product_count).toBe(2);
    expect(manifest.excluded_bundle_like_count).toBe(1);
    expect(manifest.item_count).toBe(1);
    expect(manifest.items[0].target_url).toBe('https://www.theinkeylist.com/products/niacinamide-serum');
  });

  test('filters simulation and synthetic fallback product rows before seed creation', () => {
    const manifest = buildManifestFromExtract({
      brand: 'LANEIGE US',
      domain: 'https://us.laneige.com',
      market: 'US',
      limit: 3,
      extractDoc: {
        mode: 'simulation',
        products: [
          {
            title: 'LANEIGE US Product 001',
            url: 'https://us.laneige.com/products/laneige-us-product-001',
            image_url: 'https://via.placeholder.com/1000x1000/e5e7eb/9ca3af?text=SIM-001',
            price: '$20.00',
            currency: 'USD',
            availability: 'in stock',
          },
          {
            title: 'Water Bank Aqua Facial',
            url: 'https://us.laneige.com/products/water-bank-aqua-facial',
            image_url: 'https://cdn.example.com/water-bank.jpg',
            price: '$36.00',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });

    expect(looksLikeSyntheticFallbackProduct(
      {
        title: 'LANEIGE US Product 001',
        image_url: 'https://via.placeholder.com/1000x1000/e5e7eb/9ca3af?text=SIM-001',
      },
      'LANEIGE US',
      {},
    )).toBe(true);
    expect(looksLikeSyntheticFallbackProduct({ title: 'Water Bank Aqua Facial' }, 'LANEIGE US', {})).toBe(false);
    expect(manifest.extracted_product_count).toBe(2);
    expect(manifest.excluded_low_quality_fallback_count).toBe(2);
    expect(manifest.item_count).toBe(0);
  });

  test('filters rows missing transaction-ready price, availability, or image signals', () => {
    const manifest = buildManifestFromExtract({
      brand: 'LANEIGE US',
      domain: 'https://us.laneige.com',
      market: 'US',
      limit: 3,
      extractDoc: {
        diagnostics: { source: 'catalog_extract' },
        products: [
          {
            title: 'Bouncy Eye Mask',
            url: 'https://us.laneige.com/products/bouncy-eye-mask',
            image_url: 'https://cdn.example.com/bouncy-eye-mask.jpg',
            price: '$0.00',
            currency: 'USD',
            availability: 'in stock',
          },
          {
            title: 'Lip Sleeping Mask Topper',
            url: 'https://us.laneige.com/products/lip-sleeping-mask-topper',
            image_url: 'https://cdn.example.com/topper.jpg',
            price: '$15.00',
            currency: 'USD',
            availability: 'in stock',
          },
          {
            title: 'JuicePop Box Lip Tint',
            url: 'https://us.laneige.com/products/juicepop-box-lip-tint',
            image_url: 'https://cdn.example.com/juicepop.jpg',
            price: '$23.00',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });

    expect(hasTransactionReadySeedSignals({ price_amount: 0, price_currency: 'USD', availability: 'in_stock', image_url: 'x' })).toBe(false);
    expect(hasTransactionReadySeedSignals({ price_amount: 15, price_currency: 'USD', availability: 'in_stock', image_url: 'x' })).toBe(true);
    expect(manifest.excluded_incomplete_transaction_count).toBe(1);
    expect(manifest.item_count).toBe(2);
    expect(manifest.items.map((item) => item.seed_row.title)).toEqual([
      'Lip Sleeping Mask Topper',
      'JuicePop Box Lip Tint',
    ]);
  });

  test('filters unscoped retailer rows that do not carry an explicit target brand signal', () => {
    const manifest = buildManifestFromExtract({
      brand: 'COSRX',
      domain: 'https://sokoglam.com',
      market: 'US',
      limit: 3,
      extractDoc: {
        diagnostics: { source: 'catalog_extract' },
        products: [
          {
            title: 'Heartleaf 77 Clearpad (70 ea)',
            url: 'https://sokoglam.com/products/anua-heartleaf-77-clearpad-70ea',
            image_url: 'https://cdn.example.com/anua.jpg',
            price: '$25.00',
            currency: 'USD',
            availability: 'in stock',
          },
          {
            title: 'Advanced Snail 96 Mucin Power Essence',
            url: 'https://sokoglam.com/products/cosrx-advanced-snail-96-mucin-power-essence',
            image_url: 'https://cdn.example.com/cosrx.jpg',
            price: '$25.00',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });

    expect(sourceLooksBrandScoped({ brand: 'COSRX', sourceUrl: 'https://sokoglam.com' })).toBe(false);
    expect(sourceHostLooksBrandOwned({ brand: 'COSRX', sourceUrl: 'https://sokoglam.com/collections/cosrx' })).toBe(false);
    expect(productHasExplicitBrandSignal(
      { title: 'Advanced Snail 96 Mucin Power Essence', url: 'https://sokoglam.com/products/cosrx-advanced-snail-96-mucin-power-essence' },
      'COSRX',
    )).toBe(true);
    expect(manifest.excluded_brand_scope_mismatch_count).toBe(1);
    expect(manifest.item_count).toBe(1);
    expect(manifest.items[0].seed_row.title).toBe('Advanced Snail 96 Mucin Power Essence');
  });

  test('keeps retailer collection rows when the source URL itself is brand scoped', () => {
    const manifest = buildManifestFromExtract({
      brand: 'Klairs',
      domain: 'https://wishtrend.com/collections/dear-klairs',
      market: 'US',
      limit: 2,
      extractDoc: {
        diagnostics: { source: 'catalog_extract' },
        products: [
          {
            title: 'Supple Preparation Unscented Toner',
            url: 'https://wishtrend.com/products/supple-preparation-unscented-toner',
            image_url: 'https://cdn.example.com/klairs-toner.jpg',
            price: '$22.00',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });

    expect(sourceLooksBrandScoped({ brand: 'Klairs', sourceUrl: 'https://wishtrend.com/collections/dear-klairs' })).toBe(true);
    expect(productHasExplicitBrandSignal(
      { title: 'Supple Preparation Unscented Toner', url: 'https://wishtrend.com/products/supple-preparation-unscented-toner' },
      'Klairs',
    )).toBe(false);
    expect(manifest.excluded_brand_scope_mismatch_count).toBe(0);
    expect(manifest.item_count).toBe(1);
    expect(manifest.items[0].seed_row.title).toBe('Supple Preparation Unscented Toner');
    expect(manifest.items[0].seed_row.seed_data.source_validation).toEqual(
      expect.objectContaining({
        source_type: 'channel_or_retailer',
        requires_multi_offer_merge_validation: true,
      }),
    );
    expect(manifest.items[0].seed_row.seed_data.commerce_facts_gate.problems).toContain(
      'missing_multi_offer_merge_candidate',
    );
  });

  test('attaches CommerceFactsV1 from extract-v2 matches and holds currency mismatches', () => {
    const manifest = buildManifestFromExtract({
      brand: 'Beauty of Joseon',
      domain: 'https://beautyofjoseon.com',
      market: 'US',
      limit: 1,
      extractDoc: {
        products: [
          {
            title: 'Calming Serum',
            url: 'https://beautyofjoseon.com/products/calming-serum',
            image_url: 'https://cdn.example.com/calming.jpg',
            price: '17.00',
            currency: 'EUR',
            availability: 'in stock',
          },
        ],
      },
      extractV2Doc: {
        offers_v2: [
          {
            url_canonical: 'https://beautyofjoseon.com/products/calming-serum',
            product_title: 'Calming Serum',
            commerce_facts_v1: {
              contract_version: 'commerce_facts.v1',
              market_id: 'US',
              country: 'US',
              currency_target: 'USD',
              source_authority: 'catalog_extract_v2',
              captured_at: '2026-04-29T00:00:00.000Z',
              evidence_url: 'https://beautyofjoseon.com/products/calming-serum',
              sellable_region: {
                status: 'unknown',
                countries: [],
                confidence: 'low',
                reason_codes: ['shipping_destination_not_verified'],
              },
              regional_price: {
                amount: 17,
                currency: 'EUR',
                observed_currency: 'EUR',
                price_type: 'list',
                confidence: 'medium',
                market_switch_status: 'mismatch',
              },
              availability: { status: 'in_stock', confidence: 'medium' },
              shipping: { status: 'unknown', confidence: 'unknown' },
              promotions: [],
              returns: { status: 'unknown', confidence: 'unknown' },
            },
          },
        ],
      },
    });

    expect(manifest.items[0].seed_row.seed_data.commerce_facts_v1.regional_price.currency).toBe('EUR');
    expect(manifest.items[0].seed_row.seed_data.commerce_facts_gate).toEqual(
      expect.objectContaining({
        status: 'hold',
        expected_currency: 'USD',
        observed_currency: 'EUR',
      }),
    );
  });

  test('filters category/list pages from catalog extractor output', () => {
    const manifest = buildManifestFromExtract({
      brand: 'Round Lab',
      domain: 'https://roundlab.co.kr',
      market: 'KR',
      limit: 2,
      extractDoc: {
        diagnostics: { source: 'catalog_extract' },
        products: [
          {
            title: 'ALL - 소나무 진정 시카',
            url: 'https://roundlab.co.kr/category/%EC%86%8C%EB%82%98%EB%AC%B4-%EC%A7%84%EC%A0%95-%EC%8B%9C%EC%B9%B4/119/',
          },
          {
            title: 'Birch Juice Moisturizing Sunscreen SPF50+',
            url: 'https://roundlab.co.kr/product/birch-juice-moisturizing-sunscreen/1234/',
            image_url: 'https://cdn.example.com/birch.jpg',
            price: '25,000원',
            currency: 'KRW',
            availability: 'in stock',
          },
        ],
      },
    });

    expect(looksLikeNonProductCatalogPage({ title: 'ALL - 포 맨', url: 'https://roundlab.co.kr/category/foo/108/' })).toBe(true);
    expect(looksLikeNonProductCatalogPage({ title: 'Consumer Health Data Privacy Statement', url: 'https://www.drjart.com/consumer-health-data-privacy-statement' })).toBe(true);
    expect(looksLikeNonProductCatalogPage({ title: 'Color Correctors & Tinted Moisturizers', url: 'https://www.drjart.com/bb-cream-color-correcting' })).toBe(true);
    expect(looksLikeNonProductCatalogPage({ title: 'Korean Cosmetics Online Shop & Wholesale, K-Beauty No.1, K-Style', url: 'http://www.stylekorean.com/shop/stylekorean_notice.html' })).toBe(true);
    expect(looksLikeNonProductCatalogPage({ title: 'Birch Juice Sunscreen', url: 'https://roundlab.co.kr/product/birch-juice-sunscreen/1234/' })).toBe(false);
    expect(manifest.excluded_non_product_page_count).toBe(1);
    expect(manifest.item_count).toBe(1);
    expect(manifest.items[0].seed_row.market).toBe('KR');
  });

  test('prioritizes preferred titles within the brand extract', () => {
    const manifest = buildManifestFromExtract({
      brand: 'The Inkey List',
      domain: 'https://www.theinkeylist.com',
      market: 'US',
      limit: 2,
      preferredTitles: ['10% Niacinamide Serum'],
      extractDoc: {
        diagnostics: { source: 'catalog_extract' },
        products: [
          {
            title: 'Bio-Active Neck Lift Stick',
            url: 'https://www.theinkeylist.com/products/bio-active-neck-lift-stick',
            image_url: 'https://cdn.example.com/neck.jpg',
            price: '$22.00',
            currency: 'USD',
            availability: 'in stock',
          },
          {
            title: '10% Niacinamide Serum',
            url: 'https://www.theinkeylist.com/products/niacinamide-serum',
            image_url: 'https://cdn.example.com/niacinamide.jpg',
            price: '$12.00',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });

    expect(scorePreferredTitleMatch({ title: '10% Niacinamide Serum' }, ['10% Niacinamide Serum'])).toBeGreaterThan(0);
    expect(manifest.matched_preferred_title_count).toBe(1);
    expect(manifest.items[0].seed_row.title).toBe('10% Niacinamide Serum');
  });

  test('keeps high-similarity preferred titles as recall aliases even below strong-match threshold', () => {
    const manifest = buildManifestFromExtract({
      brand: 'Round Lab',
      domain: 'https://roundlab.com',
      market: 'US',
      limit: 1,
      preferredTitles: ['Birch Juice Moisturizing Sunscreen SPF50+ PA++++'],
      extractDoc: {
        diagnostics: { source: 'catalog_extract' },
        products: [
          {
            title: 'Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++',
            url: 'https://roundlab.com/products/birch-moisturizing-mild-up-sunscreen-spf-50-pa',
            image_url: 'https://cdn.example.com/roundlab.jpg',
            price: '$28.00',
            currency: 'USD',
            availability: 'out of stock',
          },
        ],
      },
    });

    expect(scorePreferredTitleMatch(
      { title: 'Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++' },
      ['Birch Juice Moisturizing Sunscreen SPF50+ PA++++'],
    )).toBe(60);
    expect(manifest.matched_preferred_title_count).toBe(0);
    expect(manifest.items[0].alias_preferred_titles).toEqual([
      'Birch Juice Moisturizing Sunscreen SPF50+ PA++++',
    ]);
    expect(manifest.items[0].seed_row.seed_data.search_aliases).toContain(
      'Birch Juice Moisturizing Sunscreen SPF50+ PA++++',
    );
  });

  test('expands extract window when preferred titles are provided', () => {
    expect(computeExtractLimit(12, [])).toBe(60);
    expect(computeExtractLimit(12, ['10% Niacinamide Serum'])).toBe(250);
  });

  test('uses a secondary source only when the primary source cannot satisfy the preferred target', () => {
    const primaryManifest = buildManifestFromExtract({
      brand: 'La Roche-Posay',
      domain: 'https://www.laroche-posay.us/our-products/sun/face-sunscreen/anthelios-aox-antioxidant-serum-with-spf-50-sunscreen-3606000403703.html',
      market: 'US',
      limit: 1,
      preferredTitles: ['Anthelios AOX Antioxidant Serum with SPF 50 Sunscreen'],
      sourceRole: 'primary',
      extractDoc: {
        diagnostics: {
          discovery_strategy: 'seed_page',
          failure_category: 'bot_challenge',
          block_provider: 'cloudflare',
        },
        products: [],
      },
    });
    const secondaryManifest = buildManifestFromExtract({
      brand: 'La Roche-Posay',
      domain: 'https://www.ulta.com/p/anthelios-aox-daily-antioxidant-face-serum-spf-50-xlsImpprod12101063?sku=2285142',
      market: 'US',
      limit: 1,
      preferredTitles: ['Anthelios AOX Antioxidant Serum with SPF 50 Sunscreen'],
      sourceRole: 'secondary_fallback',
      extractDoc: {
        diagnostics: {
          discovery_strategy: 'seed_page',
          failure_category: null,
          block_provider: null,
        },
        products: [
          {
            title: 'Anthelios AOX Daily Antioxidant Face Serum SPF 50',
            url: 'https://www.ulta.com/p/anthelios-aox-daily-antioxidant-face-serum-spf-50-xlsImpprod12101063?sku=2285142',
            image_url: 'https://cdn.example.com/lrp-aox.jpg',
            price: '$44.99',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });

    const manifest = buildManifestFromSourceAttempts({
      brand: 'La Roche-Posay',
      domain: primaryManifest.domain,
      fallbackDomains: [secondaryManifest.domain],
      market: 'US',
      limit: 1,
      preferredTitles: ['Anthelios AOX Antioxidant Serum with SPF 50 Sunscreen'],
      sourceManifests: [primaryManifest, secondaryManifest],
    });

    expect(manifest.item_count).toBe(1);
    expect(manifest.fallback_used).toBe(true);
    expect(manifest.source_attempts[0]).toMatchObject({
      source_role: 'primary',
      used_in_manifest: false,
      diagnostics_summary: expect.objectContaining({
        failure_category: 'bot_challenge',
        block_provider: 'cloudflare',
      }),
    });
    expect(manifest.source_attempts[1]).toMatchObject({
      source_role: 'secondary_fallback',
      used_in_manifest: true,
      added_item_count: 1,
    });
    expect(manifest.items[0]).toMatchObject({
      source_role: 'secondary_fallback',
      target_url: 'https://www.ulta.com/p/anthelios-aox-daily-antioxidant-face-serum-spf-50-xlsImpprod12101063?sku=2285142',
      matched_preferred_titles: ['Anthelios AOX Antioxidant Serum with SPF 50 Sunscreen'],
    });
    expect(manifest.items[0].seed_row.seed_data.search_aliases).toContain(
      'Anthelios AOX Antioxidant Serum with SPF 50 Sunscreen',
    );
    expect(manifest.items[0].seed_row.seed_data.snapshot.authority_source).toMatchObject({
      source_role: 'secondary_fallback',
      source_url: 'https://www.ulta.com/p/anthelios-aox-daily-antioxidant-face-serum-spf-50-xlsImpprod12101063?sku=2285142',
    });
  });

  test('does not consume secondary source rows once the primary source already satisfies preferred titles', () => {
    const primaryManifest = buildManifestFromExtract({
      brand: 'Neutrogena',
      domain: 'https://www.neutrogena.com/products/sun/invisible-daily-defense-face-serum-spf-60/6811153',
      market: 'US',
      limit: 1,
      preferredTitles: ['Invisible Daily Defense Face Serum SPF 60+'],
      sourceRole: 'primary',
      extractDoc: {
        diagnostics: {
          discovery_strategy: 'seed_page',
          failure_category: null,
          block_provider: null,
        },
        products: [
          {
            title: 'Invisible Daily Defense Face Serum SPF 60+',
            url: 'https://www.neutrogena.com/products/sun/invisible-daily-defense-face-serum-spf-60/6811153',
            image_url: 'https://cdn.example.com/neutrogena-serum.jpg',
            price: '$19.99',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });
    const secondaryManifest = buildManifestFromExtract({
      brand: 'Neutrogena',
      domain: 'https://www.target.com/p/neutrogena-invisible-daily-defense-face-serum-spf-60',
      market: 'US',
      limit: 1,
      preferredTitles: ['Invisible Daily Defense Face Serum SPF 60+'],
      sourceRole: 'secondary_fallback',
      extractDoc: {
        diagnostics: {
          discovery_strategy: 'seed_page',
          failure_category: null,
          block_provider: null,
        },
        products: [
          {
            title: 'Neutrogena Invisible Daily Defense Sunscreen Serum SPF 60',
            url: 'https://www.target.com/p/neutrogena-invisible-daily-defense-face-serum-spf-60',
            image_url: 'https://cdn.example.com/neutrogena-target.jpg',
            price: '$18.99',
            currency: 'USD',
            availability: 'in stock',
          },
        ],
      },
    });

    const manifest = buildManifestFromSourceAttempts({
      brand: 'Neutrogena',
      domain: primaryManifest.domain,
      fallbackDomains: [secondaryManifest.domain],
      market: 'US',
      limit: 1,
      preferredTitles: ['Invisible Daily Defense Face Serum SPF 60+'],
      sourceManifests: [primaryManifest, secondaryManifest],
    });

    expect(manifest.item_count).toBe(1);
    expect(manifest.fallback_used).toBe(false);
    expect(manifest.items[0].target_url).toBe(
      'https://www.neutrogena.com/products/sun/invisible-daily-defense-face-serum-spf-60/6811153',
    );
    expect(manifest.source_attempts[1]).toMatchObject({
      source_role: 'secondary_fallback',
      used_in_manifest: false,
      skip_reason: 'primary_sufficient',
    });
  });
});
