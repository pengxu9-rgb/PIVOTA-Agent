jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
  closePool: jest.fn(async () => {}),
}));

const {
  _internals: {
    extractTirtirFaqHowToUse,
    extractSkin1004Fields,
    extractMedicubeFields,
    extractOfficialShopifyVariants,
    fetchStampedReviewSummary,
    fetchBazaarvoiceReviewSummary,
    parseOkendoReviewSummary,
    buildSeedDataPatch,
    hasUsefulReviewText,
    buildShopifyProductJsonUrl,
    findTirtirSheetIngredientRow,
    normalizeTirtirTitleKey,
    scoreTirtirSheetProductName,
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
        'This centella ampoule is really soothing on my acne-prone combination skin and absorbs quickly without feeling sticky.',
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
});
