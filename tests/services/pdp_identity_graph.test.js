describe('pdpIdentityGraph', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('buildIdentityListingFromProduct groups exact items by strong evidence and separates sibling sizes into product lines', () => {
    const { buildIdentityListingFromProduct } = require('../../src/services/pdpIdentityGraph');

    const baseProduct = {
      title: 'KraveBeauty Great Barrier Relief 45 mL',
      brand: 'KraveBeauty',
      source_url: 'https://kravebeauty.com/products/great-barrier-relief',
      gtin: '850000111222',
      price: { amount: 28, currency: 'EUR' },
      variants: [
        {
          variant_id: 'v_45',
          title: 'Standard - 45 mL',
          option1: '45 mL',
          price: { amount: 28, currency: 'EUR' },
        },
      ],
    };

    const externalListing = buildIdentityListingFromProduct({
      merchantId: 'external_seed',
      productId: 'ext_krave_gbr_45',
      product: baseProduct,
      sourceKind: 'external_seed',
    });
    const internalListing = buildIdentityListingFromProduct({
      merchantId: 'merch_krave',
      productId: '10008793153864',
      product: {
        ...baseProduct,
        vendor: 'KraveBeauty',
      },
      sourceKind: 'internal',
    });
    const jumboListing = buildIdentityListingFromProduct({
      merchantId: 'external_seed',
      productId: 'ext_krave_gbr_100',
      product: {
        ...baseProduct,
        title: 'KraveBeauty Great Barrier Relief 100 mL',
        gtin: '850000111333',
        variants: [
          {
            variant_id: 'v_100',
            title: 'Jumbo - 100 mL',
            option1: '100 mL',
            price: { amount: 50, currency: 'EUR' },
          },
        ],
      },
      sourceKind: 'external_seed',
    });

    expect(externalListing.identity_status).toBe('approved');
    expect(externalListing.matched_by_rule).toBe('strong_gtin');
    expect(externalListing.sellable_item_group_id).toBe(internalListing.sellable_item_group_id);
    expect(externalListing.product_line_id).toBe(internalListing.product_line_id);
    expect(jumboListing.sellable_item_group_id).not.toBe(externalListing.sellable_item_group_id);
    expect(jumboListing.product_line_id).toBe(externalListing.product_line_id);
  });

  test('clusterIdentityListings bridges official seed and Shopify product variant axes without mixing sibling variants', () => {
    const { buildIdentityListingFromProduct, _internals } = require('../../src/services/pdpIdentityGraph');

    const externalStandard = buildIdentityListingFromProduct({
      merchantId: 'external_seed',
      productId: 'ext_krave_gbr_45',
      sourceKind: 'external_seed',
      product: {
        title: 'Great Barrier Relief',
        brand: 'KraveBeauty',
        source_url: 'https://kravebeauty.com/products/great-barrier-relief',
        variants: [
          {
            variant_id: 'seed-standard',
            title: 'Standard 45 mL',
            options: [{ name: 'Size', value: 'Standard 45 mL' }],
          },
        ],
      },
    });
    const internalShopifyProduct = buildIdentityListingFromProduct({
      merchantId: 'merch_krave',
      productId: '10008793153864',
      sourceKind: 'internal',
      product: {
        title: 'KraveBeauty Great Barrier Relief',
        vendor: 'KraveBeauty',
        variants: [
          {
            id: '52876964495688',
            variant_id: '52876964495688',
            title: 'Standard - 45 mL',
            price: 28,
            options: { size: 'Standard - 45 mL' },
          },
          {
            id: '52876964528456',
            variant_id: '52876964528456',
            title: 'Jumbo - 100 mL',
            price: 50,
            options: { size: 'Jumbo - 100 mL' },
          },
        ],
      },
    });

    expect(internalShopifyProduct.variant_axes).toEqual({
      size: 'standard 45 ml',
      volume: '45ml',
      multi_variant: true,
    });

    const [clusteredExternal, clusteredInternal] = _internals.clusterIdentityListings([
      externalStandard,
      internalShopifyProduct,
    ]);

    expect(clusteredExternal.sellable_item_group_id).toBe(clusteredInternal.sellable_item_group_id);
    expect(clusteredExternal.product_line_id).toBe(clusteredInternal.product_line_id);
    expect(clusteredExternal.review_family_id).toBe(clusteredInternal.review_family_id);
    expect(clusteredExternal.matched_by_rule).toBe('official_url_soft_exact_cluster');
    expect(clusteredInternal.matched_by_rule).toBe('soft_exact_cluster');
    expect(clusteredExternal.match_basis).toContain(
      'soft_exact_cluster:kravebeauty|great barrier relief|size:standard 45 ml|volume:45ml',
    );
  });

  test('buildIdentityListingFromProduct groups multi-page shade siblings into one product line', () => {
    const {
      buildIdentityListingFromProduct,
      composeSyntheticCanonicalProduct,
    } = require('../../src/services/pdpIdentityGraph');

    const buildTintedSunscreen = (shadeCode, variantId) =>
      buildIdentityListingFromProduct({
        merchantId: 'external_seed',
        productId: `ext_boj_${shadeCode.toLowerCase()}`,
        sourceKind: 'external_seed',
        product: {
          title: `Daily Tinted Fluid Sunscreen ${shadeCode}`,
          brand: 'Beauty of Joseon',
          source_url: `https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-${shadeCode.toLowerCase()}`,
          variants: [
            {
              variant_id: variantId,
              title: '1.69 fl. oz. (50ml)',
              option_name: 'Size',
              option_value: '1.69 fl. oz. (50ml)',
            },
            {
              variant_id: `${variantId}-mini`,
              title: '0.23 fl. oz. (7ml)',
              option_name: 'Size',
              option_value: '0.23 fl. oz. (7ml)',
            },
          ],
        },
      });

    const dn350 = buildTintedSunscreen('DN350', '52402575442292');
    const dn310 = buildTintedSunscreen('DN310', '52402483560820');

    expect(dn350.identity_status).toBe('approved');
    expect(dn350.variant_axes).toEqual({
      size: '1 69 fl oz 50ml',
      volume: '69floz',
      shade: 'dn350',
      multi_variant: true,
    });
    expect(dn310.variant_axes.shade).toBe('dn310');
    expect(dn350.title_core_norm).toBe('daily tinted fluid sunscreen');
    expect(dn310.title_core_norm).toBe('daily tinted fluid sunscreen');
    expect(dn350.sellable_item_group_id).not.toBe(dn310.sellable_item_group_id);
    expect(dn350.product_line_id).toBe(dn310.product_line_id);
    expect(dn350.review_family_id).toBe(dn310.review_family_id);
    expect(dn350.source_meta.variant_family).toEqual({
      axis: 'shade',
      value: 'dn350',
      title_core_norm: 'daily tinted fluid sunscreen',
    });

    const composed = composeSyntheticCanonicalProduct({
      requestedListing: dn350,
      exactListings: [dn350],
      lineListings: [dn350, dn310],
    });
    expect(composed.product.product_line_option_name).toBe('Shade');
    expect(composed.product.product_line_options).toEqual([
      expect.objectContaining({
        axis: 'shade',
        label: 'DN310',
        product_id: 'ext_boj_dn310',
        swatch_color: expect.stringMatching(/^#[0-9a-f]{6}$/),
        selected: false,
      }),
      expect.objectContaining({
        axis: 'shade',
        label: 'DN350',
        product_id: 'ext_boj_dn350',
        swatch_color: expect.stringMatching(/^#[0-9a-f]{6}$/),
        selected: true,
      }),
    ]);
  });

  test('buildIdentityListingFromProduct does not strip formula-like alphanumeric titles without shade context', () => {
    const { buildIdentityListingFromProduct } = require('../../src/services/pdpIdentityGraph');

    const listing = buildIdentityListingFromProduct({
      merchantId: 'external_seed',
      productId: 'ext_vitamin_c23',
      sourceKind: 'external_seed',
      product: {
        title: 'Vitamin C23 Serum',
        brand: 'Example Labs',
        source_url: 'https://example.com/products/vitamin-c23-serum',
        variants: [{ variant_id: 'v1', title: 'Default Title' }],
      },
    });

    expect(listing.variant_axes).toEqual({ multi_variant: false });
    expect(listing.title_core_norm).toBe('vitamin c23 serum');
    expect(listing.source_meta.variant_family).toBeUndefined();
  });

  test('buildIdentityListingFromProduct ignores Default Title as a variant axis', () => {
    const { buildIdentityListingFromProduct } = require('../../src/services/pdpIdentityGraph');

    const listing = buildIdentityListingFromProduct({
      merchantId: 'external_seed',
      productId: 'ext_fenty_watch_ya_tone',
      sourceKind: 'external_seed',
      product: {
        title: 'Watch Ya Tone Niacinamide Dark Spot Serum',
        brand: 'Fenty Beauty',
        source_url: 'https://fentybeauty.com/products/watch-ya-tone-niacinamide-dark-spot-serum',
        variants: [{ variant_id: 'v1', title: 'Default Title' }],
      },
    });

    expect(listing.identity_status).toBe('approved');
    expect(listing.matched_by_rule).toBe('official_url_route');
    expect(listing.variant_axes).toEqual({ multi_variant: false });
    expect(listing.match_basis).toEqual([
      'official_url:https://fentybeauty.com/products/watch-ya-tone-niacinamide-dark-spot-serum',
    ]);
  });

  test('buildIdentityListingFromProduct groups numeric shade PDPs into one product line', () => {
    const { buildIdentityListingFromProduct } = require('../../src/services/pdpIdentityGraph');

    const buildFoundation = (shade) =>
      buildIdentityListingFromProduct({
        merchantId: 'external_seed',
        productId: `ext_fenty_foundation_${shade}`,
        sourceKind: 'external_seed',
        product: {
          title: `Pro Filt'r Soft Matte Longwear Foundation — #${shade}`,
          brand: 'Fenty Beauty',
          source_url: `https://fentybeauty.com/products/pro-filtr-soft-matte-longwear-foundation-${shade}`,
          variants: [{ variant_id: `v_${shade}`, title: 'Default Title' }],
        },
      });

    const shade190 = buildFoundation('190');
    const shade235 = buildFoundation('235');

    expect(shade190.variant_axes.shade).toBe('190');
    expect(shade235.variant_axes.shade).toBe('235');
    expect(shade190.title_core_norm).toBe('pro filtr soft matte longwear foundation');
    expect(shade235.title_core_norm).toBe('pro filtr soft matte longwear foundation');
    expect(shade190.product_line_id).toBe(shade235.product_line_id);
    expect(shade190.sellable_item_group_id).not.toBe(shade235.sellable_item_group_id);
  });

  test('buildIdentityListingFromProduct groups named shade PDPs into one product line', () => {
    const { buildIdentityListingFromProduct } = require('../../src/services/pdpIdentityGraph');

    const buildLipLiner = (shade) =>
      buildIdentityListingFromProduct({
        merchantId: 'external_seed',
        productId: `ext_fenty_liner_${shade.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
        sourceKind: 'external_seed',
        product: {
          title: `Trace'd Out Longwear Waterproof Pencil Lip Liner — ${shade}`,
          brand: 'Fenty Beauty',
          source_url: `https://fentybeauty.com/products/traced-out-longwear-waterproof-pencil-lip-liner-${shade
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')}`,
          variants: [{ variant_id: `v_${shade}`, title: 'Default Title' }],
        },
      });

    const bored = buildLipLiner('Bored Heaux');
    const whiskey = buildLipLiner('Whiskey');

    expect(bored.variant_axes.shade).toBe('bored heaux');
    expect(whiskey.variant_axes.shade).toBe('whiskey');
    expect(bored.title_core_norm).toBe('traced out longwear waterproof pencil lip liner');
    expect(whiskey.title_core_norm).toBe('traced out longwear waterproof pencil lip liner');
    expect(bored.product_line_id).toBe(whiskey.product_line_id);
    expect(bored.sellable_item_group_id).not.toBe(whiskey.sellable_item_group_id);
  });

  test('buildIdentityListingFromProduct groups scented body cream PDP siblings into one product line', () => {
    const { buildIdentityListingFromProduct } = require('../../src/services/pdpIdentityGraph');

    const buildBodyCream = (scent, productIdSuffix, optionName = 'Size / Color') =>
      buildIdentityListingFromProduct({
        merchantId: 'external_seed',
        productId: `ext_fenty_butta_${productIdSuffix}`,
        sourceKind: 'external_seed',
        product: {
          title: `Butta Drop Whipped Oil Body Cream with Tropical Oils + Shea Butter — ${scent}`,
          brand: 'Fenty Beauty',
          source_url: `https://fentybeauty.com/products/butta-drop-whipped-oil-body-cream-with-tropical-oils-shea-butter-${scent
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')}`,
          variants: [
            {
              variant_id: `v_${productIdSuffix}`,
              title: `Regular / ${scent}`,
              options: [
                { name: 'Variant', value: `Regular / ${scent}` },
              ],
              option_name: optionName,
              option_value:
                optionName === 'Color / Size'
                  ? `${scent} / ${scent}`
                  : `Regular / ${scent}`,
            },
          ],
        },
      });

    const saltedCaramel = buildBodyCream('Salted Caramel', 'salted_caramel');
    const vanillaDream = buildBodyCream('Vanilla Dream', 'vanilla_dream', 'Color / Size');
    const fentyFreshShimmering = buildBodyCream('Fenty Fresh Shimmering', 'fenty_fresh_shimmering');

    expect(saltedCaramel.variant_axes).toEqual({
      size: 'regular',
      color: 'salted caramel',
      multi_variant: false,
    });
    expect(vanillaDream.variant_axes).toEqual({
      color: 'vanilla dream',
      multi_variant: false,
    });
    expect(fentyFreshShimmering.variant_axes.color).toBe('fenty fresh shimmering');
    expect(saltedCaramel.title_core_norm).toBe(
      'butta drop whipped oil body cream tropical oils shea butter',
    );
    expect(vanillaDream.title_core_norm).toBe(
      'butta drop whipped oil body cream tropical oils shea butter',
    );
    expect(fentyFreshShimmering.title_core_norm).toBe(
      'butta drop whipped oil body cream tropical oils shea butter',
    );
    expect(saltedCaramel.product_line_id).toBe(vanillaDream.product_line_id);
    expect(saltedCaramel.product_line_id).toBe(fentyFreshShimmering.product_line_id);
    expect(saltedCaramel.sellable_item_group_id).not.toBe(vanillaDream.sellable_item_group_id);
    expect(saltedCaramel.sellable_item_group_id).not.toBe(fentyFreshShimmering.sellable_item_group_id);
  });

  test('buildIdentityListingFromProduct groups named shade PDPs for eye and brow color families', () => {
    const { buildIdentityListingFromProduct } = require('../../src/services/pdpIdentityGraph');

    const buildProduct = (title, shade) =>
      buildIdentityListingFromProduct({
        merchantId: 'external_seed',
        productId: `ext_fenty_${title}_${shade}`.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        sourceKind: 'external_seed',
        product: {
          title: `${title} — ${shade}`,
          brand: 'Fenty Beauty',
          source_url: `https://fentybeauty.com/products/${title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')}-${shade.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          variants: [{ variant_id: `v_${shade}`, title: 'Default Title' }],
        },
      });

    const bankTank = buildProduct('Flypencil Longwear Pencil Eyeliner', 'Bank Tank');
    const seaAboutIt = buildProduct('Flypencil Longwear Pencil Eyeliner', 'Sea About It');
    const lightBlonde = buildProduct('Brow MVP Ultra Fine Brow Pencil & Styler', 'Light Blonde');
    const mediumBrown = buildProduct('Brow MVP Ultra Fine Brow Pencil & Styler', 'Medium Brown');
    const blackMascara = buildProduct('Hella Thicc Volumizing Mascara', "Cuz I'm Black");
    const blueMascara = buildProduct('Hella Thicc Volumizing Mascara', "Elec'Trip Blue");
    const trophyWife = buildProduct('Diamond Bomb All-Over Diamond Veil', 'Trophy Wife');
    const pinkIce = buildProduct('Diamond Bomb All-Over Diamond Veil', 'Pink Ice');

    expect(bankTank.variant_axes.shade).toBe('bank tank');
    expect(seaAboutIt.variant_axes.shade).toBe('sea about it');
    expect(bankTank.product_line_id).toBe(seaAboutIt.product_line_id);
    expect(bankTank.sellable_item_group_id).not.toBe(seaAboutIt.sellable_item_group_id);

    expect(lightBlonde.variant_axes.shade).toBe('light blonde');
    expect(mediumBrown.variant_axes.shade).toBe('medium brown');
    expect(lightBlonde.product_line_id).toBe(mediumBrown.product_line_id);
    expect(lightBlonde.sellable_item_group_id).not.toBe(mediumBrown.sellable_item_group_id);

    expect(blackMascara.variant_axes.shade).toBe('cuz im black');
    expect(blueMascara.variant_axes.shade).toBe('electrip blue');
    expect(blackMascara.product_line_id).toBe(blueMascara.product_line_id);

    expect(trophyWife.variant_axes.shade).toBe('trophy wife');
    expect(pinkIce.variant_axes.shade).toBe('pink ice');
    expect(trophyWife.product_line_id).toBe(pinkIce.product_line_id);
  });

  test('maybeBuildLiveSyntheticPdp allows live rows by identity brand when fallback product lacks brand', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      PDP_IDENTITY_GRAPH_ENABLED: 'true',
      PDP_IDENTITY_GRAPH_BRAND_ALLOWLIST: 'Beauty of Joseon',
    };
    const { maybeBuildLiveSyntheticPdp } = require('../../src/services/pdpIdentityGraph');
    const sourceRow = {
      source_listing_ref: 'external_seed:ext_boj_dn310',
      merchant_id: 'external_seed',
      product_id: 'ext_boj_dn310',
      source_kind: 'external_seed',
      source_tier: 'brand',
      live_read_enabled: true,
      sellable_item_group_id: 'sig_boj_dn310',
      product_line_id: 'pl_boj_tinted_fluid',
      review_family_id: 'rf_boj_tinted_fluid',
      identity_status: 'approved',
      identity_confidence: 0.94,
      brand_norm: 'beauty of joseon',
      match_basis: ['variant_family:beauty of joseon:daily tinted fluid sunscreen'],
      variant_axes: { shade: 'dn310', size: '50ml', multi_variant: true },
      source_payload: {
        title: 'Daily Tinted Fluid Sunscreen DN310',
        images: [{ url: 'https://cdn.example.com/dn310.jpg' }],
      },
    };
    const siblingRow = {
      ...sourceRow,
      source_listing_ref: 'external_seed:ext_boj_dn350',
      product_id: 'ext_boj_dn350',
      sellable_item_group_id: 'sig_boj_dn350',
      variant_axes: { shade: 'dn350', size: '50ml', multi_variant: true },
      source_payload: {
        title: 'Daily Tinted Fluid Sunscreen DN350',
        images: [{ url: 'https://cdn.example.com/dn350.jpg' }],
      },
    };
    const queryFn = jest.fn(async (sql) => {
      const normalizedSql = String(sql || '').replace(/\s+/g, ' ').trim();
      if (normalizedSql.includes('merchant_id = $1')) return { rows: [sourceRow] };
      if (normalizedSql.includes('sellable_item_group_id = $1')) return { rows: [sourceRow] };
      if (normalizedSql.includes('product_line_id = $1')) return { rows: [sourceRow, siblingRow] };
      return { rows: [] };
    });

    const result = await maybeBuildLiveSyntheticPdp({
      merchantId: 'external_seed',
      productId: 'ext_boj_dn310',
      canonicalProduct: {
        product_id: 'ext_boj_dn310',
        merchant_id: 'external_seed',
        title: 'Daily Tinted Fluid Sunscreen DN310',
      },
      queryFn,
    });

    expect(result?.canonical_scope).toBe('synthetic');
    expect(result?.synthetic_product.product_line_options).toEqual([
      expect.objectContaining({
        label: 'DN310',
        swatch_color: expect.stringMatching(/^#[0-9a-f]{6}$/),
        selected: true,
      }),
      expect.objectContaining({
        label: 'DN350',
        swatch_color: expect.stringMatching(/^#[0-9a-f]{6}$/),
        selected: false,
      }),
    ]);
    expect(result?.line_members).toEqual([
      expect.objectContaining({ product_id: 'ext_boj_dn310', merchant_id: 'external_seed' }),
      expect.objectContaining({ product_id: 'ext_boj_dn350', merchant_id: 'external_seed' }),
    ]);
  });

  test('buildIdentityListingFromProduct canonicalizes official URL host before conflict checks', () => {
    const { buildIdentityListingFromProduct, _internals } = require('../../src/services/pdpIdentityGraph');

    const refillWithoutWww = buildIdentityListingFromProduct({
      merchantId: 'external_seed',
      productId: 'ext_inn_elastic_refill_a',
      sourceKind: 'external_seed',
      product: {
        title: 'Elastic Skin',
        brand: 'INNBEAUTY Project',
        source_url: 'https://innbeautyproject.com/products/elastic-skin?variant=41576028110896',
        default_variant_id: '41576028110896',
        variants: [
          {
            variant_id: '41576028110896',
            title: 'Refill',
            option_name: 'Size',
            option_value: 'Refill',
          },
        ],
      },
    });
    const refillWithWww = buildIdentityListingFromProduct({
      merchantId: 'external_seed',
      productId: 'ext_inn_elastic_refill_b',
      sourceKind: 'external_seed',
      product: {
        title: 'Elastic Skin',
        brand: 'INNBEAUTY Project',
        source_url: 'https://www.innbeautyproject.com/products/elastic-skin?variant=41576028110896',
        default_variant_id: '41576028110896',
        variants: [
          {
            variant_id: '41576028110896',
            title: 'Refill',
            option_name: 'Size',
            option_value: 'Refill',
          },
        ],
      },
    });

    expect(refillWithoutWww.strong_identity.official_url).toBe(
      'https://innbeautyproject.com/products/elastic-skin',
    );
    expect(refillWithWww.strong_identity.official_url).toBe(
      'https://innbeautyproject.com/products/elastic-skin',
    );
    expect(refillWithWww.strong_identity.official_domain).toBe('innbeautyproject.com');
    expect(refillWithWww.sellable_item_group_id).toBe(refillWithoutWww.sellable_item_group_id);

    const clustered = _internals.clusterIdentityListings([refillWithoutWww, refillWithWww]);
    expect(clustered.every((listing) => listing.identity_status === 'approved')).toBe(true);
    expect(clustered.every((listing) => listing.review_required === false)).toBe(true);
    expect(clustered.flatMap((listing) => listing.review_reason_codes)).not.toContain(
      'conflicting_official_url',
    );
  });

  test('buildIdentityListingFromProduct resolves generic option axes when a selected variant is explicit', () => {
    const { buildIdentityListingFromProduct } = require('../../src/services/pdpIdentityGraph');

    const listing = buildIdentityListingFromProduct({
      merchantId: 'external_seed',
      productId: 'ext_inn_extreme_cream',
      sourceKind: 'external_seed',
      product: {
        title: 'Extreme Cream',
        brand: 'INNBEAUTY Project',
        source_url: 'https://innbeautyproject.com/products/extreme-cream',
        default_variant_id: '41148734701616',
        variants: [
          {
            variant_id: '41148734668848',
            title: 'Extreme Cream',
            option_name: 'Option',
            option_value: 'Full Size',
          },
          {
            variant_id: '41148734701616',
            title: 'Extreme Cream',
            option_name: 'Option',
            option_value: 'Refill',
          },
        ],
      },
    });

    expect(listing.identity_status).toBe('approved');
    expect(listing.review_required).toBe(false);
    expect(listing.variant_axes).toEqual({
      size: 'refill',
      multi_variant: true,
    });
    expect(listing.matched_by_rule).toBe('official_url_axes');
    expect(listing.match_basis).toContain(
      'variant_axes:size:refill',
    );
  });

  test('buildIdentityListingFromProduct keeps generic multi-variant pages blocked without explicit variant selection', () => {
    const { buildIdentityListingFromProduct } = require('../../src/services/pdpIdentityGraph');

    const listing = buildIdentityListingFromProduct({
      merchantId: 'external_seed',
      productId: 'ext_inn_extreme_cream_unresolved',
      sourceKind: 'external_seed',
      product: {
        title: 'Extreme Cream',
        brand: 'INNBEAUTY Project',
        source_url: 'https://innbeautyproject.com/products/extreme-cream',
        variants: [
          {
            variant_id: '41148734668848',
            title: 'Extreme Cream',
            option_name: 'Option',
            option_value: 'Full Size',
          },
          {
            variant_id: '41148734701616',
            title: 'Extreme Cream',
            option_name: 'Option',
            option_value: 'Refill',
          },
        ],
      },
    });

    expect(listing.identity_status).toBe('review_required');
    expect(listing.review_required).toBe(true);
    expect(listing.review_reason_codes).toEqual(
      expect.arrayContaining([
        'multi_variant_exact_item_unresolved',
        'insufficient_exact_item_evidence',
      ]),
    );
    expect(listing.variant_axes).toEqual({
      multi_variant: true,
    });
  });

  test('composeSyntheticCanonicalProduct keeps exact-item gallery separate from product-line preview and aggregates review scope', () => {
    const { composeSyntheticCanonicalProduct } = require('../../src/services/pdpIdentityGraph');

    const requestedListing = {
      merchant_id: 'external_seed',
      product_id: 'ext_krave_gbr_45',
      source_kind: 'external_seed',
      source_tier: 'brand',
      sellable_item_group_id: 'sig_exact_45',
      product_line_id: 'pl_krave_gbr',
      review_family_id: 'rf_krave_gbr',
      identity_confidence: 0.93,
      variant_axes: { size: '45ml' },
      source_payload: {
        title: 'Great Barrier Relief',
        brand: 'KraveBeauty',
        description: 'Barrier support serum.',
        images: [{ url: 'https://cdn.example.com/gbr-45-main.jpg' }],
      },
      review_summary: {
        rating: 4.5,
        review_count: 12,
      },
    };
    const siblingListing = {
      merchant_id: 'external_seed',
      product_id: 'ext_krave_gbr_100',
      source_kind: 'external_seed',
      source_tier: 'brand',
      sellable_item_group_id: 'sig_exact_100',
      product_line_id: 'pl_krave_gbr',
      review_family_id: 'rf_krave_gbr',
      identity_confidence: 0.91,
      variant_axes: { size: '100ml' },
      source_payload: {
        title: 'Great Barrier Relief Jumbo',
        brand: 'KraveBeauty',
        images: [{ url: 'https://cdn.example.com/gbr-100-main.jpg' }],
      },
      review_summary: {
        rating: 4.8,
        review_count: 30,
      },
    };

    const composed = composeSyntheticCanonicalProduct({
      requestedListing,
      exactListings: [requestedListing],
      lineListings: [requestedListing, siblingListing],
    });

    expect(composed.product.canonical_scope).toBe('synthetic');
    expect(composed.product.gallery_scope).toBe('exact_item');
    expect(composed.product.preview_scope).toBe('product_line');
    expect(composed.product.images).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example.com/gbr-45-main.jpg',
        source_kind: 'external_seed',
        source_scope: 'exact_item',
      }),
    ]);
    expect(composed.product.line_preview_images).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example.com/gbr-100-main.jpg',
        source_scope: 'product_line_preview',
      }),
    ]);
    expect(composed.product.product_line_option_name).toBe('Size');
    expect(composed.product.product_line_options).toEqual([
      expect.objectContaining({
        axis: 'size',
        label: '45ml',
        product_id: 'ext_krave_gbr_45',
        selected: true,
      }),
      expect.objectContaining({
        axis: 'size',
        label: '100ml',
        product_id: 'ext_krave_gbr_100',
        selected: false,
      }),
    ]);
    expect(composed.product.review_summary).toEqual(
      expect.objectContaining({
        aggregation_scope: 'product_line',
        exact_item_review_count: 12,
        product_line_review_count: 42,
        scoped_summaries: expect.objectContaining({
          product_line: expect.objectContaining({
            review_count: 42,
          }),
          exact_item: expect.objectContaining({
            review_count: 12,
          }),
        }),
      }),
    );
  });

  test('backfill product fetch does not depend on products_cache created_at column', async () => {
    const { _internals } = require('../../src/services/pdpIdentityGraph');
    const queries = [];
    const queryFn = jest.fn(async (sql, params) => {
      queries.push(String(sql));
      if (String(sql).includes('FROM products_cache')) {
        expect(String(sql)).not.toContain('created_at');
        expect(String(sql)).not.toContain('updated_at');
        expect(String(sql)).toContain("product_data->>'vendor'");
        expect(String(sql)).toContain("regexp_replace(lower(coalesce(product_data->>'title'");
        expect(params).toEqual(['external_seed', ['kravebeauty'], ['%kravebeauty%'], 10]);
        return {
          rows: [
            {
              merchant_id: 'merch_krave',
              platform_product_id: '10008793153864',
              cached_at: '2026-04-10T00:00:00Z',
              product_data: {
                product_id: '10008793153864',
                title: 'KraveBeauty Great Barrier Relief',
                brand: { name: 'KraveBeauty' },
              },
            },
          ],
        };
      }
      if (String(sql).includes('FROM external_product_seeds')) {
        expect(String(sql)).toContain("seed_data->>'vendor'");
        expect(String(sql)).toContain("regexp_replace(lower(coalesce(title, seed_data->>'title'");
        expect(params).toEqual([['kravebeauty'], ['%kravebeauty%'], 10]);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const rows = await _internals.fetchBackfillProducts({
      limit: 10,
      brandFilter: 'KraveBeauty',
      queryFn,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'merch_krave',
        product_id: '10008793153864',
        source_kind: 'internal',
      }),
    );
    expect(queries).toHaveLength(2);
  });

  test('backfill product fetch normalizes brand punctuation for source selection', async () => {
    const { _internals } = require('../../src/services/pdpIdentityGraph');
    const queries = [];
    const queryFn = jest.fn(async (sql, params) => {
      queries.push(String(sql));
      if (String(sql).includes('FROM products_cache')) {
        expect(String(sql)).toContain('regexp_replace(lower(trim(coalesce(');
        expect(String(sql)).toContain("regexp_replace(lower(coalesce(product_data->>'title'");
        expect(params).toEqual(['external_seed', ['paulaschoice'], ['%paulaschoice%'], 10]);
        return { rows: [] };
      }
      if (String(sql).includes('FROM external_product_seeds')) {
        expect(String(sql)).toContain('regexp_replace(lower(trim(coalesce(');
        expect(String(sql)).toContain("regexp_replace(lower(coalesce(title, seed_data->>'title'");
        expect(params).toEqual([['paulaschoice'], ['%paulaschoice%'], 10]);
        return {
          rows: [
            {
              id: 'eps_paulas',
              external_product_id: 'ext_paulas_bha',
              title: "Paula's Choice 2% BHA Liquid Exfoliant",
              seed_data: {
                brand_name: "Paula's Choice",
                title: "Paula's Choice 2% BHA Liquid Exfoliant",
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const rows = await _internals.fetchBackfillProducts({
      limit: 10,
      brandFilter: "Paula's Choice",
      queryFn,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_paulas_bha',
        source_kind: 'external_seed',
      }),
    );
    expect(queries).toHaveLength(2);
  });

  test('backfill product fetch matches ampersand and plus brand aliases', async () => {
    const { _internals } = require('../../src/services/pdpIdentityGraph');
    expect(_internals.buildBrandFilterTokens('Fable & Mane')).toEqual({
      normalized: 'fable and mane',
      normalizedVariants: ['fable and mane', 'fable mane'],
      compactVariants: ['fableandmane', 'fablemane'],
      titlePatterns: ['%fableandmane%', '%fablemane%'],
    });
    expect(_internals.buildBrandFilterTokens('R+Co')).toEqual({
      normalized: 'r plus co',
      normalizedVariants: ['r plus co', 'r co'],
      compactVariants: ['rplusco', 'rco'],
      titlePatterns: ['%rplusco%'],
    });
  });

  test('backfill product fetch keeps plus-brand rows after post filtering', async () => {
    const { _internals } = require('../../src/services/pdpIdentityGraph');
    const queryFn = jest.fn(async (sql) => {
      if (String(sql).includes('FROM products_cache')) return { rows: [] };
      if (String(sql).includes('FROM external_product_seeds')) {
        return {
          rows: [
            {
              id: 'eps_rco',
              external_product_id: 'ext_rco_oil',
              title: 'ON A CLOUD Bond Building + Repair Styling Oil',
              seed_data: {
                brand: 'R+Co',
                title: 'ON A CLOUD Bond Building + Repair Styling Oil',
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const rows = await _internals.fetchBackfillProducts({
      limit: 10,
      brandFilter: 'R+Co',
      queryFn,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_rco_oil',
      }),
    );
  });

  test('backfill product fetch can use official domain when seed brand is missing', async () => {
    const { _internals } = require('../../src/services/pdpIdentityGraph');
    const queryFn = jest.fn(async (sql) => {
      if (String(sql).includes('FROM products_cache')) return { rows: [] };
      if (String(sql).includes('FROM external_product_seeds')) {
        return {
          rows: [
            {
              id: 'eps_tomford_fragrance',
              external_product_id: 'ext_tomford_fragrance',
              domain: 'www.tomfordbeauty.com',
              title: 'Figue Erotique Eau de Parfum',
              seed_data: {
                title: 'Figue Erotique Eau de Parfum',
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const rows = await _internals.fetchBackfillProducts({
      limit: 10,
      brandFilter: 'Tom Ford Beauty',
      queryFn,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_tomford_fragrance',
      }),
    );
  });

  test('listLivePdpIdentityRowsForRefs does not depend on PDP live-read feature flag', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://example.test/pivota',
      PDP_IDENTITY_GRAPH_ENABLED: 'false',
    };
    jest.resetModules();
    const { listLivePdpIdentityRowsForRefs } = require('../../src/services/pdpIdentityGraph');
    const queryFn = jest.fn(async () => ({
      rows: [
        {
          source_listing_ref: 'external_seed:ext_1',
          merchant_id: 'external_seed',
          product_id: 'ext_1',
          source_kind: 'external_seed',
          source_tier: 'brand',
          live_read_enabled: true,
          sellable_item_group_id: 'sig_1',
          product_line_id: 'pl_1',
          review_family_id: 'rf_1',
          identity_status: 'approved',
          identity_confidence: 0.98,
          matched_by_rule: 'official_url_soft_exact_cluster',
          match_basis: ['official_url:https://brand.example/products/ext-1'],
          strong_identity: {},
          soft_identity: {},
          variant_axes: { volume: '45ml' },
          source_payload: { title: 'Example Product' },
          review_summary: {},
          official_url: 'https://brand.example/products/ext-1',
          official_domain: 'brand.example',
          brand_norm: 'example',
          title_norm: 'example product',
          title_core_norm: 'example product',
          review_required: false,
          review_reason_codes: [],
          created_at: '2026-04-10T00:00:00Z',
          updated_at: '2026-04-10T00:00:00Z',
        },
      ],
    }));

    const rows = await listLivePdpIdentityRowsForRefs({
      sourceListingRefs: ['external_seed:ext_1'],
      queryFn,
    });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        source_listing_ref: 'external_seed:ext_1',
        identity_status: 'approved',
        live_read_enabled: true,
        sellable_item_group_id: 'sig_1',
      }),
    );
  });

  test('promotePdpIdentityLiveRead dry-run enables whole exact-item groups backed by brand source', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://example.test/pivota',
      PDP_IDENTITY_GRAPH_ENABLED: 'false',
    };
    jest.resetModules();
    const { promotePdpIdentityLiveRead } = require('../../src/services/pdpIdentityGraph');
    const candidateRow = {
      source_listing_ref: 'external_seed:ext_1',
      merchant_id: 'external_seed',
      product_id: 'ext_1',
      source_kind: 'external_seed',
      source_tier: 'brand',
      live_read_enabled: false,
      sellable_item_group_id: 'sig_1',
      product_line_id: 'pl_1',
      review_family_id: 'rf_1',
      identity_status: 'approved',
      identity_confidence: 0.98,
      match_basis: [],
      strong_identity: {},
      soft_identity: {},
      variant_axes: { volume: '45ml' },
      source_payload: { title: 'Example Product' },
      review_summary: {},
      official_domain: 'brand.example',
      brand_norm: 'example',
      title_norm: 'example product',
      title_core_norm: 'example product',
      review_required: false,
      review_reason_codes: [],
    };
    const merchantRow = {
      ...candidateRow,
      source_listing_ref: 'merch_1:prod_1',
      merchant_id: 'merch_1',
      product_id: 'prod_1',
      source_kind: 'internal',
      source_tier: 'merchant',
    };
    const queryFn = jest
      .fn()
      .mockResolvedValueOnce({ rows: [candidateRow] })
      .mockResolvedValueOnce({ rows: [candidateRow, merchantRow] });

    const result = await promotePdpIdentityLiveRead({
      brand: 'Example',
      dryRun: true,
      limit: 50,
      queryFn,
    });

    expect(result).toEqual(
      expect.objectContaining({
        dry_run: true,
        candidate_rows_scanned: 1,
        groups_considered: 1,
        groups_eligible: 1,
        rows_to_enable: 2,
        overrides_to_write: 2,
        updated_rows: 0,
        brand_filter: 'example',
      }),
    );
    expect(result.sample_refs).toEqual(
      expect.arrayContaining(['external_seed:ext_1', 'merch_1:prod_1']),
    );
  });

  test('promotePdpIdentityLiveRead writes approve_live_read overrides and updates rows', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://example.test/pivota',
    };
    jest.resetModules();
    const { promotePdpIdentityLiveRead } = require('../../src/services/pdpIdentityGraph');
    const candidateRow = {
      source_listing_ref: 'external_seed:ext_1',
      merchant_id: 'external_seed',
      product_id: 'ext_1',
      source_kind: 'external_seed',
      source_tier: 'brand',
      live_read_enabled: false,
      sellable_item_group_id: 'sig_1',
      product_line_id: 'pl_1',
      review_family_id: 'rf_1',
      identity_status: 'approved',
      identity_confidence: 0.98,
      match_basis: [],
      strong_identity: {},
      soft_identity: {},
      variant_axes: { volume: '45ml' },
      source_payload: { title: 'Example Product' },
      review_summary: {},
      official_domain: 'brand.example',
      brand_norm: 'example',
      title_norm: 'example product',
      title_core_norm: 'example product',
      review_required: false,
      review_reason_codes: [],
    };
    const merchantRow = {
      ...candidateRow,
      source_listing_ref: 'merch_1:prod_1',
      merchant_id: 'merch_1',
      product_id: 'prod_1',
      source_kind: 'internal',
      source_tier: 'merchant',
    };
    const queryFn = jest
      .fn()
      .mockResolvedValueOnce({ rows: [candidateRow] })
      .mockResolvedValueOnce({ rows: [candidateRow, merchantRow] });
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rowCount: 2 })
        .mockResolvedValueOnce({}),
    };
    const withClientFn = jest.fn(async (work) => work(client));

    const result = await promotePdpIdentityLiveRead({
      brand: 'Example',
      dryRun: false,
      limit: 50,
      createdBy: 'codex',
      queryFn,
      withClientFn,
    });

    expect(withClientFn).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    const insertCalls = client.query.mock.calls.filter((call) =>
      String(call[0]).includes('INSERT INTO pdp_identity_override'),
    );
    expect(insertCalls).toHaveLength(2);
    const updateCall = client.query.mock.calls.find((call) =>
      String(call[0]).includes('UPDATE pdp_identity_listing'),
    );
    expect(updateCall).toBeTruthy();
    expect(result).toEqual(
      expect.objectContaining({
        dry_run: false,
        groups_eligible: 1,
        rows_to_enable: 2,
        overrides_to_write: 2,
        updated_rows: 2,
      }),
    );
  });

  test('summarizePdpIdentityCoverageByBrand normalizes coverage ratios', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://example.test/pivota',
    };
    jest.resetModules();
    const { summarizePdpIdentityCoverageByBrand } = require('../../src/services/pdpIdentityGraph');
    const queryFn = jest.fn().mockResolvedValue({
      rows: [
        {
          brand_norm: 'fenty beauty',
          internal_rows: 2,
          external_rows: 8,
          beauty_external_rows: 8,
          source_rows: 10,
          identity_rows: 4,
          live_rows: 3,
          approved_rows: 4,
          review_rows: 1,
        },
      ],
    });

    const result = await summarizePdpIdentityCoverageByBrand({
      limit: 5,
      minSourceRows: 1,
      queryFn,
    });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      expect.objectContaining({
        brand_norm: 'fenty beauty',
        source_rows: 10,
        identity_rows: 4,
        live_rows: 3,
        approved_rows: 4,
        review_rows: 1,
        missing_identity_rows: 6,
        pending_live_rows: 1,
        identity_coverage_ratio: 0.4,
        live_coverage_ratio: 0.75,
        review_ratio: 0.25,
      }),
    ]);
  });

  test('summarizePdpIdentityCoverageByBrand normalizes punctuation brands in source joins', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://example.test/pivota',
    };
    jest.resetModules();
    const { summarizePdpIdentityCoverageByBrand } = require('../../src/services/pdpIdentityGraph');
    const queryFn = jest.fn().mockResolvedValue({
      rows: [
        {
          brand_norm: 'paulas choice',
          internal_rows: 0,
          external_rows: 8,
          beauty_external_rows: 8,
          source_rows: 8,
          identity_rows: 8,
          live_rows: 8,
          approved_rows: 8,
          review_rows: 0,
        },
      ],
    });

    const result = await summarizePdpIdentityCoverageByBrand({
      brand: "Paula's Choice",
      limit: 1,
      minSourceRows: 0,
      beautyOnly: false,
      queryFn,
    });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(String(queryFn.mock.calls[0][0])).toContain("regexp_replace(regexp_replace(regexp_replace(lower(trim(coalesce(");
    expect(queryFn.mock.calls[0][1]).toEqual([
      'external_seed',
      expect.any(Array),
      'paulas choice',
      0,
      1,
    ]);
    expect(result).toEqual([
      expect.objectContaining({
        brand_norm: 'paulas choice',
        source_rows: 8,
        identity_rows: 8,
        live_rows: 8,
        identity_coverage_ratio: 1,
        live_coverage_ratio: 1,
      }),
    ]);
  });

  test('runPdpIdentityCoverageLift dry-run backfills and promotes selected brands', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://example.test/pivota',
    };
    jest.resetModules();
    const { runPdpIdentityCoverageLift } = require('../../src/services/pdpIdentityGraph');
    const summaryFn = jest
      .fn()
      .mockResolvedValueOnce([
        {
          brand_norm: 'fenty beauty',
          source_rows: 100,
          identity_rows: 0,
          live_rows: 0,
          approved_rows: 0,
          review_rows: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          brand_norm: 'fenty beauty',
          source_rows: 100,
          identity_rows: 40,
          live_rows: 30,
          approved_rows: 40,
          review_rows: 10,
        },
      ]);
    const backfillFn = jest.fn().mockResolvedValue({
      dry_run: true,
      identity_rows_built: 40,
      review_queue_rows_built: 10,
      written_rows: 0,
      review_queue_rows: 0,
    });
    const promoteFn = jest.fn().mockResolvedValue({
      dry_run: true,
      rows_to_enable: 30,
      updated_rows: 0,
    });

    const result = await runPdpIdentityCoverageLift({
      dryRun: true,
      topBrands: 1,
      summaryFn,
      backfillFn,
      promoteFn,
      queryFn: jest.fn(),
      withClientFn: jest.fn(),
    });

    expect(backfillFn).toHaveBeenCalledTimes(1);
    expect(backfillFn).toHaveBeenCalledWith(
      expect.objectContaining({
        brand: 'fenty beauty',
        dryRun: true,
        limit: 100,
      }),
    );
    expect(promoteFn).toHaveBeenCalledTimes(1);
    expect(promoteFn).toHaveBeenCalledWith(
      expect.objectContaining({
        brand: 'fenty beauty',
        dryRun: true,
        limit: 400,
        requireBrandSource: true,
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        dry_run: true,
        brands_selected: ['fenty beauty'],
        totals: expect.objectContaining({
          brands_processed: 1,
          brands_written: 0,
          promote_rows_targeted: 30,
        }),
      }),
    );
    expect(result.results[0]).toEqual(
      expect.objectContaining({
        brand_norm: 'fenty beauty',
        write_applied: false,
        review_ratio: 0.25,
      }),
    );
  });

  test('runPdpIdentityCoverageLift skips write when preview review ratio is too high', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://example.test/pivota',
    };
    jest.resetModules();
    const { runPdpIdentityCoverageLift } = require('../../src/services/pdpIdentityGraph');
    const summaryFn = jest
      .fn()
      .mockResolvedValueOnce([
        {
          brand_norm: 'tom ford beauty',
          source_rows: 120,
          identity_rows: 0,
          live_rows: 0,
          approved_rows: 0,
          review_rows: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          brand_norm: 'tom ford beauty',
          source_rows: 120,
          identity_rows: 0,
          live_rows: 0,
          approved_rows: 0,
          review_rows: 0,
        },
      ]);
    const backfillFn = jest.fn().mockResolvedValue({
      dry_run: true,
      identity_rows_built: 50,
      review_queue_rows_built: 40,
      written_rows: 0,
      review_queue_rows: 0,
    });
    const promoteFn = jest.fn();

    const result = await runPdpIdentityCoverageLift({
      dryRun: false,
      topBrands: 1,
      maxReviewRatio: 0.5,
      summaryFn,
      backfillFn,
      promoteFn,
      queryFn: jest.fn(),
      withClientFn: jest.fn(),
    });

    expect(backfillFn).toHaveBeenCalledTimes(1);
    expect(promoteFn).not.toHaveBeenCalled();
    expect(result.results[0]).toEqual(
      expect.objectContaining({
        brand_norm: 'tom ford beauty',
        write_applied: false,
        skip_reason: 'review_ratio_exceeds_threshold',
        review_ratio: 0.8,
      }),
    );
    expect(result.totals).toEqual(
      expect.objectContaining({
        brands_processed: 1,
        brands_written: 0,
        skipped_brands: 1,
      }),
    );
  });
});
