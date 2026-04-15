const { buildPdpPayload } = require('../src/pdpBuilder');

function findModule(payload, type) {
  return Array.isArray(payload?.modules)
    ? payload.modules.find((module) => module && module.type === type)
    : null;
}

describe('pdpBuilder structured PDP modules', () => {
  test('media_gallery keeps the default variant gallery first and adds preview images for other variants', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'p_media_1',
        merchant_id: 'external_seed',
        title: 'Runway Eye Color Quad Creme',
        image_url: 'https://sdcdn.io/tf/tf_sku_T1QT01_3000x3000_0.png?height=1400px&width=1400px',
        image_urls: [
          'https://sdcdn.io/tf/tf_sku_T1QT01_3000x3000_0.png?height=1400px&width=1400px',
          'https://sdcdn.io/tf/tf_sku_T1QT01_2000x2000_1.jpg?height=1400px&width=1400px',
          'https://sdcdn.io/tf/tf_sku_T1QT01_3000x3000_0.png?height=700px&width=700px',
          'https://sdcdn.io/tf/tf_sku_T1QW01_3000x3000_0.png?height=1400px&width=1400px',
          'https://sdcdn.io/tf/tf_sku_T1QW01_2000x2000_1.jpg?height=1400px&width=1400px',
          'https://assets.sdcdn.io/_sb/f/1018472/2500x584/cbfb93877a/tfb_online_plpbanner_mostwanted_desktop_2500x584.jpg',
        ],
        price: { amount: 96, currency: 'USD' },
        variants: [
          {
            variant_id: 'v_default',
            title: '35 Rose Topaz / 8.0 g',
            image_url: 'https://sdcdn.io/tf/tf_sku_T1QT01_3000x3000_0.png?height=1400px&width=1400px',
            image_urls: [
              'https://sdcdn.io/tf/tf_sku_T1QT01_3000x3000_0.png',
              'https://sdcdn.io/tf/tf_sku_T1QT01_2000x2000_1.jpg',
            ],
          },
          {
            variant_id: 'v_other',
            title: '01 Iconic Nude / 8.0 g',
            image_url: 'https://sdcdn.io/tf/tf_sku_T1QW01_3000x3000_0.png?height=1400px&width=1400px',
            image_urls: [
              'https://sdcdn.io/tf/tf_sku_T1QW01_3000x3000_0.png',
              'https://sdcdn.io/tf/tf_sku_T1QW01_2000x2000_1.jpg',
            ],
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const mediaGallery = findModule(payload, 'media_gallery');
    const urls = Array.isArray(mediaGallery?.data?.items)
      ? mediaGallery.data.items.map((item) => item.url)
      : [];

    expect(urls).toEqual(
      expect.arrayContaining([
        'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QT01_2000x2000_1.jpg',
        'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QT01_3000x3000_0.png',
        'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QW01_2000x2000_1.jpg',
      ]),
    );
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.some((url) => url.includes('plpbanner'))).toBe(false);
  });

  test('emits additive beauty modules from structured ingredient fields and carries brand story separately', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'p_structured_1',
        merchant_id: 'm_structured_1',
        title: 'Barrier Support Cream',
        image_url: 'https://cdn.example.com/barrier.jpg',
        price: { amount: 38, currency: 'USD' },
        pdp_description_raw: 'A barrier-supporting cream designed for dry, reactive skin.',
        pdp_details_sections: [
          { heading: 'Ingredients', body: 'Water, Glycerin, Ceramide NP', source_kind: 'html_section' },
          { heading: 'How to Use', body: 'Massage onto clean skin. Use twice daily.', source_kind: 'html_section' },
          { heading: 'Clinical Results', body: 'Improves barrier support in 7 days.', source_kind: 'html_section' },
          { heading: 'Brand Story', body: 'Built with skin barrier science in mind.', source_kind: 'html_section' },
        ],
        raw_ingredient_text_clean: 'Water, Glycerin, Ceramide NP',
        inci_list: ['Water', 'Glycerin', 'Ceramide NP'],
        active_ingredients: ['Ceramide NP', 'Glycerin'],
        ingredient_intel: {
          external_seed_enrichment: {
            source: 'pdp_ingredient_fields',
          },
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const ingredientsModule = findModule(payload, 'ingredients_inci');
    const activeModule = findModule(payload, 'active_ingredients');
    const howToUseModule = findModule(payload, 'how_to_use');
    const factsModule = findModule(payload, 'product_facts');
    const detailsModule = findModule(payload, 'product_details');

    expect(payload.product.description).toBe(
      'A barrier-supporting cream designed for dry, reactive skin.',
    );
    expect(payload.product.brand_story).toBe('Built with skin barrier science in mind.');

    expect(ingredientsModule?.data).toEqual(
      expect.objectContaining({
        title: 'Ingredients',
        raw_text: 'Water, Glycerin, Ceramide NP',
        items: ['Water', 'Glycerin', 'Ceramide NP'],
        source_origin: 'retail_pdp',
        source_quality_status: 'captured',
      }),
    );
    expect(activeModule?.data).toEqual(
      expect.objectContaining({
        title: 'Active ingredients',
        items: ['Ceramide NP', 'Glycerin'],
      }),
    );
    expect(howToUseModule?.data).toEqual(
      expect.objectContaining({
        title: 'How to use',
        raw_text: 'Massage onto clean skin. Use twice daily.',
        steps: ['Massage onto clean skin.', 'Use twice daily.'],
      }),
    );

    const factHeadings = factsModule?.data?.sections?.map((section) => section.heading) || [];
    expect(factHeadings).toEqual(['Clinical Results']);
    expect(detailsModule?.data?.sections).toEqual([
      expect.objectContaining({
        heading: 'Description',
        content: 'A barrier-supporting cream designed for dry, reactive skin.',
      }),
    ]);
    expect(factHeadings).not.toContain('Ingredients');
    expect(factHeadings).not.toContain('How to Use');
  });

  test('falls back to PDP raw text when structured arrays are missing', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'p_structured_2',
        merchant_id: 'm_structured_2',
        title: 'Brightening Fluid',
        image_url: 'https://cdn.example.com/fluid.jpg',
        price: { amount: 42, currency: 'USD' },
        pdp_ingredients_raw: 'Water, Niacinamide, Glycerin',
        pdp_active_ingredients_raw: 'Niacinamide, Glycerin',
        pdp_how_to_use_raw: 'Apply after cleansing; follow with moisturizer.',
        details_sections: [
          { heading: 'Benefits', content: 'Supports visible brightness and hydration.' },
          { heading: 'Ingredients', content: 'Water, Niacinamide, Glycerin' },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(findModule(payload, 'ingredients_inci')?.data).toEqual(
      expect.objectContaining({
        raw_text: 'Water, Niacinamide, Glycerin',
        items: ['Water', 'Niacinamide', 'Glycerin'],
      }),
    );
    expect(findModule(payload, 'active_ingredients')?.data).toEqual(
      expect.objectContaining({
        raw_text: 'Niacinamide, Glycerin',
        items: ['Niacinamide', 'Glycerin'],
      }),
    );
    expect(findModule(payload, 'how_to_use')?.data).toEqual(
      expect.objectContaining({
        raw_text: 'Apply after cleansing; follow with moisturizer.',
      }),
    );
    expect(findModule(payload, 'product_facts')?.data?.sections).toEqual([
      expect.objectContaining({
        heading: 'Benefits',
        content: 'Supports visible brightness and hydration.',
      }),
    ]);
    expect(findModule(payload, 'product_details')).toBeFalsy();
  });

  test('does not render section-soup PDP descriptions as legacy overview copy', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'p_tom_ford_soup',
        merchant_id: 'external_seed',
        title: 'Shade and Illuminate Concealer',
        image_url: 'https://cdn.example.com/concealer.jpg',
        price: { amount: 95, currency: 'USD' },
        pdp_description_raw:
          'Details A full-coverage concealer with a soft matte finish. Benefits 24H wear and crease resistance. Coverage Medium to full. Finish Natural matte. How to Use Apply to targeted areas and blend. Ingredients Water, Dimethicone, Glycerin',
        pdp_details_sections: [
          {
            heading: 'Details',
            body:
              'Details A full-coverage concealer with a soft matte finish. Benefits 24H wear and crease resistance. Coverage Medium to full. Finish Natural matte.',
          },
          {
            heading: 'How to Use',
            body: 'Apply to targeted areas and blend.',
          },
          {
            heading: 'Ingredients',
            body: 'Water, Dimethicone, Glycerin',
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(payload.product.description).toBe(
      'A full-coverage concealer with a soft matte finish.',
    );
    expect(findModule(payload, 'product_details')?.data?.sections).toEqual([
      expect.objectContaining({
        heading: 'Description',
        content: 'A full-coverage concealer with a soft matte finish.',
      }),
    ]);
    expect(findModule(payload, 'product_facts')?.data?.sections).toEqual([
      expect.objectContaining({
        heading: 'Benefits',
        content: '24H wear and crease resistance.',
      }),
      expect.objectContaining({
        heading: 'Coverage',
        content: 'Medium to full.',
      }),
      expect.objectContaining({
        heading: 'Finish',
        content: 'Natural matte.',
      }),
    ]);
    expect(findModule(payload, 'how_to_use')?.data?.steps).toEqual([
      'Apply to targeted areas and blend.',
    ]);
    expect(findModule(payload, 'ingredients_inci')?.data?.items).toEqual([
      'Water',
      'Dimethicone',
      'Glycerin',
    ]);
    expect(JSON.stringify(findModule(payload, 'product_details'))).not.toContain('Benefits 24H wear');
  });

  test('merges merchant FAQ and review-derived questions into reviews preview', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'p_reviews_faq',
        merchant_id: 'external_seed',
        title: 'Glow Replenishing Rice Milk',
        image_url: 'https://cdn.example.com/rice-milk.jpg',
        price: { amount: 14.4, currency: 'USD' },
        pdp_faq_items: [
          {
            question: 'Can I use this every day?',
            answer: 'Yes, it is gentle enough for daily use.',
            source_kind: 'merchant_faq',
          },
        ],
        review_summary: {
          scale: 5,
          rating: 4.7,
          review_count: 126,
          preview_items: [
            {
              review_id: 'r1',
              title: 'Can I use this every day?',
              text: 'Yes, I use it morning and night and it stays lightweight.',
            },
            {
              review_id: 'r2',
              title: 'Can I use this every day?',
              text: 'Yes, I use it every day and it feels gentle on oily skin.',
            },
          ],
        },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(findModule(payload, 'reviews_preview')?.data?.questions).toEqual([
      expect.objectContaining({
        question: 'Can I use this every day?',
        answer: 'Yes, it is gentle enough for daily use.',
        source: 'merchant_faq',
        source_label: 'Official FAQ',
      }),
    ]);
  });
});
