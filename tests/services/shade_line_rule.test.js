// Rule shade_line_v2 (src/services/shadeLineRule.js): per-shade product pages of one store's colour
// line become one product line. Every store, brand, code and shade name below is invented; the
// titles only keep the SHAPES retailers use.

describe('shade line rule (shade_line_v2)', () => {
  const ORIGINAL_ENV = process.env;
  const FLAG = 'SHADE_LINE_RULE_V2_ENABLED';

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test', [FLAG]: 'true' };
    delete process.env.PDP_IDENTITY_GRAPH_AUTO_ENABLE_LIVE;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // A seed-shaped payload: product_type is the 'external' placeholder and there is no category,
  // exactly the shape that hid nail lines from rule v1. The catalog category / type, when a test
  // gives them, arrive the way the backfill passes them: on sourceMeta.
  function buildListing(title, {
    brand = 'BRANDA',
    price = 30,
    currency = 'SGD',
    domain = 'shop-one.example',
    merchantId = 'merch_obs_shopone',
    productType = 'nail-polish',
    categoryPath = null,
    productId = null,
    extraProduct = {},
  } = {}) {
    const { buildIdentityListingFromProduct } = require('../../src/services/pdpIdentityGraph');
    const id = productId || `${slug(domain)}-${slug(title) || 'x'}`;
    return buildIdentityListingFromProduct({
      merchantId,
      productId: id,
      sourceKind: 'external_seed',
      sourceMeta: {
        ...(productType ? { catalog_product_type: productType } : {}),
        ...(categoryPath ? { catalog_category_path: categoryPath } : {}),
      },
      product: {
        title,
        brand,
        product_type: 'external',
        price: { amount: price, currency },
        currency,
        canonical_url: `https://${domain}/products/${id}`,
        image_url: `https://${domain}/images/${id}.jpg`,
        ...extraProduct,
      },
    });
  }

  function group(listings, options) {
    const { applyShadeLineGrouping } = require('../../src/services/shadeLineRule');
    return applyShadeLineGrouping(listings, options);
  }

  const decisionOf = (listing) => listing.soft_identity?.shade_line || null;
  const refusalOf = (listing) => (decisionOf(listing)?.status === 'refused' ? decisionOf(listing).reason : null);
  const lineIds = (listings) => listings.map((listing) => listing.product_line_id);

  describe('title formats', () => {
    test.each([
      // <LINE> <CODE> <NAME> with a one-letter code prefix
      ['BRANDA AURA K2207 SAFFRON', { format: 'code_name', line: 'BRANDA AURA', code: 'k2207', name: 'SAFFRON' }],
      ['BRANDA AURA T415 MOSS GREEN', { format: 'code_name', line: 'BRANDA AURA', code: 't415', name: 'MOSS GREEN' }],
      // two-letter code prefix
      ['BRANDC LUMA RX318 PEWTER', { format: 'code_name', line: 'BRANDC LUMA', code: 'rx318', name: 'PEWTER' }],
      // bare number code, name after it
      ['BRANDA TINT PRO 517 HARBOR MIST', { format: 'code_name', line: 'BRANDA TINT PRO', code: '517', name: 'HARBOR MIST' }],
      // the line is the brand alone
      ['BRANDC 731 PAPAYA', { format: 'code_name', line: 'BRANDC', code: '731', name: 'PAPAYA' }],
      // <Brand> <Line> <NN> <Name>, code glued to the line word
      ['BRANDE Silkfold Lacquer-405 Dune Rose', { format: 'code_name', line: 'BRANDE Silkfold Lacquer', code: '405', name: 'Dune Rose' }],
      // <LINE> <CODE> alone, NO. prefix joined and split
      ['BRANDB LACQ NO.884', { format: 'code_only', line: 'BRANDB LACQ', code: '884', name: '' }],
      ['BRANDB LACQ NO 37', { format: 'code_only', line: 'BRANDB LACQ', code: '37', name: '' }],
      // bracket tags are stripped before keying
      ['[RETIRED] BRANDB LACQ NO.885', { format: 'code_only', line: 'BRANDB LACQ', code: '885', name: '' }],
      ['BRANDB LACQ NO.886 [BACKORDER]', { format: 'code_only', line: 'BRANDB LACQ', code: '886', name: '' }],
      // <LINE> - <NAME> #<CODE>
      ['BRANDD ATELIER - PEAR SPRITZ #271', { format: 'separator_name_hash_code', line: 'BRANDD ATELIER', code: '271', name: 'PEAR SPRITZ' }],
      // <parent> - <suffix> child
      ['BRANDF Volume Lash - Ink Plum', { format: 'separator_name', line: 'BRANDF Volume Lash', code: '', name: 'Ink Plum' }],
    ])('parses %s', (title, expected) => {
      const { parseShadeLineTitle } = require('../../src/services/shadeLineRule');
      expect(parseShadeLineTitle(title)).toEqual(expected);
    });

    test.each([
      ['BRANDA GEL 24H SHINE'],
      ['BRANDA LIP OIL 15 ML'],
      ['BRANDA SUNSCREEN SPF 50'],
      // a size glued to its unit is not a shade code
      ['BRANDA Loose Powder 15g'],
      ['BRANDA Loose Powder 30g Translucent'],
      ['BRANDA Body Mist 50l'],
      // a year is not a shade code
      ['BRANDA Nail Polish Holiday 2024 Ruby'],
      ['BRANDA'],
    ])('reads no shade code in %s', (title) => {
      const { parseShadeLineTitle } = require('../../src/services/shadeLineRule');
      expect(parseShadeLineTitle(title)).toBeNull();
    });
  });

  describe('flag (SHADE_LINE_RULE_V2_ENABLED)', () => {
    test('off: the builder computes no candidate and the batch pass is never reached', () => {
      delete process.env[FLAG];
      const listing = buildListing('BRANDA AURA K2207 SAFFRON');
      expect(listing.shade_line_candidate).toBeUndefined();
      process.env[FLAG] = 'false';
      expect(buildListing('BRANDA AURA T415 MOSS').shade_line_candidate).toBeUndefined();
    });

    test('on: the same title yields a candidate', () => {
      expect(buildListing('BRANDA AURA K2207 SAFFRON').shade_line_candidate).toMatchObject({ line_norm: 'branda aura', code: 'k2207' });
    });
  });

  describe('keying', () => {
    test('one-letter-code shades of one line share one product line keyed on the line words, brand and store only', () => {
      const listings = [
        buildListing('BRANDA AURA K2207 SAFFRON'),
        buildListing('BRANDA AURA T415 MOSS'),
        buildListing('[RETIRED] BRANDA AURA P380 HARBOR'),
      ];
      expect(new Set(lineIds(listings)).size).toBe(3);

      const { listings: grouped, stats } = group(listings);
      expect(new Set(lineIds(grouped)).size).toBe(1);
      expect(stats).toMatchObject({ approved: 3, lines: 1 });
      const decision = decisionOf(grouped[0]);
      expect(decision).toMatchObject({ rule_version: 'shade_line_v2', status: 'approved', product_line_id: grouped[0].product_line_id });
      expect(decision.line_key).toBe('shade_line_v2:merch_obs_shopone@shop-one.example:branda:branda aura');
      expect(decision.store).toBe('merch_obs_shopone@shop-one.example');
      expect(decision.line_key).not.toMatch(/saffron|moss|harbor|k2207/);
      expect(grouped.map((listing) => listing.variant_axes.shade)).toEqual(['k2207 saffron', 't415 moss', 'p380 harbor']);
      expect(new Set(grouped.map((listing) => listing.sellable_item_group_id)).size).toBe(3);
    });

    test('the PDP shade picker lists the line\'s siblings, each linking its own listing', () => {
      const { composeSyntheticCanonicalProduct } = require('../../src/services/pdpIdentityGraph');
      const { listings: grouped } = group([
        buildListing('BRANDA AURA K2207 SAFFRON'),
        buildListing('BRANDA AURA T415 MOSS'),
        buildListing('BRANDA AURA P380 HARBOR'),
      ]);
      const composed = composeSyntheticCanonicalProduct({
        requestedListing: grouped[1],
        exactListings: [grouped[1]],
        lineListings: grouped,
      });
      expect(composed.product.product_line_option_name).toBe('Shade');
      expect(composed.product.product_line_options.map((option) => [option.label, option.product_id, option.selected])).toEqual([
        ['K2207 Saffron', grouped[0].product_id, false],
        ['P380 Harbor', grouped[2].product_id, false],
        ['T415 Moss', grouped[1].product_id, true],
      ]);
    });

    test.each([
      ['code + name', ['BRANDA TINT PRO 517 HARBOR MIST', 'BRANDA TINT PRO 520 DRY STONE', 'BRANDA TINT PRO 533 SEA GLASS']],
      ['two-letter code', ['BRANDC LUMA RX318 PEWTER', 'BRANDC LUMA RA101 DAWN']],
      ['code only', ['BRANDB LACQ NO.884', 'BRANDB LACQ NO.885', '[RETIRED] BRANDB LACQ NO.886']],
      ['separator + hash code', ['BRANDD ATELIER - PEAR SPRITZ #271', 'BRANDD ATELIER - FIG TONIC #272']],
    ])('groups the %s format into one line', (_label, titles) => {
      const { listings: grouped } = group(titles.map((title) => buildListing(title)));
      expect(new Set(lineIds(grouped)).size).toBe(1);
      grouped.forEach((listing) => expect(decisionOf(listing)).toMatchObject({ status: 'approved', product_line_id: listing.product_line_id }));
    });

    test('a brand-only line groups only with a known category AND product type on every member', () => {
      const scoped = { brand: 'BRANDC', productType: 'nail-polish', categoryPath: 'beauty/nails/nail polish' };
      const ok = group([buildListing('BRANDC 731 PAPAYA', scoped), buildListing('BRANDC 732 GUAVA', scoped)]);
      expect(new Set(lineIds(ok.listings)).size).toBe(1);

      // The measured failure: different kinds of product, no category, keyed on the brand alone.
      const unscoped = group(
        ['BRANDC 517 DUNE COPPER', 'BRANDC 110 IVORY', 'BRANDC 05 BLACK'].map((title) =>
          buildListing(title, { brand: 'BRANDC', productType: null, extraProduct: { product_type: 'makeup' } }),
        ),
      );
      unscoped.listings.forEach((listing) => expect(refusalOf(listing)).toBe('brand_only_line_unscoped'));
      expect(new Set(lineIds(unscoped.listings)).size).toBe(3);

      // A type but no category path is not enough either.
      const typeOnly = group([buildListing('BRANDC 731 PAPAYA', { brand: 'BRANDC' }), buildListing('BRANDC 732 GUAVA', { brand: 'BRANDC' })]);
      typeOnly.listings.forEach((listing) => expect(refusalOf(listing)).toBe('brand_only_line_unscoped'));
    });

    test('line words in any script are kept: CJK and Cyrillic product names are separate lines', () => {
      const nails = { productType: null, categoryPath: 'beauty/nails' };
      const cjk = group([
        buildListing('ACME 甲油胶 01', { brand: 'ACME', ...nails }),
        buildListing('ACME 卸甲水 02', { brand: 'ACME', ...nails }),
        buildListing('ACME 甲油胶 03', { brand: 'ACME', ...nails }),
      ]);
      const [polishA, remover, polishB] = cjk.listings;
      expect(polishA.product_line_id).toBe(polishB.product_line_id);
      expect(remover.product_line_id).not.toBe(polishA.product_line_id);
      expect(refusalOf(remover)).toBe('line_too_small');

      const makeup = { productType: null, categoryPath: 'beauty/makeup' };
      const cyrillic = group([
        buildListing('ACME Помада 01 Red', { brand: 'ACME', ...makeup }),
        buildListing('ACME Тональный крем 02 Ivory', { brand: 'ACME', ...makeup }),
      ]);
      expect(cyrillic.listings[0].shade_line_candidate.line_norm).toBe('acme помада');
      expect(cyrillic.listings[1].shade_line_candidate.line_norm).toBe('acme тональный крем');
      cyrillic.listings.forEach((listing) => expect(refusalOf(listing)).toBe('line_too_small'));
    });

    test('a makeup line whose v1 key keeps the shade name is lined up by v2', () => {
      const titles = ['BRANDE Silkfold Lipstick 346 Ember Glow', 'BRANDE Silkfold Lipstick 347 Brick Lane'];
      const built = titles.map((title) => buildListing(title, { currency: 'USD', price: 18, productType: null }));
      expect(built[0].source_meta.variant_family).toBeDefined();
      expect(built[0].product_line_id).not.toBe(built[1].product_line_id);
      const { listings: grouped } = group(built);
      expect(grouped[0].product_line_id).toBe(grouped[1].product_line_id);
    });

    test('a line rule v1 already keys correctly is left to v1', () => {
      const built = ['BRANDF Volume Mascara - Ink Plum', 'BRANDF Volume Mascara - Jet Night'].map((title) =>
        buildListing(title, { currency: 'USD', price: 26, productType: null }),
      );
      expect(built[0].shade_line_candidate.superseded_by).toBe('variant_family_v1');
      const { listings: grouped, stats } = group(built);
      expect(lineIds(grouped)).toEqual(lineIds(built));
      expect(grouped[0].product_line_id).toBe(grouped[1].product_line_id);
      grouped.forEach((listing) => expect(decisionOf(listing)).toBeNull());
      expect(stats.candidates).toBe(0);
    });

    test('a v2 shade in a store line whose siblings live in a v1 line ADOPTS that line, it does not mint a second', () => {
      const opts = { currency: 'USD', price: 22, productType: null };
      const built = [
        buildListing('BRANDF Satin Lipstick - Red', opts),
        buildListing('BRANDF Satin Lipstick - Dusty Rose Pink', opts),
        buildListing('BRANDF Satin Lipstick - 517 Dune', opts),
        buildListing('BRANDF Satin Lipstick - Nude', opts),
      ];
      const v1Line = built[0].product_line_id;
      expect(built[2].product_line_id).not.toBe(v1Line);
      const { listings: grouped, stats } = group(built);
      expect(new Set(lineIds(grouped))).toEqual(new Set([v1Line]));
      expect(decisionOf(grouped[2])).toMatchObject({ status: 'approved', product_line_id: v1Line, adopted_v1_line: true });
      expect(grouped[2].review_family_id).toBe(built[0].review_family_id);
      expect(stats.adopted).toBe(1);

      // Mixed code formats in one store line: the code-only v1 siblings and the code+name v2 shades.
      const mixed = group(
        ['BRANDF Lipstick 471', 'BRANDF Lipstick 472', 'BRANDF Lipstick 473 Blue', 'BRANDF Lipstick 474 Pink'].map((title) =>
          buildListing(title, opts),
        ),
      );
      expect(new Set(lineIds(mixed.listings)).size).toBe(1);
    });

    test('a v1 line held by another seller (stored) or another store (in the batch) is not adopted: the store line is minted', () => {
      const opts = { currency: 'USD', price: 22, productType: null };
      const titles = ['BRANDF Satin Lipstick - Red', 'BRANDF Satin Lipstick - Nude', 'BRANDF Satin Lipstick - 517 Dune', 'BRANDF Satin Lipstick - 518 Clay'];
      const built = titles.map((title) => buildListing(title, opts));
      const v1Line = built[0].product_line_id;

      const storedElsewhere = group(built, { lineStores: new Map([[v1Line, ['merch_obs_reseller@reseller.example']]]) });
      const [red, nude, dune, clay] = storedElsewhere.listings;
      expect(red.product_line_id).toBe(v1Line);
      expect(nude.product_line_id).toBe(v1Line);
      expect(dune.product_line_id).not.toBe(v1Line);
      expect(dune.product_line_id).toBe(clay.product_line_id);
      expect(decisionOf(dune)).toMatchObject({ status: 'approved', v1_line_not_store_scoped: v1Line });
      expect(storedElsewhere.stats.adoption_not_store_scoped).toBe(1);

      // Another store's page of the same v1 line inside the batch blocks the adoption too.
      const otherStorePage = buildListing('BRANDF Satin Lipstick - Coral', { ...opts, domain: 'shop-two.example', merchantId: 'merch_obs_shoptwo' });
      expect(otherStorePage.product_line_id).toBe(v1Line);
      const inBatch = group([...built, otherStorePage]);
      expect(inBatch.listings[2].product_line_id).not.toBe(v1Line);

      // Unknown stores (the store read failed) allow no adoption either.
      const unknown = group(built, { lineStores: null });
      expect(unknown.listings[2].product_line_id).not.toBe(v1Line);

      // Same seller of record, another domain: another store.
      const otherDomain = group(built, { lineStores: new Map([[v1Line, ['merch_obs_shopone@other-domain.example']]]) });
      expect(otherDomain.listings[2].product_line_id).not.toBe(v1Line);
      // Same store, written with www.: still this store, so the line is adopted.
      const sameStore = group(built, { lineStores: new Map([[v1Line, ['merch_obs_shopone@www.shop-one.example']]]) });
      expect(sameStore.listings[2].product_line_id).toBe(v1Line);
    });

    test('the backfill reads the stores holding a v1 line before adopting it', async () => {
      const { _internals } = require('../../src/services/pdpIdentityGraph');
      const opts = { currency: 'USD', price: 22, productType: null };
      const built = ['BRANDF Satin Lipstick - Red', 'BRANDF Satin Lipstick - Nude', 'BRANDF Satin Lipstick - 517 Dune'].map((title) =>
        buildListing(title, opts),
      );
      const v1Line = built[0].product_line_id;
      const run = (storeRows) =>
        _internals.groupShadeLinesForBatch(built, {
          queryFn: async (sql, params) => {
            if (/SELECT DISTINCT product_line_id, merchant_id, official_domain/.test(sql)) {
              expect(params[0]).toEqual([v1Line]);
              return { rows: storeRows };
            }
            return { rows: [] };
          },
        });
      const foreign = await run([{ product_line_id: v1Line, merchant_id: 'merch_obs_reseller', official_domain: 'reseller.example' }]);
      expect(foreign.listings[2].product_line_id).not.toBe(v1Line);
      const own = await run([{ product_line_id: v1Line, merchant_id: 'merch_obs_shopone', official_domain: 'shop-one.example' }]);
      expect(own.listings[2].product_line_id).toBe(v1Line);
    });

    test('shades joining an adopted v1 line must agree with that line\'s known members on price, currency and type', () => {
      const opts = { currency: 'USD', price: 22, productType: 'lipstick' };
      const withSiblings = (extra) =>
        group([
          buildListing('BRANDF Satin Lipstick - Red', opts),
          buildListing('BRANDF Satin Lipstick - Nude', opts),
          buildListing('BRANDF Satin Lipstick - Rose', opts),
          buildListing('BRANDF Satin Lipstick - 517 Dune', { ...opts, ...extra }),
          buildListing('BRANDF Satin Lipstick - 518 Clay', { ...opts, ...extra }),
        ]).listings;
      // On their own the two new shades agree with each other; against the line they join they do not.
      const fine = withSiblings({});
      expect(fine[3].product_line_id).toBe(fine[0].product_line_id);
      withSiblings({ price: 70 }).slice(3).forEach((listing) => expect(refusalOf(listing)).toBe('price_outlier'));
      withSiblings({ currency: 'SGD' }).slice(3).forEach((listing) => expect(refusalOf(listing)).toBe('currency_mismatch'));
      withSiblings({ productType: 'lip liner' }).slice(3).forEach((listing) => expect(refusalOf(listing)).toBe('category_mismatch'));
    });

    test('a v2 page for a shade its v1 sibling already holds is a duplicate, the sibling keeps its place', () => {
      const opts = { currency: 'USD', price: 22, productType: null };
      const { listings: grouped } = group([
        buildListing('BRANDF Lipstick 471', opts),
        buildListing('BRANDF Lipstick 472', opts),
        buildListing('BRANDF Lipstick 472 Plum', opts),
      ]);
      expect(refusalOf(grouped[2])).toBe('duplicate_shade_value');
      expect(grouped[0].product_line_id).toBe(grouped[1].product_line_id);
    });
  });

  describe('context', () => {
    test('the catalog type passed through sourceMeta supplies the context a nail title lacks', () => {
      const titles = ['BRANDA AURA K2207 SAFFRON', 'BRANDA AURA T415 MOSS'];
      const withType = group(titles.map((title) => buildListing(title)));
      expect(new Set(lineIds(withType.listings)).size).toBe(1);

      const withoutType = titles.map((title) => buildListing(title, { productType: null }));
      expect(withoutType[0].shade_line_candidate.refused).toBe('no_shade_context');
      const { listings: grouped, stats } = group(withoutType);
      expect(new Set(lineIds(grouped)).size).toBe(2);
      expect(stats.refused.no_shade_context).toBe(2);
      // Not a candidate at all: the listing is left exactly as built.
      expect(grouped).toEqual(withoutType);
    });

    test('nail vocabulary is context when there is no category; gel beside a body word is not', () => {
      const nail = group(['BRANDB GEL NO.884', 'BRANDB GEL NO.885'].map((title) => buildListing(title, { productType: null })));
      expect(new Set(lineIds(nail.listings)).size).toBe(1);
      const showerGel = buildListing('BRANDG SHOWER GEL 500 LAVENDER', { productType: null });
      expect(showerGel.shade_line_candidate.refused).toBe('no_shade_context');
    });

    test('a non-shade catalog category refuses even a title with nail words', () => {
      const listing = buildListing('BRANDH NAIL SERUM 01 CALM', { productType: null, categoryPath: 'beauty/skincare/treatment' });
      expect(listing.shade_line_candidate.refused).toBe('no_shade_context');
    });

    test('the price is read only after the per-listing guards pass', () => {
      const { extractShadeLineCandidate } = require('../../src/services/shadeLineRule');
      const price = jest.fn(() => ({ amount: 10, currency: 'USD' }));
      const product = (title) => ({ title, brand: 'BRANDA' });
      extractShadeLineCandidate({ product: product('BRANDA Hand Cream 01 Rose'), merchantId: 'm', brandNorm: 'branda', price });
      extractShadeLineCandidate({ product: product('BRANDA Gel Polish 02 Base Coat'), merchantId: 'm', brandNorm: 'branda', price });
      expect(price).not.toHaveBeenCalled();
      const ok = extractShadeLineCandidate({ product: product('BRANDA Gel Polish 03 Coral'), merchantId: 'm', brandNorm: 'branda', price });
      expect(price).toHaveBeenCalledTimes(1);
      expect(ok.price).toEqual({ amount: 10, currency: 'USD' });
    });
  });

  describe('store scoping', () => {
    test('the same line text at two stores, or two sellers of one store domain, is two lines', () => {
      const titles = ['BRANDA AURA K2207 SAFFRON', 'BRANDA AURA T415 MOSS'];
      const shopOne = titles.map((title) => buildListing(title));
      const shopTwo = titles.map((title) => buildListing(title, { domain: 'shop-two.example', merchantId: 'merch_obs_shoptwo' }));
      const otherSeller = titles.map((title) => buildListing(title, { merchantId: 'merch_obs_reseller' }));
      const sharedSellerOtherDomain = titles.map((title) => buildListing(title, { domain: 'shop-three.example' }));
      const ids = lineIds(group([...shopOne, ...shopTwo, ...otherSeller, ...sharedSellerOtherDomain]).listings);
      expect(ids[0]).toBe(ids[1]);
      expect(ids[2]).toBe(ids[3]);
      expect(ids[4]).toBe(ids[5]);
      expect(ids[6]).toBe(ids[7]);
      expect(new Set([ids[0], ids[2], ids[4], ids[6]]).size).toBe(4);
    });
  });

  describe('refusals', () => {
    test('brand_mismatch: a listing whose brand differs from the line is refused', () => {
      const listings = [
        buildListing('BRANDA AURA K2207 SAFFRON'),
        buildListing('BRANDA AURA T415 MOSS'),
        buildListing('BRANDA AURA P380 HARBOR'),
        buildListing('BRANDA AURA K2290 COPPER', { brand: 'BRANDZ' }),
      ];
      const { listings: grouped } = group(listings);
      expect(refusalOf(grouped[3])).toBe('brand_mismatch');
      expect(grouped[3].product_line_id).toBe(listings[3].product_line_id);
      expect(new Set(lineIds(grouped.slice(0, 3))).size).toBe(1);
    });

    test('category_mismatch: a gift box in the line\'s words, or a branching category path, is refused', () => {
      const { listings: byType } = group([
        buildListing('BRANDB GEL NO.884'),
        buildListing('BRANDB GEL NO.885'),
        buildListing('BRANDB GEL NO.890', { productType: 'gift box' }),
      ]);
      expect(refusalOf(byType[2])).toBe('category_mismatch');
      expect(byType[0].product_line_id).toBe(byType[1].product_line_id);

      // Paths are compared by prefix: a deeper path of the same branch agrees, a sibling branch does not.
      const { listings: byPath } = group([
        buildListing('BRANDB GEL NO.884', { categoryPath: 'beauty/nails/gel polish' }),
        buildListing('BRANDB GEL NO.885', { categoryPath: 'beauty/nails/gel polish' }),
        buildListing('BRANDB GEL NO.886', { categoryPath: 'beauty/nails' }),
        buildListing('BRANDB GEL NO.887', { categoryPath: 'beauty/nails/remover' }),
      ]);
      expect(refusalOf(byPath[2])).toBeNull();
      expect(byPath[2].product_line_id).toBe(byPath[0].product_line_id);
      expect(refusalOf(byPath[3])).toBe('category_mismatch');
    });

    test('currency_mismatch: a member priced in another currency is refused', () => {
      const { listings: grouped } = group([
        buildListing('BRANDB GEL NO.884'),
        buildListing('BRANDB GEL NO.885'),
        buildListing('BRANDB GEL NO.889', { currency: 'USD', price: 20 }),
      ]);
      expect(refusalOf(grouped[2])).toBe('currency_mismatch');
    });

    test('price_outlier: above 1.5x the line median is refused; 1.35x stays in the line', () => {
      const { listings: grouped } = group([
        buildListing('BRANDB GEL NO.884', { price: 30 }),
        buildListing('BRANDB GEL NO.885', { price: 30 }),
        buildListing('BRANDB GEL NO.886', { price: 30 }),
        buildListing('BRANDB GEL NO.887', { price: 40.5 }),
        buildListing('BRANDB GEL NO.888', { price: 200 }),
      ]);
      expect(refusalOf(grouped[3])).toBeNull();
      expect(grouped[3].product_line_id).toBe(grouped[0].product_line_id);
      expect(refusalOf(grouped[4])).toBe('price_outlier');
      expect(grouped[4].product_line_id).not.toBe(grouped[0].product_line_id);
    });

    test('duplicate_shade_value: two pages of one shade are both refused, neither chosen', () => {
      const { listings: grouped } = group([
        buildListing('BRANDA AURA K2207 SAFFRON', { productId: 'saffron-a' }),
        buildListing('[RETIRED] BRANDA AURA K2207 SAFFRON', { productId: 'saffron-b' }),
        buildListing('BRANDA AURA T415 MOSS'),
        buildListing('BRANDA AURA P380 HARBOR'),
      ]);
      expect(refusalOf(grouped[0])).toBe('duplicate_shade_value');
      expect(refusalOf(grouped[1])).toBe('duplicate_shade_value');
      expect(grouped[2].product_line_id).toBe(grouped[3].product_line_id);
    });

    test('line_too_small: one member alone is refused, with the line id it would have had', () => {
      const listing = buildListing('BRANDA AURA K2207 SAFFRON');
      const { listings: grouped } = group([listing]);
      expect(refusalOf(grouped[0])).toBe('line_too_small');
      expect(grouped[0].product_line_id).toBe(listing.product_line_id);
      expect(decisionOf(grouped[0]).proposed_product_line_id).toMatch(/^pl_[0-9a-f]{24}$/);
    });

    test('line_too_small is lifted when the line already has stored members outside the batch', async () => {
      const { _internals } = require('../../src/services/pdpIdentityGraph');
      const listing = buildListing('BRANDA AURA K2207 SAFFRON');
      const proposed = decisionOf(group([listing]).listings[0]).proposed_product_line_id;
      const queryFn = jest.fn(async (sql, params) => {
        if (/SELECT source_listing_ref, product_line_id, review_family_id/.test(sql)) return { rows: [] };
        expect(sql).toMatch(/count\(\*\)::int AS member_count/);
        expect(params[0]).toEqual([proposed]);
        expect(params[1]).toEqual([listing.source_listing_ref]);
        return { rows: [{ product_line_id: proposed, member_count: 7 }] };
      });
      const result = await _internals.groupShadeLinesForBatch([listing], { queryFn });
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(result.listings[0].product_line_id).toBe(proposed);
      expect(decisionOf(result.listings[0])).toMatchObject({ status: 'approved', product_line_id: proposed });
    });

    test.each([
      ['set', 'BRANDB GEL NO.892 GIFT SET'],
      ['size', 'BRANDE Velour Foundation 01 Porcelain 30 ml'],
      ['sun_factor', 'BRANDE Skin Tint 01 Ivory SPF 30'],
      ['mini', 'BRANDF Volume Lash - Mini'],
      ['mini', 'BRANDA AURA K2207 SAFFRON REFILL'],
      ['finish_only', 'BRANDF Lip Lacquer - Matte'],
      ['product_noun', 'BRANDA Lip Pencil 03 Brush'],
      // the nail system around the colours (the measured false groupings, rewritten)
      ['nail_system', 'BRANDA 500 Base Gel'],
      ['nail_system', 'BRANDA 388 Builder Gel Clear'],
      ['nail_system', 'BRANDA Gel G00 No Wipe Top'],
      ['nail_system', 'BRANDA Gel G99 Base'],
      ['nail_system', 'BRANDA Gel Polish - Matte Top'],
      ['nail_system', 'BRANDA Gel Polish - Rubber Base'],
      ['nail_system', 'BRANDA Nail 100 Acetone Free'],
      ['nail_system', 'BRANDA Nail 03 Glass File'],
      ['nail_system', 'BRANDA Nail 12 Cuticle Oil'],
      ['nail_system', 'BRANDA Gel 07 Bond'],
      // a system phrase inside a longer name
      ['nail_system', 'BRANDA Gel 21 Pink Top Coat'],
      ['nail_system', 'BRANDA Nail 22 Acetone Free Lavender'],
    ])('non_shade_suffix:%s refuses %s', (kind, title) => {
      const listing = buildListing(title, { productType: 'makeup' });
      expect(listing.shade_line_candidate.refused).toBe(`non_shade_suffix:${kind}`);
      const { listings: grouped } = group([listing, buildListing('BRANDB GEL NO.884')]);
      expect(refusalOf(grouped[0])).toBe(`non_shade_suffix:${kind}`);
    });

    test('one size shared by the whole line is allowed; a member with NO size is compatible; only a DIFFERENT size is size_mismatch', () => {
      const sized = (title, value) =>
        buildListing(title, { extraProduct: { variants: [{ variant_id: `v-${title}`, option_name: 'Size', option_value: value }] } });
      const uniform = [sized('BRANDA AURA K2207 SAFFRON', '15 ml'), sized('BRANDA AURA T415 MOSS', '15 ml'), sized('BRANDA AURA P380 HARBOR', '15ml')];
      expect(uniform[0].variant_axes.volume || uniform[0].variant_axes.size).toBeTruthy();
      const ok = group(uniform);
      expect(new Set(lineIds(ok.listings)).size).toBe(1);
      ok.listings.forEach((listing) => expect(decisionOf(listing).status).toBe('approved'));

      // The census case: separator-format members that state no size beside sized siblings.
      const withUnsized = group([
        sized('BRANDA AURA K2207 SAFFRON', '15 ml'),
        sized('BRANDA AURA T415 MOSS', '15 ml'),
        buildListing('BRANDA AURA - PEAR SPRITZ #271'),
        buildListing('BRANDA AURA - FIG TONIC #272'),
      ]);
      expect(new Set(lineIds(withUnsized.listings)).size).toBe(1);
      withUnsized.listings.forEach((listing) => expect(decisionOf(listing).status).toBe('approved'));

      const mixed = group([
        sized('BRANDA AURA K2207 SAFFRON', '15 ml'),
        sized('BRANDA AURA T415 MOSS', '15 ml'),
        sized('BRANDA AURA P380 HARBOR', '30 ml'),
        buildListing('BRANDA AURA R220 SLATE'),
      ]);
      expect(refusalOf(mixed.listings[2])).toBe('size_mismatch');
      expect(refusalOf(mixed.listings[3])).toBeNull();
      expect(mixed.listings[2].variant_axes).toEqual(sized('BRANDA AURA P380 HARBOR', '30 ml').variant_axes);
      expect(new Set(lineIds([mixed.listings[0], mixed.listings[1], mixed.listings[3]])).size).toBe(1);
    });

    test('a letter + ONE digit is a code only as the last token; NO. codes may carry letters', () => {
      const { parseShadeLineTitle } = require('../../src/services/shadeLineRule');
      expect(parseShadeLineTitle('BRANDB LACQ W7')).toMatchObject({ format: 'code_only', line: 'BRANDB LACQ', code: 'w7' });
      expect(parseShadeLineTitle('BRANDB LACQ GLOW NO.K14')).toMatchObject({ format: 'code_only', line: 'BRANDB LACQ GLOW', code: 'k14' });
      expect(parseShadeLineTitle('BRANDB LACQ GLOW NO.K6')).toMatchObject({ code: 'k6' });
      expect(parseShadeLineTitle('BRANDB LACQ GLOW NO K6')).toMatchObject({ code: 'k6' });
      // Not as a mid-title token: "Vitamin B5 Serum" has no shade code.
      expect(parseShadeLineTitle('BRANDB Vitamin B5 Serum')).toBeNull();
      const { listings: grouped } = group([
        buildListing('BRANDB LACQ W7'),
        buildListing('BRANDB LACQ W8'),
        buildListing('BRANDB LACQ GLOW NO.K14'),
        buildListing('BRANDB LACQ GLOW NO.K6'),
      ]);
      expect(grouped[0].product_line_id).toBe(grouped[1].product_line_id);
      expect(grouped[2].product_line_id).toBe(grouped[3].product_line_id);
      expect(grouped[0].product_line_id).not.toBe(grouped[2].product_line_id);
      // Guards still apply to the new formats.
      const sets = group([buildListing('BRANDB LACQ GLOW NO.K14'), buildListing('BRANDB LACQ GLOW NO.K15 GIFT SET')]);
      expect(refusalOf(sets.listings[1])).toBe('non_shade_suffix:set');
    });

    test('a nail-system word inside a colour name is still a shade; codes like 05G / 06L are codes', () => {
      const { parseShadeLineTitle } = require('../../src/services/shadeLineRule');
      const { listings: grouped } = group([
        buildListing('BRANDA AURA K2207 ROSE OIL'),
        buildListing('BRANDA AURA T415 BASE CAMP BEIGE'),
        buildListing('BRANDA AURA P380 DESERT TIP'),
      ]);
      grouped.forEach((listing) => expect(decisionOf(listing).status).toBe('approved'));
      expect(new Set(lineIds(grouped)).size).toBe(1);
      expect(parseShadeLineTitle('BRANDB LACQ 05G')).toMatchObject({ code: '05g' });
      expect(parseShadeLineTitle('BRANDB LACQ 06L Ivory')).toMatchObject({ code: '06l', name: 'Ivory' });
    });

    test('identity_not_approved and reviewed merges are never re-lined', () => {
      const pending = { ...buildListing('BRANDA AURA K2207 SAFFRON'), identity_status: 'review_required' };
      const reviewed = { ...buildListing('BRANDA AURA T415 MOSS'), matched_by_rule: 'reviewed_multi_offer_merge' };
      const { listings: grouped } = group([pending, reviewed, buildListing('BRANDA AURA P380 HARBOR')]);
      expect(refusalOf(grouped[0])).toBe('identity_not_approved');
      expect(refusalOf(grouped[1])).toBe('reviewed_merge_kept');
      expect(grouped[1].product_line_id).toBe(reviewed.product_line_id);
      expect(refusalOf(grouped[2])).toBe('line_too_small');
    });

    test('missing_brand refuses a listing with no brand', () => {
      expect(buildListing('BRANDA AURA K2207 SAFFRON', { brand: '' }).shade_line_candidate.refused).toBe('missing_brand');
    });
  });

  // The independent review's harness cases (invented "ACME" titles), as groupings: entries with the
  // same letter must share a line, different letters must not.
  describe('review harness cases', () => {
    const run = (specs) => {
      const built = specs.map(([title, opts = {}], idx) =>
        buildListing(title, { brand: 'ACME', currency: 'USD', price: 10, productType: null, productId: `h${idx}`, domain: 'acme-store.test', ...opts }),
      );
      return group(built).listings;
    };
    const pattern = (listings) => {
      const seen = new Map();
      return listings.map((listing) => {
        if (!seen.has(listing.product_line_id)) seen.set(listing.product_line_id, String.fromCharCode(97 + seen.size));
        return seen.get(listing.product_line_id);
      }).join('');
    };

    test.each([
      ['CJK product words keep two lines apart', [['ACME 唇膏 01 红色', { extraProduct: { product_type: 'makeup' } }], ['ACME 粉底液 02 象牙', { extraProduct: { product_type: 'makeup' } }]], 'ab'],
      ['brand-only nail mix', [['ACME K050 Rose Gel Polish'], ['ACME 500 Base Gel'], ['ACME 800 Rubber Base'], ['ACME 12 Cuticle Oil'], ['ACME 388 Builder Gel Clear']], 'abcde'],
      ['brand-only makeup mix, unknown category', [['ACME 517 Dune Copper', { extraProduct: { product_type: 'makeup' } }], ['ACME 110 Ivory', { extraProduct: { product_type: 'makeup' } }], ['ACME 05 Black', { extraProduct: { product_type: 'makeup' } }]], 'abc'],
      ['years are not codes', [['Acme Nail Polish Holiday 2024 Ruby'], ['Acme Nail Polish Holiday 2025 Ruby']], 'ab'],
      ['v1 split: the v2 shade adopts the v1 line', [['Acme Matte Lipstick - Red'], ['Acme Matte Lipstick - Dusty Rose Pink'], ['Acme Matte Lipstick - 517 Dune'], ['Acme Matte Lipstick - Nude']], 'aaaa'],
      ['v1 trailing code: adopted', [['Acme Lipstick 471'], ['Acme Lipstick 472'], ['Acme Lipstick 474 Dune']], 'aaa'],
      ['nail polish vs remover vs file', [['Acme Nail 01 Red'], ['Acme Nail 02 Blue'], ['Acme Nail 03 Glass File'], ['Acme Nail 100 Acetone Free']], 'aabc'],
      ['base/top in the name', [['Acme Gel G01 Red'], ['Acme Gel G02 Pink'], ['Acme Gel G00 No Wipe Top'], ['Acme Gel G99 Base']], 'aabc'],
      ['separator nail system', [['Acme Gel Polish - Matte Top'], ['Acme Gel Polish - Rubber Base'], ['Acme Gel Polish - Rose'], ['Acme Gel Polish - Nude']], 'abcc'],
      ['CJK nail lines with a category', [['ACME 甲油胶 01', { categoryPath: 'beauty/nails' }], ['ACME 卸甲水 02', { categoryPath: 'beauty/nails' }], ['ACME 甲油胶 03', { categoryPath: 'beauty/nails' }]], 'aba'],
      ['Cyrillic product words with a category', [['ACME Помада 01 Red', { categoryPath: 'beauty/makeup' }], ['ACME Тональный крем 02 Ivory', { categoryPath: 'beauty/makeup' }]], 'ab'],
      ['currency split', [['Acme Gel Polish G01 Red'], ['Acme Gel Polish G02 Blue'], ['Acme Gel Polish G03 Pink', { currency: 'SGD', price: 14 }], ['Acme Gel Polish G04 Teal', { currency: 'SGD', price: 14 }]], 'abcc'],
    ])('%s', (_label, specs, expected) => {
      expect(pattern(run(specs))).toBe(expected);
    });

    test('glued sizes are not v2 codes (v1, unchanged here, still reads "15g" as a code)', () => {
      const listings = run([['Acme Loose Powder 15g Translucent'], ['Acme Loose Powder 30g Translucent', { price: 16 }]]);
      listings.forEach((listing) => {
        expect(listing.shade_line_candidate).toBeUndefined();
        expect(decisionOf(listing)).toBeNull();
      });
    });
  });

  describe('existing rows, versioning and markers', () => {
    test('fails closed: when the stored lines cannot be read, the batch gets no decision at all', async () => {
      const { _internals } = require('../../src/services/pdpIdentityGraph');
      const built = [buildListing('BRANDA AURA K2207 SAFFRON'), buildListing('BRANDA AURA T415 MOSS')];
      const queryFn = jest.fn(async () => {
        throw new Error('connection reset');
      });
      const result = await _internals.groupShadeLinesForBatch(built, { queryFn });
      expect(result.stats).toEqual({ skipped: 'stored_lines_unavailable' });
      expect(result.listings).toEqual(built);
      result.listings.forEach((listing) => {
        expect(decisionOf(listing)).toBeNull();
        expect(listing.variant_axes.shade).toBeUndefined();
      });
    });

    test('fails closed through the backfill: rows are written exactly as built, with no shade decision', async () => {
      const { backfillPdpIdentityGraph } = require('../../src/services/pdpIdentityGraph');
      const { seedRow } = require('../fixtures/shade_line_backfill_capture');
      const seedRows = [seedRow({ code: 'aura-k2207', title: 'BRANDA AURA K2207 SAFFRON' }), seedRow({ code: 'aura-t415', title: 'BRANDA AURA T415 MOSS' })];
      const queryFn = jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM external_product_seeds e')) return { rows: seedRows };
        if (text.includes('SELECT source_listing_ref, product_line_id, review_family_id')) throw new Error('statement timeout');
        return { rows: [] };
      });
      const written = [];
      const withClientFn = async (fn) =>
        fn({
          query: async (sql, params) => {
            if (String(sql || '').includes('INSERT INTO pdp_identity_listing')) {
              written.push({ product_line_id: params[7], variant_axes: JSON.parse(params[15]), soft_identity: JSON.parse(params[14]) });
            }
            return { rows: [] };
          },
        });
      const result = await backfillPdpIdentityGraph({ queryFn, withClientFn });
      expect(result.shade_lines).toEqual({ skipped: 'stored_lines_unavailable' });
      expect(written).toHaveLength(2);
      expect(written[0].product_line_id).not.toBe(written[1].product_line_id);
      written.forEach((row) => {
        expect(row.soft_identity.shade_line).toBeUndefined();
        expect(row.variant_axes.shade).toBeUndefined();
      });
    });

    test('a stored member is never moved: its line, review family and axes stay; the rule only PROPOSES', () => {
      const built = [
        buildListing('BRANDA AURA K2207 SAFFRON'),
        buildListing('BRANDA AURA T415 MOSS'),
        buildListing('BRANDA AURA P380 HARBOR'),
      ];
      const storedLines = new Map([[built[0].source_listing_ref, { product_line_id: 'pl_minted_by_older_rule0', review_family_id: 'rf_older' }]]);
      const { listings: grouped, stats } = group(built, { storedLines });
      expect(grouped[0].product_line_id).toBe(built[0].product_line_id);
      expect(grouped[0].review_family_id).toBe(built[0].review_family_id);
      expect(grouped[0].variant_axes).toEqual(built[0].variant_axes);
      expect(decisionOf(grouped[0])).toMatchObject({
        status: 'proposed',
        proposed_product_line_id: grouped[1].product_line_id,
        proposed_review_family_id: grouped[1].review_family_id,
        stored_product_line_id: 'pl_minted_by_older_rule0',
      });
      expect(stats).toMatchObject({ approved: 2, proposed: 1 });
      // The new members still form the line (the proposed member counts toward its size).
      expect(grouped[1].product_line_id).toBe(grouped[2].product_line_id);
      expect(grouped[1].variant_axes.shade).toBe('t415 moss');
    });

    test('a stored member already in the line stays approved and keeps its shade axis', () => {
      const built = [buildListing('BRANDA AURA K2207 SAFFRON'), buildListing('BRANDA AURA T415 MOSS')];
      const lineId = group(built).listings[0].product_line_id;
      const storedLines = new Map(built.map((listing) => [listing.source_listing_ref, { product_line_id: lineId }]));
      const { listings: grouped } = group(built, { storedLines });
      grouped.forEach((listing) => {
        expect(decisionOf(listing)).toMatchObject({ status: 'approved', product_line_id: lineId });
        expect(listing.variant_axes.shade).toBeTruthy();
      });
    });

    test('the decision is versioned and lives in soft_identity; match_basis is untouched (search and discovery read it)', () => {
      const { readVerifiedShadeLineId, readProposedShadeLineId } = require('../../src/services/shadeLineRule');
      const built = [buildListing('BRANDA AURA K2207 SAFFRON'), buildListing('BRANDA AURA T415 MOSS'), buildListing('BRANDA AURA K2207 SAFFRON GIFT SET')];
      const { listings: grouped } = group(built);
      grouped.forEach((listing, idx) => {
        expect(listing.match_basis).toEqual(built[idx].match_basis);
        expect(JSON.stringify(listing.match_basis)).not.toMatch(/shade_line|line_rule|refused/);
      });
      const [first] = grouped;
      expect(decisionOf(first).rule_version).toBe('shade_line_v2');
      expect(readVerifiedShadeLineId(first)).toBe(first.product_line_id);
      // As the rows reader returns it: soft_identity->'shade_line' AS shade_line.
      expect(readVerifiedShadeLineId({ product_line_id: first.product_line_id, shade_line: JSON.stringify(decisionOf(first)) })).toBe(first.product_line_id);
      const stale = { ...first, product_line_id: 'pl_minted_by_older_rule0' };
      expect(readVerifiedShadeLineId(stale)).toBe('');
      expect(readProposedShadeLineId(stale)).toBe(first.product_line_id);
    });

    test('an operator force_product_line override still wins over the rule', () => {
      const { _internals } = require('../../src/services/pdpIdentityGraph');
      const { readVerifiedShadeLineId } = require('../../src/services/shadeLineRule');
      const { listings: grouped } = group([buildListing('BRANDA AURA K2207 SAFFRON'), buildListing('BRANDA AURA T415 MOSS')]);
      const overridden = _internals.applyIdentityOverrides(grouped[0], [
        {
          action_type: 'force_product_line',
          source_listing_ref: grouped[0].source_listing_ref,
          payload: { target_product_line_id: 'pl_operator_choice000000' },
        },
      ]);
      expect(overridden.product_line_id).toBe('pl_operator_choice000000');
      expect(readVerifiedShadeLineId(overridden)).toBe('');
    });

    test('backfill (flag on) writes the v2 line for new rows through the unchanged sticky upsert, with the catalog category', async () => {
      const { backfillPdpIdentityGraph } = require('../../src/services/pdpIdentityGraph');
      const { seedRow } = require('../fixtures/shade_line_backfill_capture');
      const seedRows = [
        seedRow({ code: 'aura-k2207', title: 'BRANDA AURA K2207 SAFFRON' }),
        seedRow({ code: 'aura-t415', title: 'BRANDA AURA T415 MOSS' }),
        seedRow({ code: 'aura-p380', title: 'BRANDA AURA P380 HARBOR' }),
      ];
      const queryFn = jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM external_product_seeds e')) {
          expect(text).toMatch(/cp\.category_path AS catalog_category_path/);
          expect(text).toMatch(/cp\.product_type AS catalog_product_type/);
          return { rows: seedRows };
        }
        return { rows: [] };
      });
      const written = [];
      let upsertSql = '';
      const withClientFn = async (fn) =>
        fn({
          query: async (sql, params) => {
            if (String(sql || '').includes('INSERT INTO pdp_identity_listing')) {
              upsertSql = String(sql);
              written.push({ product_line_id: params[7], match_basis: JSON.parse(params[12]), soft_identity: JSON.parse(params[14]) });
            }
            return { rows: [] };
          },
        });

      const result = await backfillPdpIdentityGraph({ queryFn, withClientFn });

      expect(written).toHaveLength(3);
      expect(new Set(written.map((row) => row.product_line_id)).size).toBe(1);
      written.forEach((row) => {
        expect(row.soft_identity.shade_line).toMatchObject({ status: 'approved', product_line_id: row.product_line_id });
        expect(JSON.stringify(row.match_basis)).not.toMatch(/shade_line/);
      });
      expect(result.shade_lines).toMatchObject({ approved: 3, lines: 1 });
      expect(upsertSql).toMatch(
        /product_line_id = CASE\s+WHEN EXCLUDED\.matched_by_rule = 'reviewed_multi_offer_merge'\s+THEN EXCLUDED\.product_line_id\s+WHEN NULLIF\(pdp_identity_listing\.product_line_id, ''\) IS NOT NULL\s+THEN pdp_identity_listing\.product_line_id/,
      );
      expect(upsertSql).not.toMatch(/shade_line/);
    });
  });
});
