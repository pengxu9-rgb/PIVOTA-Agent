jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
  closePool: jest.fn(async () => {}),
}));

const {
  _internals: {
    extractTirtirFaqHowToUse,
    extractSkin1004Fields,
    extractMedicubeFields,
    extractLaneigeFields,
    extractKylieFields,
    extractFentyFields,
    extractFentyFullIngredients,
    extractGuerlainFields,
    extractGuerlainIngredientModalUrl,
    parseGuerlainIngredientModalHtml,
    extractTomFordFields,
    extractRareFields,
    extractGenericOfficialShopifyFields,
    extractOfficialShopifyVariants,
    fetchStampedReviewSummary,
    fetchBazaarvoiceReviewSummary,
    fetchYotpoReviewSummary,
    parseOkendoReviewSummary,
    buildSeedDataPatch,
    buildServingPayloadPatch,
    hasUsefulReviewText,
    buildShopifyProductJsonUrl,
    findTirtirSheetIngredientRow,
    normalizeTirtirTitleKey,
    scoreTirtirSheetProductName,
    stringifyPostgresJsonb,
  },
} = require('../../scripts/backfill-external-seed-official-html-pdp-fields.cjs');

const inci =
  'Water, Glycerin, Butylene Glycol, Niacinamide, Sodium Hyaluronate, Panthenol, Tocopherol, ' +
  'Fragrance, Potassium Cetyl Phosphate, Citric Acid, Adenosine, Disodium EDTA';

