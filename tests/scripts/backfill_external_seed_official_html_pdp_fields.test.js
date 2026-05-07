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
    buildSeedDataPatch,
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
});