describe('backfill-external-seed-official-html-pdp-fields TIRTIR sheet matching', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('normalizes TIRTIR title keys without brand or pack noise', () => {
    expect(normalizeTirtirTitleKey('TIRTIR GLOBAL Waterism Glow Tint Set')).toBe(
      'waterism glow tint',
    );
  });

  test('accepts a variant row that starts with the exact PDP product title', () => {
    expect(scoreTirtirSheetProductName('Waterism Glow Tint', 'Waterism Glow Tint 01 Mauve Rose')).toBeGreaterThanOrEqual(0.9);
  });

  test('rejects unrelated sheet products even when broad brand/category tokens overlap', () => {
    expect(scoreTirtirSheetProductName('Mask Fit Makeup Fixer', 'Mask Fit Red Cushion 21N Ivory')).toBeLessThan(0.8);
  });

  test('selects only product-name matched INCI rows from official TIRTIR sheets', () => {
    const rows = [
      ['No.', 'Milk Skin Toner', inci],
      ['No.', 'Mask Fit Red Cushion 21N Ivory', inci],
      ['No.', 'Waterism Glow Tint 01 Mauve Rose', `${inci}, Rosa Damascena Flower Water`],
    ];

    const match = findTirtirSheetIngredientRow(rows, 'Waterism Glow Tint');

    expect(match).toEqual(
      expect.objectContaining({
        productName: 'Waterism Glow Tint 01 Mauve Rose',
        ingredients: expect.stringContaining('Rosa Damascena Flower Water'),
      }),
    );
    expect(match.score).toBeGreaterThanOrEqual(0.8);
  });

  test('fails closed when the sheet has no row for the PDP product', () => {
    const rows = [
      ['No.', 'Milk Skin Toner', inci],
      ['No.', 'Mask Fit Red Cushion 21N Ivory', inci],
    ];

    expect(findTirtirSheetIngredientRow(rows, 'Mask Fit Makeup Fixer')).toBeNull();
  });

  test('extracts how-to copy from current numbered TIRTIR FAQ blocks', () => {
    const faq = `
      Q1. What is the difference between the two sides of the pad, and how should I use each?
      >
      The gauze-textured side provides gentle physical exfoliation - use this side first to sweep across the skin, removing dead skin cells and residual sebum. The soft, smooth side is for essence delivery - use this side after to pat the remaining formula onto areas of redness or sensitivity.
      >
      Q2. Are these pads suitable for sensitive skin?
      >
      Yes, they are formulated for sensitive-looking skin.
    `;

    expect(extractTirtirFaqHowToUse(faq)).toContain('use this side first to sweep');
  });

  test('extracts setting spray directions from numbered FAQ blocks without an A label', () => {
    const faq = `
      Q1. How do I use the Mask Fit Makeup Fixer?
      >
      Hold the bottle about 20-30 cm from your face and spray evenly after completing your makeup. Allow it to dry naturally for a flawless, long-lasting finish.
    `;

    expect(extractTirtirFaqHowToUse(faq)).toContain('spray evenly');
  });

  test('builds Shopify product JSON URLs without variant query strings', () => {
    expect(buildShopifyProductJsonUrl('https://medicube.us/products/deep-mask?variant=123')).toBe(
      'https://medicube.us/products/deep-mask.js',
    );
  });

  test('extracts displayable official Shopify pack variants', () => {
    const variants = extractOfficialShopifyVariants(
      {
        title: 'Deep Peptide Radiance Mask',
        options: [{ name: 'Option' }],
        images: ['https://medicube.us/mask.jpg'],
        variants: [
          { id: 1, title: '2 MASKS', option1: '2 MASKS', sku: 'KUSMEA1208', price: 600, available: true },
          { id: 2, title: '10+10 MASKS', option1: '10+10 MASKS', sku: 'KUSMEA1205', price: 6000, available: true },
          { id: 3, title: '20+20 MASKS', option1: '20+20 MASKS', sku: 'KUSMEA1206', price: 12000, available: true },
        ],
      },
      {
        productTitle: 'Deep Peptide Radiance Mask',
        currency: 'USD',
        productUrl: 'https://medicube.us/products/medicube-deep-peptide-radiance-mask-2ea',
      },
    );

    expect(variants).toHaveLength(3);
    expect(variants[0]).toEqual(
      expect.objectContaining({
        variant_id: '1',
        sku: 'KUSMEA1208',
        option_name: 'Option',
        option_value: '2 MASKS',
        price: 6,
        currency: 'USD',
        source_origin: 'official_shopify_product_json',
      }),
    );
    expect(variants[1].deep_link).toContain('variant=2');
  });

  test('keeps single Default Title Shopify variants hidden when no official spec exists', () => {
    expect(
      extractOfficialShopifyVariants(
        {
          title: 'SOS Serum',
          options: [{ name: 'Title' }],
          variants: [
            { id: 43394926969051, title: 'Default Title', option1: 'Default Title', sku: '01TTS0039', price: 2900, weight: 136 },
          ],
        },
        {
          productTitle: 'SOS Serum',
          currency: 'USD',
          productUrl: 'https://tirtir.global/products/sos-serum',
        },
      ),
    ).toEqual([]);
  });

  test('extracts a single official Shopify variant when the title contains a concrete size', () => {
    const variants = extractOfficialShopifyVariants(
      {
        title: 'Deep Vitamin C Capsule Serum 50ml',
        options: [{ name: 'Title' }],
        images: ['https://medicube.us/deep-vitamin-c.jpg'],
        variants: [
          { id: 1, title: 'Default Title', option1: 'Default Title', sku: 'KUSMEC001', price: 2500, available: true },
        ],
      },
      {
        productTitle: 'Deep Vitamin C Capsule Serum',
        currency: 'USD',
        productUrl: 'https://medicube.us/products/deep-vitamin-c-capsule-serum',
      },
    );

    expect(variants).toHaveLength(1);
    expect(variants[0]).toEqual(
      expect.objectContaining({
        variant_id: '1',
        option_name: 'Size',
        option_value: '50ml',
        source_origin: 'official_shopify_product_json_singleton_spec',
      }),
    );
  });

  test('extracts a single official Shopify variant from labeled product-size description', () => {
    const variants = extractOfficialShopifyVariants(
      {
        title: 'Red Succinic Acid Cleansing Booster Serum',
        description: '<p>Product size: 40 g / 1.41 oz</p><p>Apply after cleansing.</p>',
        options: [{ name: 'Title' }],
        variants: [
          { id: 1, title: 'Default Title', option1: 'Default Title', sku: 'KUSMEC002', price: 1900, available: true },
        ],
      },
      {
        productTitle: 'Red Succinic Acid Cleansing Booster Serum',
        currency: 'USD',
        productUrl: 'https://medicube.us/products/red-succinic-acid-cleansing-booster-serum',
      },
    );

    expect(variants).toHaveLength(1);
    expect(variants[0].option_value).toBe('40g');
  });

  test('does not extract official Shopify variants for a mismatched product title', () => {
    expect(
      extractOfficialShopifyVariants(
        {
          title: 'Unrelated Product',
          options: [{ name: 'Option' }],
          variants: [
            { id: 1, title: '2 MASKS', option1: '2 MASKS', price: 600, available: true },
            { id: 2, title: '10+10 MASKS', option1: '10+10 MASKS', price: 6000, available: true },
          ],
        },
        { productTitle: 'Deep Peptide Radiance Mask' },
      ),
    ).toEqual([]);
  });

  test('review-summary-only patch preserves existing content and only fills missing review previews', () => {
    const row = {
      seed_data: {
        pdp_ingredients_raw: 'Existing high quality INCI',
        review_summary: {
          rating: 4.8,
          review_count: 10,
        },
        snapshot: {
          pdp_ingredients_raw: 'Existing high quality INCI',
        },
      },
    };

    const { seedData, patchKeys } = buildSeedDataPatch(
      row,
      {
        pdp_ingredients_raw: 'Incoming official INCI that should not be applied in review-only mode',
        review_summary: {
          rating: 5,
          scale: 5,
          review_count: 12,
          source_origin: 'official_stamped_reviews_api',
          preview_items: [
            {
              review_id: 'r1',
              rating: 5,
              author_label: 'A reviewer',
              text_snippet: 'Lightweight and calming.',
            },
          ],
        },
      },
      { reviewSummaryOnly: true },
    );

    expect(patchKeys).toEqual(['review_summary']);
    expect(seedData.pdp_ingredients_raw).toBe('Existing high quality INCI');
    expect(seedData.snapshot.pdp_ingredients_raw).toBe('Existing high quality INCI');
    expect(seedData.review_summary.preview_items).toHaveLength(1);
  });

  test('review-summary-only patch does not replace existing review previews', () => {
    const row = {
      seed_data: {
        review_summary: {
          rating: 4.8,
          review_count: 10,
          preview_items: [{ review_id: 'existing', text_snippet: 'Keep this.' }],
        },
        snapshot: {},
      },
    };

    const { seedData, patchKeys } = buildSeedDataPatch(
      row,
      {
        review_summary: {
          rating: 5,
          scale: 5,
          review_count: 12,
          preview_items: [{ review_id: 'incoming', text_snippet: 'Do not overwrite.' }],
        },
      },
      { reviewSummaryOnly: true },
    );

    expect(patchKeys).toEqual([]);
    expect(seedData.review_summary.preview_items).toEqual([
      { review_id: 'existing', text_snippet: 'Keep this.' },
    ]);
  });

  test('review-summary-only patch can refresh previews from the same authoritative source', () => {
    const row = {
      seed_data: {
        review_summary: {
          source_origin: 'official_stamped_reviews_api',
          rating: 4.8,
          review_count: 10,
          preview_items: [{ review_id: 'existing', text_snippet: 'Replace this low-quality pick.' }],
        },
        snapshot: {},
      },
    };

    const { seedData, patchKeys } = buildSeedDataPatch(
      row,
      {
        review_summary: {
          source_origin: 'official_stamped_reviews_api',
          rating: 5,
          scale: 5,
          review_count: 12,
          preview_items: [{ review_id: 'incoming', text_snippet: 'This replacement has useful review detail.' }],
        },
      },
      { reviewSummaryOnly: true, refreshReviewPreview: true },
    );

    expect(patchKeys).toEqual(['review_summary']);
    expect(seedData.review_summary.preview_items).toEqual([
      { review_id: 'incoming', text_snippet: 'This replacement has useful review detail.' },
    ]);
  });

  test('filters non-English or generic review snippets from public preview candidates', () => {
    expect(
      hasUsefulReviewText(
        'Soy fel Genero M, me encanto el producto mi cara tiende a ser grasosa y brillar, esto me ayudo a reducirla, muy ligero, nada de sensación aceitosa, 100%recomendado.',
      ),
    ).toBe(false);
    expect(hasUsefulReviewText('Love this!')).toBe(false);
    expect(hasUsefulReviewText('I love the way it makes my skin feel.')).toBe(false);
    expect(
      hasUsefulReviewText(
        "Lancome Gift at MYER: Spend $99 on Lancome products in-store at MYER or online. Plus get 20% off Mother's Day Sets. Shop in-store or online now: https://bit.ly/example T&Cs Apply.",
      ),
    ).toBe(false);
    expect(
      hasUsefulReviewText(
        'So I thought this was the aura product I used. Wrong one but still loved the product, it was just a little too much coverage for me.',
      ),
    ).toBe(false);
    expect(
      hasUsefulReviewText(
        'This centella ampoule is really soothing on my acne-prone combination skin and absorbs quickly without feeling sticky.',
      ),
    ).toBe(true);
    expect(
      hasUsefulReviewText(
        'Brighten and depuff. Well worth the purchase and will be a repeat order for me.',
      ),
    ).toBe(true);
    expect(
      hasUsefulReviewText(
        'I like the idea of buying a sample first rather than buying and returning bottle after bottle.',
      ),
    ).toBe(true);
  });

  test('extracts TIRTIR Okendo review previews from official rendered HTML', () => {
    const html = `
      <div data-oke-widget data-oke-reviews-product-id="shopify-8732621471963">
        <div data-oke-container="" aria-label="Rated 4.9 out of 5 stars Based on 71 reviews">
          <script type="application/json" data-oke-metafield-data="">{"averageRating":"4.9","reviewCount":71}</script>
          <ul class="oke-w-reviews-list">
            <li class="oke-w-reviews-list-item">
              <div class="oke-w-review">
                <strong class="oke-w-reviewer-name"> Savka S. </strong>
                <div class="oke-w-reviewer-verified"> Verified Buyer </div>
                <span class="oke-a11yText">Rated 5 out of 5 stars</span>
                <div role="heading" aria-level="2" class="oke-reviewContent-title oke-title">Light enough for oily skin</div>
                <div class="oke-reviewContent-body oke-bodyText">
                  <p>This sunscreen is very light on my oily skin and layers well under makeup without feeling sticky.</p>
                  <p>It feels comfortable enough to reapply during the day and the packaging is easy to carry.</p>
                </div>
              </div>
            </li>
            <li class="oke-w-reviews-list-item">
              <div class="oke-w-review">
                <strong class="oke-w-reviewer-name"> Short R. </strong>
                <span class="oke-a11yText">Rated 5 out of 5 stars</span>
                <div role="heading" aria-level="2" class="oke-reviewContent-title oke-title">Good</div>
                <div class="oke-reviewContent-body oke-bodyText"><p>Good.</p></div>
              </div>
            </li>
          </ul>
        </div>
      </div>
    `;

    const summary = parseOkendoReviewSummary(html);

    expect(summary).toMatchObject({
      rating: 4.9,
      review_count: 71,
      source_origin: 'official_okendo_reviews_html',
    });
    expect(summary.preview_items).toHaveLength(1);
    expect(summary.preview_items[0]).toMatchObject({
      rating: 5,
      author_label: 'Savka S.',
      title: 'Light enough for oily skin',
      source_kind: 'okendo_rendered_html',
      verified_buyer: true,
    });
    expect(summary.preview_items[0].text_snippet).toContain('very light on my oily skin');
  });

  test('extracts SKIN1004 PDP description sections from escaped Shopify product JSON', () => {
    const descriptionHtml = `
      <div class="product__description rte">
        <p><strong>What It Is:</strong><br>A facial ampoule concentrated with azelaic acid for clearer-looking skin.</p>
        <p><strong>Skin Concern:<br></strong>Blemish-Prone Skin, Visible Redness</p>
        <p><strong>Product Benefits:<br></strong>Blemish Care, Visible Redness Soothing</p>
        <p><strong>Key Ingredients: </strong><br>Centella Asiatica Extract, Azelaic Acid, Panthenol, Hyaluronic Acid</p>
      </div>
    `;
    const html = `<script>window.__p = {"description":${JSON.stringify(descriptionHtml)}};</script>`;

    const fields = extractSkin1004Fields(html);

    expect(fields.pdp_details_sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heading: 'What It Is', body: expect.stringContaining('facial ampoule') }),
        expect.objectContaining({ heading: 'Skin Concern', body: expect.stringContaining('Visible Redness') }),
        expect.objectContaining({ heading: 'Product Benefits', body: expect.stringContaining('Blemish Care') }),
        expect.objectContaining({ heading: 'Key Ingredients', body: expect.stringContaining('Azelaic Acid') }),
      ]),
    );
    expect(fields.pdp_active_ingredients_raw).toContain('Azelaic Acid');
  });

  test('extracts generic official Shopify product tab fields without callout drift', () => {
    const fullInci =
      'Aqua, Caprylic/Capric Triglyceride, Glycerin, Squalane, Simmondsia Chinensis Seed Oil, ' +
      'Cetearyl Olivate, Sorbitan Olivate, Cetearyl Alcohol, Sodium Benzoate, Hydroxyacetophenone, ' +
      'Helianthus Annuus Seed Oil, Tocopherol';
    const product = {
      title: 'Silk Night Cream',
      description: '<p>A rich restorative night cream for dry-looking skin.</p>',
      variants: [{ id: 1, title: 'Default Title', option1: 'Default Title', price: 11000 }],
    };
    const html = `
      <div class="product__callouts-item-text"><p>Sustainably Sourced Ingredients</p></div>
      <script type="application/json" id="ProductJson-template--main">${JSON.stringify(product)}</script>
      <button type="button" aria-controls="country-selector"><span>Singapore (SGD $)</span></button>
      <button type="button" aria-controls="product-tab--how"><span>How to use</span></button>
      <button type="button" aria-controls="product-tab--hero"><span>Hero ingredients</span></button>
      <button type="button" aria-controls="product-tab--ingredients"><span>Ingredients</span></button>
      <ul>
        <li id="country-selector"><p>Afghanistan Albania Algeria checkout country list.</p></li>
        <li id="product-tab--how" data-tab-item><p>Apply a pea-sized amount to clean skin at night and massage until absorbed.</p></li>
        <li id="product-tab--hero" data-tab-item><p><strong>HSC-01A 2%, Squalane 5% & Vitamin E 0.5%</strong></p></li>
        <li id="product-tab--ingredients" data-tab-item><p>${fullInci}</p><p>Ingredients explained: supporting copy.</p></li>
      </ul>
    `;

    const fields = extractGenericOfficialShopifyFields(html, { productTitle: 'Silk Night Cream' });

    expect(fields.pdp_ingredients_raw).toBe(fullInci);
    expect(fields.pdp_how_to_use_raw).toContain('Apply a pea-sized amount');
    expect(fields.pdp_active_ingredients_raw).toContain('Squalane');
    expect(fields.pdp_details_sections).toEqual(
      expect.arrayContaining([expect.objectContaining({ heading: 'How To Use' })]),
    );
    expect(fields.pdp_details_sections).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ heading: expect.stringContaining('Singapore') })]),
    );
  });

  test('extracts generic official Shopify accordion ingredients and how-to', () => {
    const fullInci =
      'Aqua, Aloe Vera, Terminalia Ferdinandiana Fruit Extract, Tamarindus Indica Seed Extract, ' +
      'Silk Amino Acid, Tocopherol, Hectorite, Allantoin, Pelargonium Graveolens Oil, Xanthan Gum, ' +
      'Benzyl Alcohol, Dehydroacetic Acid';
    const html = `
      <meta property="og:title" content="Kakadu Plum Super Serum with Vit C">
      <div class="accordion-item">
        <button class="accordion-toggle">How To Use <span>+</span></button>
        <div class="accordion-content"><p>Apply twice daily to clean skin and massage gently before moisturiser.</p></div>
      </div>
      <div class="accordion-item">
        <button class="accordion-toggle">Ingredients <span>+</span></button>
        <div class="accordion-content"><p>${fullInci}</p></div>
      </div>
      <div>Tag Section Cruelty Free Australian Made Shipping footer text that must not join INCI.</div>
    `;

    const fields = extractGenericOfficialShopifyFields(html, {
      productTitle: 'Kakadu Plum Super Serum with Vit C',
    });

    expect(fields.pdp_ingredients_raw).toBe(fullInci);
    expect(fields.pdp_how_to_use_raw).toContain('Apply twice daily');
    expect(fields.pdp_ingredients_raw).not.toContain('Tag Section');
  });

  test('scopes 786 shared soy remover ingredient accordion to current product formula', () => {
    const sharedIngredients =
      'Tea Tree Jojoba Soy Remover: Soy/Vegetable Methyl Esters, Dimethyl Glutamate, Dimethyl Adipate, Simmonsdsia Chinensis (Jojoba)Seed Oil, Melaleuca Alternifolia (Tea Tree) Oil Almond Soy Remover: Dimethyl Glutamate, Dimethyl Adipate, MethylOleate/Palmitate/Linoleate/Stearate, Trideceth-8';
    const htmlFor = (product) => `
      <script type="application/json" id="ProductJson-template--main">${JSON.stringify({
        title: product.title,
        handle: product.handle,
        variants: [{ id: 1, sku: product.sku, title: 'Default Title' }],
      })}</script>
      <h3 class="ff-heading">Ingredients</h3>
      <div id="accordion-content-ingredients"><p>${sharedIngredients}</p></div>
    `;

    const almond = extractGenericOfficialShopifyFields(htmlFor({
      title: 'Soy Nail Polish Remover With Almond Essential Oil',
      handle: 'soy-based-nail-polish-remover',
      sku: 'Almond Soy',
    }), {
      productTitle: 'Soy Nail Polish Remover With Almond Essential Oil',
    });
    const jojoba = extractGenericOfficialShopifyFields(htmlFor({
      title: 'Soy Nail Polish Remover With Jojoba Seed & Tea Tree Oil',
      handle: 'soy-nail-polish-remover-with-jojoba-seed-tea-tree-oil',
      sku: 'Jojoba Soy',
    }), {
      productTitle: 'Soy Nail Polish Remover With Jojoba Seed & Tea Tree Oil',
    });

    expect(almond.pdp_ingredients_raw).toBe(
      'Dimethyl Glutamate, Dimethyl Adipate, Methyl Oleate/Palmitate/Linoleate/Stearate, Trideceth-8',
    );
    expect(jojoba.pdp_ingredients_raw).toBe(
      'Soy/Vegetable Methyl Esters, Dimethyl Glutamate, Dimethyl Adipate, Simmondsia Chinensis (Jojoba) Seed Oil, Melaleuca Alternifolia (Tea Tree) Oil',
    );
  });

  test('extracts UpCircle official QA group ingredients and how-to', () => {
    const fullInci =
      'Sesamum Indicum Seed Oil, Brassica Campestris Seed Oil, Vitis Vinifera Seed Oil, Squalane, ' +
      'Rosa Canina Fruit Oil, Passiflora Edulis Seed Oil, Hippophae Rhamnoides Fruit Oil, Tocopherol, ' +
      'Rosmarinus Officinalis Leaf Extract, Citrus Aurantium Dulcis Peel Oil, Limonene, Linalool';
    const html = `
      <meta property="og:title" content="Body Oil with Passion Fruit Oil">
      <div class="s_qa_group">
        <div class="qa_group_flip"><h3 class="qa_group_title">DETAILS</h3></div>
        <div class="upcircle_content"><p>An award-winning body oil made for dry skin.</p></div>
      </div>
      <div class="s_qa_group">
        <div class="qa_group_flip"><h3 class="qa_group_title">INGREDIENTS</h3></div>
        <div class="upcircle_content"><p><strong>99% NATURAL INGREDIENTS</strong>: ${fullInci}</p></div>
      </div>
      <div class="s_qa_group">
        <div class="qa_group_flip"><h3 class="qa_group_title">HOW TO USE</h3></div>
        <div class="upcircle_content"><div>Dab a small amount onto clean skin and massage until absorbed.</div></div>
      </div>
    `;

    const fields = extractGenericOfficialShopifyFields(html, {
      productTitle: 'Body Oil with Passion Fruit Oil',
    });

    expect(fields.pdp_ingredients_raw).toBe(fullInci);
    expect(fields.pdp_how_to_use_raw).toContain('Dab a small amount');
    expect(fields.pdp_details_sections).toEqual(
      expect.arrayContaining([expect.objectContaining({ heading: 'How To Use' })]),
    );
  });

  test('extracts Miss Nella official details accordion ingredients and how-to', () => {
    const fullInci =
      'Water, Polyurethane-61, Silica, Styrene/Acrylates Copolymer, Mica, Glycerin, ' +
      'Bentonite, Phenoxyethanol, Sodium Dehydroacetate, Calcium Sodium Borosilicate, ' +
      'Tin Oxide, Titanium Dioxide, CI 19140, CI 42090';
    const html = `
      <meta property="og:title" content="Alien Poo: Chrome Green Peel Off Nail Polish">
      <details class="cc-accordion-item">
        <summary class="cc-accordion-item__title"><h3>How to use?</h3></summary>
        <div class="cc-accordion-item__panel">
          <p><strong>Peel-Off Nail Polish</strong></p>
          <p>Apply the nail polish to clean nails and let it dry. Peel it off gently when ready to remove.</p>
        </div>
      </details>
      <details class="cc-accordion-item">
        <summary class="cc-accordion-item__title"><h3>Ingredients</h3></summary>
        <div class="cc-accordion-item__panel"><p>${fullInci}</p></div>
      </details>
    `;

    const fields = extractGenericOfficialShopifyFields(html, {
      productTitle: 'Alien Poo: Chrome Green Peel Off Nail Polish',
    });

    expect(fields.pdp_ingredients_raw).toBe(fullInci);
    expect(fields.pdp_how_to_use_raw).toContain('Apply the nail polish');
  });

  test('does not treat Miss Nella perfume oil-base copy as full INCI', () => {
    const html = `
      <meta property="og:title" content="Sweet Like Me: Hypoallergenic Kids Perfume">
      <details class="cc-accordion-item">
        <summary class="cc-accordion-item__title"><h3>How to use?</h3></summary>
        <div class="cc-accordion-item__panel">
          <div class="cc-accordion-item__content rte cf">
            <div class="metafield-rich_text_field"><p>Simply roll onto wrists and neck for a light, fresh scent. Reapply as needed. Safe for daily use!</p></div>
          </div>
        </div>
      </details>
      <details class="cc-accordion-item">
        <summary class="cc-accordion-item__title"><h3>Ingredients</h3></summary>
        <div class="cc-accordion-item__panel">
          <div class="cc-accordion-item__content rte cf">
            <p>Oil Base, Hexamethylindanopyran, Dimethyl Phenethyl Acetate, Benzaldehyde, Carvone, Ketones Rose</p>
          </div>
        </div>
      </details>
    `;

    const fields = extractGenericOfficialShopifyFields(html, {
      productTitle: 'Sweet Like Me Roll On Perfume',
    });

    expect(fields.pdp_ingredients_raw).toBeUndefined();
  });

  test('extracts short official balm ingredient lists from Shopify description labels', () => {
    const product = {
      title: 'Lucamar Baalm 50g',
      description: `
        <p><strong>A lanolin skin balm for dry hands and body.</strong></p>
        <p><strong>INGREDIENTS:</strong></p>
        <p>Pure Australian Anhydrous Lanolin, Humanely Sourced Vitellaria paradoxa Shea Butter, Australian Hemp extract, Cera Alba, Australian Bees Wax, Vitamin A, Vitamin E, Frankincense and Ginger fragrance.</p>
        <p>No parabens, petrolatum, PEGs, mineral oil or sulphates.</p>
        <p><strong>DAILY RITUAL:</strong></p>
        <p>Soften balm between hands and apply on required areas daily. Only a little is needed.</p>
      `,
    };
    const html = `<script type="application/json" id="ProductJson-template--main">${JSON.stringify(product)}</script>`;

    const fields = extractGenericOfficialShopifyFields(html, { productTitle: 'Lucamar Baalm 50g' });

    expect(fields.pdp_ingredients_raw).toContain('Pure Australian Anhydrous Lanolin');
    expect(fields.pdp_ingredients_raw).not.toContain('No parabens');
    expect(fields.pdp_how_to_use_raw).toContain('Soften balm');
  });

  test('fails closed on unscented ingredient copy that still names fragrance', () => {
    const product = {
      title: 'Lucamar Baalm 50g UNSCENTED',
      description: `
        <p><strong>INGREDIENTS:</strong></p>
        <p>Pure Australian Anhydrous Lanolin, Humanely Sourced Vitellaria paradoxa Shea Butter, Australian Hemp extract, Cera Alba, Australian Bees Wax, Vitamin A, Vitamin E, Frankincense and Ginger Body Safe fragrance.</p>
        <p><strong>DAILY RITUAL:</strong></p>
        <p>Soften balm between hands and apply on required areas daily. Only a little is needed.</p>
      `,
    };
    const html = `<script type="application/json" id="ProductJson-template--main">${JSON.stringify(product)}</script>`;

    const fields = extractGenericOfficialShopifyFields(html, { productTitle: 'Lucamar Baalm 50g UNSCENTED' });

    expect(fields.pdp_ingredients_raw).toBeUndefined();
    expect(fields.pdp_how_to_use_raw).toContain('Soften balm');
  });

  test('extracts generic official Shopify inline product object labels', () => {
    const product = {
      id: 9020926066962,
      title: 'Bulgarian Rose Water Face, Hair & Body Mist Spray',
      handle: 'bulgarian-rose-water-face-hair-body-mist-spray',
      description: `
        <p>Discover the rejuvenating benefits of this botanical face, hair, and body mist.</p>
        <p><span>Directions: Apply on clean skin using a cotton pad or by directly spraying it on your skin. No rinse is necessary.</span></p>
        <p><span>Caution: For external use only. Keep out of the reach of children. Avoid eye contact.</span></p>
        <p><span>Ingredients: Organic Rosa Damascena (Damask Rose) Floral Water</span></p>
      `,
      variants: [{ id: 47818533798162, title: 'Default Title', option1: 'Default Title', sku: '860008494016', price: 2999 }],
    };
    const html = `
      <meta property="og:title" content="Bulgarian Rose Water Face, Hair &amp; Body Mist Spray">
      <script>
        window.AIR_REVIEWS = {
          product: ${JSON.stringify(product)}
        };
      </script>
    `;

    const fields = extractGenericOfficialShopifyFields(html, {
      productTitle: 'Bulgarian Rose Water Face, Hair & Body Mist Spray',
    });

    expect(fields.pdp_ingredients_raw).toBe('Organic Rosa Damascena (Damask Rose) Floral Water');
    expect(fields.pdp_how_to_use_raw).toContain('Apply on clean skin');
    expect(fields.pdp_how_to_use_raw).not.toContain('Caution');
    expect(fields.pdp_description_raw).toContain('botanical face, hair, and body mist');
    expect(fields.pdp_description_raw).not.toContain('Caution');
    expect(fields.pdp_description_raw).not.toContain('Ingredients');
    expect(fields.pdp_details_sections).toEqual(
      expect.arrayContaining([expect.objectContaining({ heading: 'How To Use' })]),
    );
  });

  test('extracts LANEIGE official fields from current product HTML without related-product ingredient drift', () => {
    const product = {
      id: 7231516639284,
      title: 'Bouncy & Firm Sleeping Mask',
      handle: 'bouncy-firm-sleeping-mask',
      description:
        '<p>A visibly firming Korean sleeping mask with Peony &amp; Collagen Complex that delivers overnight and long-term benefits for smoother-looking skin.</p>',
      tags: [
        'key_ingredient::Green Tea Probiotic lysate',
        'key_ingredient::Hyaluronic Acids',
        'key_ingredient::Peony & Collagen Complex + Peptides',
        'skin_type::All',
        'without_ingredient::Parabens',
      ],
      price: 3600,
      variants: [
        {
          id: 42052021452852,
          title: 'Default Title',
          option1: 'Default Title',
          sku: '270283998',
          available: true,
          price: 3600,
        },
      ],
      options: ['Title'],
      images: ['//us.laneige.com/cdn/shop/files/bouncy-mask.jpg?v=1'],
    };
    const html = `
      <script>window.theme = {}; window.theme.current_object = ${JSON.stringify(product)};</script>
      <span class="product__volume">(2.0 fl. oz./60 mL)</span>
      <script>
        theme.products.update({
          id: 7231516639284,
          title: "Bouncy \\u0026 Firm Sleeping Mask",
          handle: "bouncy-firm-sleeping-mask",
          benefits: "Get bouncy-looking skin while you sleep. Peony \\u0026 Collagen Complex and peptides support visibly plump, hydrated-looking skin over time.",
          ingredients: "WATER, BUTYLENE GLYCOL, CYCLOPENTASILOXANE, GLYCERIN, CYCLOHEXASILOXANE, TREHALOSE, SODIUM HYALURONATE, BETA-GLUCAN, ASCORBYL GLUCOSIDE, MAGNESIUM SULFATE, ZINC SULFATE, MANGANESE SULFATE, CALCIUM CHLORIDE, POTASSIUM ALGINATE, POLYSORBATE 20, DIMETHICONE, PROPANEDIOL, ETHYLHEXYLGLYCERIN, CARBOMER, DISODIUM EDTA, PHENOXYETHANOL, FRAGRANCE."
        });
        theme.products.list["related-eye-mask"] = {
          handle: "related-eye-mask",
          ingredients: "UNRELATED RELATED PRODUCT INGREDIENTS, SHOULD NOT BE USED, CAFFEINE, NIACINAMIDE, WATER, GLYCERIN, BUTYLENE GLYCOL, PANTHENOL, XANTHAN GUM, TOCOPHEROL, FRAGRANCE."
        };
      </script>
      <div class="accordion"><button id="accordion-heading-how_to_use"><span class="accordion__title">How to use</span></button>
        <div class="accordion__content" id="accordion-panel-how_to_use">After face cream, apply evenly across face. Leave treatment on overnight and rinse off in the morning.</div>
      </div>
    `;

    const fields = extractLaneigeFields(html, { productTitle: 'LANEIGE US Bouncy & Firm Sleeping Mask' });

    expect(fields.pdp_description_raw).toContain('visibly firming Korean sleeping mask');
    expect(fields.pdp_ingredients_raw).toContain('SODIUM HYALURONATE');
    expect(fields.pdp_ingredients_raw).not.toContain('UNRELATED RELATED PRODUCT');
    expect(fields.pdp_how_to_use_raw).toContain('Leave treatment on overnight');
    expect(fields.pdp_active_ingredients_raw).toContain('Peony & Collagen Complex + Peptides');
    expect(fields.variants).toHaveLength(1);
    expect(fields.variants[0]).toEqual(
      expect.objectContaining({
        option_name: 'Size',
        option_value: '60ml',
        source_origin: 'official_laneige_theme_product_singleton_spec',
      }),
    );
    expect(fields.pdp_details_sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heading: 'Benefits', body: expect.stringContaining('bouncy-looking skin') }),
        expect.objectContaining({ heading: 'Formulated Without', body: 'Parabens' }),
      ]),
    );
  });

  test('extracts Kylie official theme fields, singleton size variant, and source-backed how-to', () => {
    const product = {
      id: 8096711868658,
      title: 'Wisp Lash Mascara',
      handle: 'wisp-lash-kylie-jenner-mascara',
      description:
        '<p>get long, lifted, and fanned-out lashes with my wisp lash mascara. featuring a clean and vegan formula, this mascara weightlessly builds and provides feathery, wispy lashes.</p>',
      tags: [
        'benefit:lengthening',
        'benefit:lightweight',
        'Brand_Principles:clean',
        'Brand_Principles:cruelty free',
        'Brand_Principles:vegan',
        'shade_group:black',
      ],
      price: 2500,
      variants: [
        {
          id: 45167939354866,
          title: 'Default Title',
          option1: 'Default Title',
          sku: 'KC756',
          available: true,
          price: 2500,
        },
      ],
      options: ['Title'],
      images: ['//kyliecosmetics.com/cdn/shop/files/KJC_WLM_23_12ml_Stylized.jpg?v=1'],
    };
    const html = `
      <script>theme.product = ${JSON.stringify(product)};</script>
      <script>
        theme.product.variant_data = [{
          "variant_id":45167939354866,
          "volume_value":"0.4 fl oz",
          "shade_color":"#101010",
          "ingredient_detail":"WATER, EUPHORBIA CERIFERA WAX, GLYCERIN, BUTYLENE GLYCOL, ACRYLATES COPOLYMER, STEARIC ACID, PALMITIC ACID, AMINOMETHYL PROPANEDIOL, PHENOXYETHANOL, HYDROXYETHYLCELLULOSE, PANTHENOL, TOCOPHEROL, SODIUM DEHYDROACETATE, IRON OXIDES (CI 77499)."
        }],
        theme.product.options = [{"name":"Title","position":1,"values":["Default Title"]}];
      </script>
      <div class="content-blocks__item content-blocks__item--two-row-img-text">
        <h3>how to use</h3>
        <p>Starting at the base of the lashes, pull the mascara brush through from root to tip for length and curl.</p>
      </div>
      <div class="content-blocks__item content-blocks__item--two-col-text">
        <h3 class="two-col-text-block__title">why we love it</h3>
        <h5>up to 24 hours of length, lift, and curl</h5>
        <p>great for all lash types and suitable for sensitive eyes.</p>
      </div>
    `;

    const fields = extractKylieFields(html, { productTitle: 'Kylie Cosmetics Wisp Lash Mascara' });

    expect(fields.pdp_description_raw).toContain('long, lifted');
    expect(fields.pdp_ingredients_raw).toContain('EUPHORBIA CERIFERA WAX');
    expect(fields.pdp_how_to_use_raw).toContain('pull the mascara brush through');
    expect(fields.variants).toHaveLength(1);
    expect(fields.variants[0]).toEqual(
      expect.objectContaining({
        option_name: 'Size',
        option_value: '0.4 fl oz',
        axis_kind: 'volume',
        swatch_color: '#101010',
        source_origin: 'official_kylie_variant_data_singleton_spec',
      }),
    );
    expect(fields.variants[0].option_value).not.toMatch(/default/i);
    expect(fields.pdp_details_sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heading: 'Benefits', body: expect.stringContaining('Lengthening') }),
        expect.objectContaining({ heading: 'Brand Principles', body: expect.stringContaining('Cruelty free') }),
        expect.objectContaining({ heading: 'up to 24 hours of length, lift, and curl' }),
      ]),
    );
  });

  test('extracts Medicube overview, study, full ingredients, and how-to toggle blocks', () => {
    const fullInci = [
      'Water',
      'Glycerin',
      'Niacinamide',
      'Butylene Glycol',
      'Sodium Hyaluronate',
      'Panthenol',
      'Tocopherol',
      'Citric Acid',
      'Adenosine',
      'Disodium EDTA',
    ].join(', ');
    const html = `
      <!-- OVERVIEW -->
      <div class="toggle_box"><a class="title plus-minus-toggle">OVERVIEW</a><div class="hide">
        <p class="desc">A transparent collagen jelly cream that provides anti-aging benefits and a glowing complexion for dry-looking skin.</p>
      </div></div>
      <!-- STUDY RESULTS -->
      <div class="toggle_box"><a class="title plus-minus-toggle">STUDY RESULTS</a><ul class="hide">
        <li>Results from a consumer use study: skin radiance and texture improvement after 24h. Results may vary.</li>
      </ul></div>
      <!-- KEY INGREDIENTS -->
      <div class="toggle_box"><a class="title plus-minus-toggle">KEY INGREDIENTS</a><ul class="hide">
        <li><div class="desc_tit">Niacinamide</div> Supports barrier and hydration.</li>
        <li><div class="desc_tit">Hyaluronic Acid</div> Helps skin feel hydrated.</li>
      </ul></div>
      <!-- FULL INGREDIENTS -->
      <div class="toggle_box"><a class="title plus-minus-toggle">FULL INGREDIENTS</a><ul class="hide"><li>${fullInci}</li></ul></div>
      <!-- HOW TO APPLY -->
      <div class="toggle_box"><a class="title plus-minus-toggle">HOW TO APPLY</a><ul class="hide">
        <li>Apply a quarter amount of jelly cream morning and evening to face and neck after applying targeted serums.</li>
      </ul></div>
    `;

    const fields = extractMedicubeFields(html);

    expect(fields.pdp_description_raw).toContain('transparent collagen jelly cream');
    expect(fields.pdp_ingredients_raw).toBe(fullInci);
    expect(fields.pdp_how_to_use_raw).toContain('Apply a quarter amount');
    expect(fields.pdp_active_ingredients_raw).toContain('Niacinamide');
    expect(fields.pdp_active_ingredients_raw).toContain('Hyaluronic Acid');
    expect(fields.pdp_active_ingredients_raw).not.toContain('Supports barrier');
    expect(fields.pdp_details_sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heading: 'Overview', body: expect.stringContaining('transparent collagen jelly cream') }),
        expect.objectContaining({ heading: 'Study Results', body: expect.stringContaining('consumer use study') }),
        expect.objectContaining({ heading: 'Key Ingredients', body: expect.stringContaining('Niacinamide') }),
      ]),
    );
  });

  test('clears stale strict source blocker after authoritative official fields recover', () => {
    const { seedData, patchKeys } = buildSeedDataPatch(
      {
        seed_data: {
          strict_pdp_source_blocker_v1: {
            contract_version: 'external_seed.strict_pdp_source_blocker.v1',
            unsafe_source: true,
            reason_codes: ['public_pdp_404'],
          },
          pdp_field_quality_summary: {
            how_to_use_raw: {
              source_origin: 'unsafe_source_pdp',
              source_quality_status: 'quarantined',
              reason_codes: ['public_pdp_404'],
            },
          },
          snapshot: {
            strict_pdp_source_blocker_v1: {
              contract_version: 'external_seed.strict_pdp_source_blocker.v1',
              unsafe_source: true,
              reason_codes: ['public_pdp_404'],
            },
          },
        },
      },
      {
        pdp_how_to_use_raw: 'Apply evenly as the final skincare step in the morning.',
        pdp_details_sections: [{ heading: 'What it is', body: 'A lightweight daily sunscreen.' }],
      },
    );

    expect(patchKeys).toEqual(expect.arrayContaining(['pdp_how_to_use_raw', 'pdp_details_sections']));
    expect(seedData.strict_pdp_source_blocker_v1).toBeUndefined();
    expect(seedData.snapshot.strict_pdp_source_blocker_v1).toBeUndefined();
    expect(seedData.strict_pdp_source_recovery_v1).toEqual(
      expect.objectContaining({
        contract_version: 'external_seed.strict_pdp_source_recovery.v1',
        recovered_fields: expect.arrayContaining(['pdp_how_to_use_raw', 'pdp_details_sections']),
        previous_marker: expect.objectContaining({ unsafe_source: true }),
      }),
    );
    expect(seedData.pdp_field_quality_summary.how_to_use_raw).toEqual(
      expect.objectContaining({
        source_origin: 'official_html',
        source_quality_status: 'high',
      }),
    );
  });

  test('writes official overview into description fields and reviewed content asset', () => {
    const overview =
      'A reviewed official overview for a vitamin C capsule cream that targets dull-looking skin and visible tone unevenness.';

    const { seedData, patchKeys } = buildSeedDataPatch(
      {
        seed_data: {
          snapshot: {},
        },
      },
      {
        pdp_description_raw: overview,
        pdp_details_sections: [{ heading: 'Overview', body: overview }],
      },
    );

    expect(patchKeys).toEqual(expect.arrayContaining(['pdp_description_raw', 'pdp_details_sections']));
    expect(seedData.description).toBe(overview);
    expect(seedData.pdp_description_raw).toBe(overview);
    expect(seedData.snapshot.description).toBe(overview);
    expect(seedData.snapshot.pdp_description_raw).toBe(overview);
    expect(seedData.pdp_field_quality_summary.description_raw).toEqual(
      expect.objectContaining({
        source_origin: 'official_html',
        source_quality_status: 'high',
      }),
    );
    expect(seedData.pdp_content_asset_v1.fields.description_raw).toEqual(
      expect.objectContaining({
        review_state: 'assistant_reviewed',
        source_kind: 'official_pdp_overview',
      }),
    );
  });

  test('does not use Stamped site-wide totalAll as product review count', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/api/widget/reviews?')) {
        return {
          ok: true,
          json: async () => ({
            ratingAll: 4.8,
            totalAll: 5316,
            data: [],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          rating: 4.8,
          count: 0,
        }),
      };
    });

    const review = await fetchStampedReviewSummary(
      'skin1004.com',
      '<div id="stamped-main-widget" data-product-id="123"></div>',
    );

    expect(review).toBeNull();
  });

  test('extracts The Ordinary Bazaarvoice review previews from the official product id', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      expect(String(url)).toContain('api.bazaarvoice.com/data/reviews.json');
      expect(String(url)).toContain('productid%3Aeq%3A100402');
      return {
        ok: true,
        json: async () => ({
          TotalResults: 2,
          Includes: {
            Products: {
              100402: {
                ReviewStatistics: {
                  TotalReviewCount: 226,
                  AverageOverallRating: 4.331858407079646,
                  OverallRatingRange: 5,
                  RatingDistribution: [
                    { RatingValue: 5, Count: 169 },
                    { RatingValue: 4, Count: 14 },
                    { RatingValue: 3, Count: 11 },
                    { RatingValue: 2, Count: 13 },
                    { RatingValue: 1, Count: 19 },
                  ],
                },
              },
            },
          },
          Results: [
            {
              Id: '175571719',
              Rating: 5,
              Title: 'Worked for me',
              UserNickname: 'Tzone',
              ReviewText:
                'For the longest time, I was using daily moisturizers with SPF; however, with oily skin this serum worked better under sunscreen and did not feel heavy.',
            },
            {
              Id: 'price-only',
              Rating: 5,
              Title: 'Price increase',
              UserNickname: 'Price',
              ReviewText:
                'The price increase is frustrating and the product now feels expensive compared with what this brand used to cost.',
            },
            {
              Id: 'short',
              Rating: 5,
              UserNickname: 'Short',
              ReviewText: 'Great',
            },
          ],
        }),
      };
    });

    const review = await fetchBazaarvoiceReviewSummary(
      'theordinary.com',
      '<div data-bv-show="reviews" data-bv-productId="100402"></div>',
    );

    expect(review).toMatchObject({
      rating: 4.331858407079646,
      review_count: 226,
      source_origin: 'official_bazaarvoice_reviews_api',
    });
    expect(review.preview_items).toHaveLength(1);
    expect(review.preview_items[0]).toMatchObject({
      review_id: '175571719',
      rating: 5,
      author_label: 'Tzone',
      source_kind: 'bazaarvoice_reviews_api',
    });
    expect(review.star_distribution[0]).toEqual({ stars: 5, count: 169, percent: 169 / 226 });
  });

  test('extracts Fenty Yotpo review previews from the official product id', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      expect(String(url)).toContain('api.yotpo.com/v1/widget/fenty_app_key/products/7441247698989/reviews.json');
      return {
        ok: true,
        json: async () => ({
          status: { code: 200, message: 'OK' },
          response: {
            bottomline: {
              total_review: 1278,
              average_score: 4.5704226,
              star_distribution: {
                1: 66,
                2: 24,
                3: 50,
                4: 113,
                5: 1025,
              },
            },
            reviews: [
              {
                id: 835244601,
                score: 5,
                content:
                  "It's my first more expensive blush and I have bought another one because it stays on all day, blends very easily, and works perfectly for my skin tone.",
                title: 'Best blush ever',
                verified_buyer: true,
                language: 'en',
                user: { display_name: 'Noa D.' },
              },
              {
                id: 2,
                score: 5,
                content: 'Love it!',
                language: 'en',
              },
            ],
          },
        }),
      };
    });

    const review = await fetchYotpoReviewSummary(
      'fentybeauty.com',
      '<script>window.theme = { yotpoKey: "fenty_app_key" };</script><script>resourceId: "7441247698989"</script>',
    );

    expect(review).toMatchObject({
      rating: 4.5704226,
      review_count: 1278,
      source_origin: 'official_yotpo_reviews_api',
    });
    expect(review.preview_items).toHaveLength(1);
    expect(review.preview_items[0]).toMatchObject({
      review_id: 'yotpo_835244601',
      rating: 5,
      author_label: 'Noa D.',
      title: 'Best blush ever',
      source_kind: 'yotpo_reviews_api',
      verified_buyer: true,
    });
    expect(review.star_distribution[0]).toEqual({ stars: 5, count: 1025, percent: 1025 / 1278 });
  });

  test('extracts Fenty shade-specific full ingredients and key ingredient cards', () => {
    const html = `
      <modal title="Full ingredients">
        <div class="product-ingredients-modal__wrapper">
          <div class="product-ingredients-modal__content OneLinkNoTx">
            <p><strong>100, 110, 120, 235:</strong> AQUA/WATER/EAU, DIMETHICONE, BUTYLENE GLYCOL DICAPRYLATE/DICAPRATE, DIPHENYLSILOXY PHENYL TRIMETHICONE, GLYCERIN, SYNTHETIC FLUORPHLOGOPITE, CETYL PEG/PPG-10/1 DIMETHICONE, TRISILOXANE, BUTYLENE GLYCOL, 1,2-HEXANEDIOL, PEG-10 DIMETHICONE, TERMINALIA FERDINANDIANA FRUIT EXTRACT, CYPERUS ROTUNDUS ROOT EXTRACT, TITANIUM DIOXIDE (CI 77891), IRON OXIDES (CI 77491, CI 77492, CI 77499).</p>
            <p><strong>420:</strong> AQUA/WATER/EAU, DIMETHICONE, GLYCERIN, CAPRYLYL METHICONE, PEG-10 DIMETHICONE, MAGNESIUM SULFATE, LAUROYL LYSINE, POLYHYDROXYSTEARIC ACID, TERMINALIA FERDINANDIANA FRUIT EXTRACT, CYPERUS ROTUNDUS ROOT EXTRACT, TITANIUM DIOXIDE (CI 77891), IRON OXIDES (CI 77491, CI 77492, CI 77499).</p>
          </div>
        </div>
      </modal>
      <div class="product-ingredients__item-title">Kakadu Plum Extract</div>
      <div class="product-ingredients__item-title">Cyperus Papyrus Leaf Cell Extract</div>
    `;

    const full = extractFentyFullIngredients(
      html,
      "Soft'lit Naturally Luminous Longwear Foundation — 235",
    );
    expect(full).toContain('SYNTHETIC FLUORPHLOGOPITE');
    expect(full).toContain('TITANIUM DIOXIDE');
    expect(full).not.toContain('CAPRYLYL METHICONE');

    const fields = extractFentyFields(html, {
      productTitle: "Soft'lit Naturally Luminous Longwear Foundation — 235",
    });
    expect(fields.pdp_ingredients_raw).toBe(full);
    expect(fields.pdp_active_ingredients_raw).toBeUndefined();
  });

  test('extracts Fenty shade-specific INCI from long shade-range labels', () => {
    const sharedInci =
      'AQUA/WATER/EAU, HYDROGENATED DIDECENE, HYDROGENATED POLYISOBUTENE, TRIMETHYLSILOXYSILICATE, CETYL PEG/PPG-10/1 DIMETHICONE, GLYCERIN, METHICONE, NYLON-12, DISTEARDIMONIUM HECTORITE, DIMETHICONE, SODIUM CHLORIDE, ACRYLATES/POLYTRIMETHYLSILOXYMETHACRYLATE COPOLYMER, POLYMETHYLSILSESQUIOXANE, TOCOPHERYL ACETATE, IRON OXIDES (CI 77491, CI 77492, CI 77499).';
    const shade380Inci =
      'AQUA/WATER/EAU, HYDROGENATED DIDECENE, GLYCERIN, NYLON-12, DIMETHICONE, MICA, TITANIUM DIOXIDE (CI 77891), RED 7 LAKE (CI 15850), TOCOPHEROL, SODIUM CHLORIDE, CITRIC ACID, IRON OXIDES (CI 77491).';
    const html = `
      <modal title="Full ingredients">
        <div class="product-ingredients-modal__wrapper">
          <div class="product-ingredients-modal__content OneLinkNoTx">
            <p>All 50 shades of Pro Filt'r Instant Retouch Concealer are vegan.</p>
            <p>SHADE 100: ${shade380Inci}</p>
            <p>SHADES 105, 110, 130, 140, 145, 150, 160, 170, 180, 185, 190, 200, 210, 220, 230, 235, 240, 250, 260, 270, 280, 290, 300, 320, 330, 340, 345, 350, 360, 370, 385, 390, 400, 410, 420, 430, 440, 445, 450, 460, 470, 480, 490, 495, & 498: ${sharedInci}</p>
            <p>SHADE 380: ${shade380Inci}</p>
          </div>
        </div>
      </modal>
    `;

    const full = extractFentyFullIngredients(html, "Pro Filt'r Instant Retouch Concealer — #410");

    expect(full).toBe(sharedInci);
    expect(full).not.toBe(shade380Inci);
  });

  test('extracts Guerlain JSON-LD size variants and official usage/details without inventing INCI', () => {
    const html = `
      <script type="application/ld+json">
      {
        "@context": "https://schema.org/",
        "@type": "ProductGroup",
        "name": "Abeille Royale YOUTH WATERY OIL SERUM",
        "productGroupID": "P062033",
        "url": "https://www.guerlain.com/us/en-us/p/abeille-royale-youth-watery-oil-serum-P062033.html",
        "description": "A repair-focused serum with honey fractions that helps skin look plumper and more radiant over time.",
        "hasVariant": [{
          "@type": "Product",
          "name": "Abeille Royale YOUTH WATERY OIL SERUM 50 ML / 1.69 OZ",
          "sku": "G062033",
          "size": "50 ML / 1.69 OZ",
          "image": [{"url": "https://www.guerlain.com/serum.png"}],
          "offers": {
            "url": "https://www.guerlain.com/us/en-us/p/abeille-royale-youth-watery-oil-serum-P062033.html?v=G062033",
            "priceCurrency": "USD",
            "price": "160.00",
            "availability": "http://schema.org/InStock"
          }
        }]
      }
      </script>
      <section>
        <h2>THE PLUMPING APPLICATION TECHNIQUE BY GUERLAIN SPA FACIALISTS</h2>
        <p>Apply the Youth Serum daily, morning and evening, to clean, dry skin before the Honey Treatment cream.</p>
      </section>
      <h3 class="GSA_ingredient_title">EXCLUSIVE ROYAL JELLY</h3>
      <p class="GSA_ingredient_description">Royal jelly is a hive ingredient selected by Guerlain for this Abeille Royale formula.</p>
    `;

    const fields = extractGuerlainFields(html, {
      productTitle: 'Abeille Royale YOUTH WATERY OIL SERUM',
    });

    expect(fields.variants).toHaveLength(1);
    expect(fields.variants[0]).toEqual(
      expect.objectContaining({
        variant_id: 'G062033',
        option_name: 'Size',
        option_value: '50 ML / 1.69 OZ',
        source_origin: 'official_guerlain_json_ld',
      }),
    );
    expect(fields.pdp_how_to_use_raw).toContain('Apply the Youth Serum daily');
    expect(fields.pdp_details_sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heading: 'Overview', body: expect.stringContaining('repair-focused serum') }),
        expect.objectContaining({ heading: 'Key Ingredients', body: expect.stringContaining('EXCLUSIVE ROYAL JELLY') }),
      ]),
    );
    expect(fields.pdp_ingredients_raw).toBeUndefined();
  });

  test('extracts Guerlain official ingredient modal URL and full INCI', () => {
    const productHtml = `
      <button
        data-url-ingredient="/on/demandware.store/Sites-Guerlain_US-Site/en_US/Product-IngredientModal?pid=G043986">
        Show all ingredients
      </button>
    `;
    const modalHtml = `
      <div class="ingredientContentHolder">
        <p><b>#19933 INGREDIENTS :</b></p>
        <ul>
          <li> &bull;  RICINUS COMMUNIS (CASTOR) SEED OIL</li>
          <li> &bull;  SQUALANE</li>
          <li> &bull;  HYDROGENATED CASTOR OIL</li>
          <li> &bull;  CERA CARNAUBA (COPERNICIA CERIFERA (CARNAUBA) WAX)</li>
          <li> &bull;  KAOLIN</li>
          <li> &bull;  SYNTHETIC FLUORPHLOGOPITE</li>
          <li> &bull;  ALUMINUM HYDROXIDE</li>
          <li> &bull;  TOCOPHEROL</li>
          <li> &bull;  AQUA (WATER)</li>
          <li> &bull;  [+/- CI 15850 (RED 6, RED 7)</li>
          <li> &bull;  CI 45410 (RED 28 LAKE)</li>
          <li> &bull;  CI 77492, CI 77499 (IRON OXIDES)]</li>
        </ul>
      </div>
    `;

    expect(
      extractGuerlainIngredientModalUrl(
        productHtml,
        'https://www.guerlain.com/us/en-us/p/contour-g-lip-pencil-P043986.html',
      ),
    ).toBe('https://www.guerlain.com/on/demandware.store/Sites-Guerlain_US-Site/en_US/Product-IngredientModal?pid=G043986');
    expect(parseGuerlainIngredientModalHtml(modalHtml)).toContain('RICINUS COMMUNIS');

    const fields = extractGuerlainFields(
      `
        <script type="application/ld+json">
        {"@type":"Product","name":"CONTOUR G LIP PENCIL","description":"A precise lip pencil for shaping and defining the lip contour with comfortable wear.","sku":"G043986","category":"Lip Pencil","offers":{"priceCurrency":"USD","price":37}}
        </script>
      `,
      {
        productTitle: 'CONTOUR G LIP PENCIL',
        ingredientModalHtml: modalHtml,
      },
    );

    expect(fields.pdp_ingredients_raw).toContain('SQUALANE');
    expect(fields.pdp_ingredients_raw).toContain('CI 77492');
  });

  test('extracts Guerlain singleton customizable lipstick format from official product JSON-LD', () => {
    const html = `
      <script type="application/ld+json">
      {
        "@context":"http://schema.org/",
        "@type":"Product",
        "name":"ROUGE G THE CUSTOMIZABLE ULTRA-CARE LIPSTICK",
        "description":"Rouge G is a customizable lipstick. Capacity: 3.5 g. The new Rouge G cases are only compatible with the new-generation refills.",
        "sku":"G044110",
        "category":"Lipstick",
        "image":["https://www.guerlain.com/rouge.png"],
        "offers":{"url":"https://www.guerlain.com/us/en-us/p/rouge-g-the-customizable-ultra-care-lipstick-S000070.html?v=S000070","priceCurrency":"USD","price":87,"availability":"http://schema.org/InStock"}
      }
      </script>
    `;

    const fields = extractGuerlainFields(html, {
      productTitle: 'ROUGE G THE CUSTOMIZABLE ULTRA-CARE LIPSTICK',
    });

    expect(fields.variants).toHaveLength(1);
    expect(fields.variants[0]).toEqual(
      expect.objectContaining({
        sku: 'G044110',
        option_name: 'Format',
        option_value: '3.5 g lipstick refill + customizable case',
      }),
    );
  });

  test('extracts Tom Ford official accordion INCI, how-to, and overview', () => {
    const inci =
      'Alcohol Denat., Fragrance (parfum), Water Aqua Eau, Dipropylene Glycol, Linalool, Hydroxycitronellal, Coumarin, Farnesol, Limonene, Cinnamyl Alcohol, Eugenol, Tocopherol.';
    const html = `
      <script type="application/ld+json">
      {"@context":"http://schema.org/","@type":"ProductGroup","name":"Oud Wood Parfum","description":"Oud Wood Parfum reveals rich wood notes and glowing amber with cardamom and patchouli.","hasVariant":[]}
      </script>
      <accordion-custom><details><summary><h2>PRODUCT DETAILS</h2></summary>
        <div class="details-content"><span>Key Notes</span><span>Cardamom, Pink Pepper, Patchouli, Amber, Oud, Tonka Bean</span></div>
      </details></accordion-custom>
      <accordion-custom><details><summary><h2>HOW TO USE</h2></summary>
        <div class="details-content"><span>On clean skin, spray fragrance once or twice on desired areas. Do not rub the fragrance on skin.</span></div>
      </details></accordion-custom>
      <accordion-custom><details><summary><h2>INGREDIENTS AND SAFETY</h2></summary>
        <div class="details-content"><span>Key Ingredients</span><span>Ingredients: ${inci} <ILN50552></span>
        <span>Please be aware that ingredient lists may change.</span></div>
      </details></accordion-custom>
    `;

    const fields = extractTomFordFields(html, { productTitle: 'Oud Wood Parfum' });

    expect(fields.pdp_description_raw).toContain('rich wood notes');
    expect(fields.pdp_ingredients_raw).toBe(inci);
    expect(fields.pdp_how_to_use_raw).toContain('spray fragrance once or twice');
    expect(fields.pdp_details_sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heading: 'Product Details', body: expect.stringContaining('Cardamom') }),
      ]),
    );
  });

  test('extracts Rare Beauty official details, INCI, claims, and clean how-to without FAQ drift', () => {
    const html = `
      <script type="application/ld+json">
      {"@context":"https://schema.org/","@type":"Product","name":"Stay Vulnerable Melting Blush","description":"A breakthrough, mistakeproof liquid-like cream blush that melts into a second skin for the most natural-looking flush you can’t mess up."}
      </script>
      <p class="pv-extra-details__claim">Cruelty Free</p>
      <p class="pv-extra-details__claim">Vegan</p>
      <div class="pv-extra-details__section pv-extra-details__section--large">
        <h2 class="pv-extra-details__section-title">Details</h2>
        <p class="pv-extra-details__section-description">Inspired by the soft, flushed look we get when we feel the most vulnerable, this unique liquid-like cream melts on contact for a truly weightless wash of color that lasts all day.<br><br>Real results: 98% said it’s smooth, creamy, and lightweight.</p>
      </div>
      <span class="acc__title">What&apos;s in it?</span>
      <div class="acc__menu"><p class="pv-extra-details__accordion-body">Made with a Botanical Blend of lotus, gardenia, and white water lily to help soothe, calm, and nourish skin.</p></div>
      <span class="acc__title">How to use</span>
      <div class="acc__menu"><p class="pv-extra-details__accordion-body">Use a dense brush—or your fingertips—to dab onto the apples of your cheeks and blend. Apply more layers as desired.<br><br><h3>Melting Blush FAQs</h3><b>Can I layer it?</b> Yes.</p></div>
      <h2 id="ingredientsModalLabel" class="h3">Full Ingredients</h2>
      <div class="modal__content">
        <p><b>SHADE: NEARLY ROSE</b><br>Isodecyl Isononanoate, Silica, C12-15 Alkyl Benzoate, Isodecyl Neopentanoate, Octyldodecyl Stearoyl Stearate, Methyl Methacrylate Crosspolymer, Limnanthes Alba (Meadowfoam) Seed Oil, Polyethylene, Synthetic Fluorphlogopite, Tocopheryl Acetate, Gardenia Florida Fruit Extract, Nelumbo Nucifera Flower Extract, Nymphaea Odorata Root Extract, Red 28 Lake (CI 45410), Titanium Dioxide (CI 77891), Iron Oxides (CI 77492).</p>
      </div>
    `;

    const fields = extractRareFields(html, { productTitle: 'Stay Vulnerable Melting Blush' });

    expect(fields.pdp_description_raw).toContain('mistakeproof liquid-like cream blush');
    expect(fields.pdp_details_sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heading: 'Details', body: expect.stringContaining('Real results') }),
        expect.objectContaining({ heading: 'Claims', body: expect.stringContaining('Cruelty Free') }),
        expect.objectContaining({ heading: 'How To Use', body: expect.stringContaining('dab onto the apples') }),
      ]),
    );
    expect(JSON.stringify(fields.pdp_details_sections)).not.toMatch(/Can I layer|FAQs/i);
    expect(fields.pdp_how_to_use_raw).toContain('Apply more layers as desired');
    expect(fields.pdp_how_to_use_raw).not.toMatch(/FAQs|Can I layer/i);
    expect(fields.pdp_ingredients_raw).toContain('Isodecyl Isononanoate');
    expect(fields.pdp_active_ingredients_raw).toBeUndefined();
  });

  test('extracts Rare Beauty SPF active ingredients from full ingredient modal', () => {
    const html = `
      <script type="application/ld+json">
      {"@context":"https://schema.org/","@type":"Product","name":"Positive Light Tinted Moisturizer Broad Spectrum SPF 20 Sunscreen","description":"Lightweight tinted moisturizer with SPF 20 for breathable coverage and hydration."}
      </script>
      <h2 class="pv-extra-details__section-title">Details</h2>
      <p class="pv-extra-details__section-description">Think no-makeup makeup in a bottle with built-in Broad Spectrum SPF 20 sunscreen plus Vitamin E. Net Wt. 1.0 fl.oz | 30mL.</p>
      <span class="acc__title">How to use</span>
      <div class="acc__menu"><p class="pv-extra-details__accordion-body">Shake it up, then massage a few drops into skin using your fingertips.</p></div>
      <h2 id="ingredientsModalLabel" class="h3">Full Ingredients</h2>
      <div class="modal__content">
        <p><b>Active ingredients:</b><br> Homosalate: 9.0% <br>Titanium Dioxide: 1.8% <br>Zinc Oxide: 0.9% <br><br><b>Inactive ingredients:</b><br> Water/Aqua, Dimethicone, Talc, Tocopheryl Acetate, Gardenia Florida Fruit Extract, Iron Oxides (CI 77491, CI 77492, CI 77499)</p>
      </div>
    `;

    const fields = extractRareFields(html, {
      productTitle: 'Positive Light Tinted Moisturizer Broad Spectrum SPF 20 Sunscreen',
    });

    expect(fields.pdp_active_ingredients_raw).toBe('Homosalate: 9.0% Titanium Dioxide: 1.8% Zinc Oxide: 0.9%');
    expect(fields.pdp_ingredients_raw).toContain('Inactive ingredients');
    expect(fields.pdp_details_sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heading: 'Details', body: expect.stringContaining('Broad Spectrum SPF 20') }),
      ]),
    );
  });

  test('accepts Tom Ford makeup INCI without skincare or fragrance tokens', () => {
    const inci =
      'Hydrogenated Polyisobutene, Trimethylsiloxysilicate, Isododecane, Synthetic Wax, Polybutene, Mica, Synthetic Fluorphlogopite, Lauroyl Lysine, Disteardimonium Hectorite, Propylene Carbonate, Ethylene/propylene Copolymer, Copernicia Cerifera (carnauba) Wax, Pentaerythrityl Tetra-di-t-butyl Hydroxyhydrocinnamate, [+/- Titanium Dioxide (ci 77891), Iron Oxides (ci 77491), Iron Oxides (ci 77492), Blue 1 Lake (ci 42090), Yellow 5 Lake (ci 19140)]';
    const html = `
      <script type="application/ld+json">
      {"@context":"http://schema.org/","@type":"Product","name":"Gel Eyeliner","description":"A creamy gel-pencil liner for smoky eye definition."}
      </script>
      <accordion-custom><details><summary><div><h2>INGREDIENTS AND SAFETY</h2></div></summary>
        <div class="details-content"><span>Ingredients: ${inci}</span></div>
      </details></accordion-custom>
    `;

    expect(extractTomFordFields(html, { productTitle: 'Gel Eyeliner' }).pdp_ingredients_raw).toBe(inci);
  });

  test('extracts Fenty shade INCI across stylized punctuation and reordered label words', () => {
    const roseAmberInci =
      'DIMETHICONE, SILICA, TRIMETHYLSILOXYSILICATE, POLYISOBUTENE, SYNTHETIC FLUORPHLOGOPITE, POLYETHYLENE, OZOKERITE, ACRYLATES/STEARYL ACRYLATE/DIMETHICONE METHACRYLATE COPOLYMER, TOCOPHEROL, IRON OXIDES (CI 77491, CI 77492, CI 77499), RED 7 LAKE (CI 15850).';
    const ririInci =
      'DIMETHICONE, DIMETHICONE/VINYL DIMETHICONE CROSSPOLYMER, ISODODECANE, POLYGLYCERYL-2 TRIISOSTEARATE, PEG-10 DIMETHICONE, TRIBEHENIN, TRIETHOXYCAPRYLYLSILANE, DISTEARDIMONIUM HECTORITE, PROPYLENE CARBONATE, TOCOPHEROL, IRON OXIDES (CI 77491).';
    const champInci =
      'TRISILOXANE, MICA, TRIMETHYLSILOXYSILICATE, DIMETHICONE, PHENYLPROPYLDIMETHYLSILOXYSILICATE, POLYETHYLENE, SYNTHETIC WAX, C20-24 ALKYL DIMETHICONE, DIISOSTEARYL MALATE, TOCOPHEROL, TITANIUM DIOXIDE (CI 77891).';
    const html = `
      <modal title="Full ingredients">
        <div class="product-ingredients-modal__wrapper">
          <div class="product-ingredients-modal__content OneLinkNoTx">
            <p>AMBER ROSE: ${roseAmberInci}</p>
            <p>RIRI, C&#39;SUITE-HEART: ${ririInci}</p>
            <p>DIAMOND VEIL CHAMP&rsquo;ION: ${champInci}</p>
          </div>
        </div>
      </modal>
    `;

    expect(extractFentyFullIngredients(html, "Trace'd Out Longwear Waterproof Pencil Lip Liner — Rose Amber")).toBe(
      roseAmberInci,
    );
    expect(extractFentyFullIngredients(html, 'Fenty Icon Velvet Liquid Lipstick — RiRi')).toBe(ririInci);
    expect(extractFentyFullIngredients(html, "Shadowstix Longwear Eyeshadow Stick — Diamond Veil Champ'ion")).toBe(
      champInci,
    );
  });

  test('missing-fields-only seed patch preserves existing approved fields', () => {
    const existingInci = 'AQUA/WATER/EAU, GLYCERIN, DIMETHICONE, BUTYLENE GLYCOL, PHENOXYETHANOL, SODIUM CHLORIDE, TOCOPHEROL, XANTHAN GUM, CITRIC ACID, SODIUM HYDROXIDE, FRAGRANCE, MICA.';
    const row = {
      seed_data: {
        snapshot: {},
        pdp_ingredients_raw: existingInci,
      },
    };
    const patch = buildSeedDataPatch(
      row,
      {
        pdp_ingredients_raw:
          'AQUA/WATER/EAU, DIMETHICONE, GLYCERIN, BUTYLENE GLYCOL, SODIUM CHLORIDE, TOCOPHEROL, XANTHAN GUM, CITRIC ACID, SODIUM HYDROXIDE, FRAGRANCE, MICA.',
        pdp_active_ingredients_raw: 'Kakadu Plum Extract',
      },
      { missingFieldsOnly: true },
    );

    expect(patch.patchKeys).toEqual(['pdp_active_ingredients_raw']);
    expect(patch.seedData.pdp_ingredients_raw).toBe(existingInci);
    expect(patch.seedData.active_ingredients).toEqual(['Kakadu Plum Extract']);
  });

  test('missing-fields-only seed patch replaces force-filled ingredients with official source', () => {
    const forceFilledInci =
      'WATER, GLYCERIN, BUTYLENE GLYCOL, NIACINAMIDE, PHENOXYETHANOL, TOCOPHEROL, FRAGRANCE, IRON OXIDES.';
    const officialInci =
      'AQUA/WATER/EAU, CYCLOPENTASILOXANE, TITANIUM DIOXIDE, BUTYLENE GLYCOL, GLYCERIN, NIACINAMIDE, PHENOXYETHANOL, TOCOPHEROL, IRON OXIDES (CI 77491, CI 77492, CI 77499), FRAGRANCE.';
    const row = {
      seed_data: {
        snapshot: {},
        pdp_ingredients_raw: forceFilledInci,
        pdp_field_quality_summary: {
          ingredients_raw: {
            source_origin: 'pivota_force_fill',
            source_quality_status: 'force_filled_pending_source',
          },
        },
      },
    };

    const patch = buildSeedDataPatch(
      row,
      {
        pdp_ingredients_raw: officialInci,
      },
      { missingFieldsOnly: true },
    );

    expect(patch.patchKeys).toContain('pdp_ingredients_raw');
    expect(patch.seedData.pdp_ingredients_raw).toBe(officialInci);
    expect(patch.seedData.pdp_field_quality_summary.ingredients_raw.source_origin).toBe('official_html');
    expect(patch.seedData.pdp_field_quality_summary.ingredients_raw.source_quality_status).toBe('high');
  });

  test('missing-fields-only seed patch replaces non-displayable generic variant placeholders', () => {
    const row = {
      seed_data: {
        variants: [
          {
            variant_id: 'legacy-default',
            title: 'Single item',
            options: [{ name: 'Format', value: 'Single item' }],
          },
          {
            variant_id: 'legacy-auto-offer',
            title: 'AUTO-9e1c20fecc70',
            options: [{ name: 'Offer', value: 'AUTO-9e1c20fecc70' }],
          },
        ],
        snapshot: {},
      },
    };

    const patch = buildSeedDataPatch(
      row,
      {
        variants: [
          {
            variant_id: 'official-size',
            title: 'Default Title',
            options: [{ name: 'Size', value: '60ml' }],
            option_name: 'Size',
            option_value: '60ml',
          },
        ],
      },
      { missingFieldsOnly: true },
    );

    expect(patch.patchKeys).toContain('variants');
    expect(patch.seedData.variants).toEqual([
      expect.objectContaining({
        variant_id: 'official-size',
        option_name: 'Size',
        option_value: '60ml',
      }),
    ]);
  });

  test('missing-fields-only seed patch preserves existing displayable variants', () => {
    const row = {
      seed_data: {
        variants: [
          {
            variant_id: 'existing-berry',
            title: 'Berry',
            options: [{ name: 'Shade', value: 'Berry' }],
          },
        ],
        snapshot: {},
      },
    };

    const patch = buildSeedDataPatch(
      row,
      {
        variants: [
          {
            variant_id: 'incoming-size',
            title: 'Default Title',
            options: [{ name: 'Size', value: '10g' }],
          },
        ],
      },
      { missingFieldsOnly: true },
    );

    expect(patch.patchKeys).not.toContain('variants');
    expect(patch.seedData.variants).toEqual([
      expect.objectContaining({
        variant_id: 'existing-berry',
        options: [{ name: 'Shade', value: 'Berry' }],
      }),
    ]);
  });

  test('JSONB writer strips null-byte escapes from historical payloads', () => {
    const text = stringifyPostgresJsonb({
      root: 'before\u0000after',
      escaped: 'before\\u0000after',
      nested: {
        doubleEscaped: 'before\\\\u0000after',
      },
    });

    expect(text).not.toContain('\u0000');
    expect(text).not.toMatch(/\\+u0000/i);
    expect(JSON.parse(text)).toEqual({
      root: 'beforeafter',
      escaped: 'beforeafter',
      nested: {
        doubleEscaped: 'beforeafter',
      },
    });
  });

  test('builds serving mirror patches from approved review and variant fields', () => {
    const patch = buildServingPayloadPatch(
      {
        review_summary: {
          rating: 4.47,
          review_count: 355,
          preview_items: [{ review_id: 'yotpo_1', text_snippet: 'Soft and easy to use.' }],
        },
        variants: [
          {
            variant_id: 'v-mini',
            title: 'Mini',
            options: [{ name: 'Format', value: 'Mini' }],
          },
        ],
        snapshot: {
          review_summary: { review_count: 12 },
          variants: [],
        },
      },
      ['review_summary', 'variants'],
    );

    expect(patch.review_summary.review_count).toBe(355);
    expect(patch.review_summary.preview_items).toHaveLength(1);
    expect(patch.variants).toEqual([
      expect.objectContaining({
        variant_id: 'v-mini',
        options: [{ name: 'Format', value: 'Mini' }],
      }),
    ]);
  });
});
