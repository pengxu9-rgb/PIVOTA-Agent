const { buildPdpPayload } = require('../src/pdpBuilder');

function findModule(payload, type) {
  return Array.isArray(payload?.modules)
    ? payload.modules.find((module) => module && module.type === type)
    : null;
}

describe('pdpBuilder structured PDP modules', () => {
  test('media_gallery keeps only the selected variant gallery when variant images are authoritative', () => {
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

    expect(urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QT01_3000x3000_0.png',
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T1QT01_2000x2000_1.jpg',
    ]);
    expect(urls.some((url) => url.includes('T1QW01'))).toBe(false);
    expect(urls.some((url) => url.includes('plpbanner'))).toBe(false);
  });

  test('media_gallery keeps external seed product gallery when size variants share one image', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_boj_daily_tinted',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Daily Tinted Fluid Sunscreen DN350',
        image_url:
          'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg',
        image_urls: [
          'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg',
          'https://beautyofjoseon.com/cdn/shop/files/Untitled_design_95.jpg?width=180',
          'https://beautyofjoseon.com/cdn/shop/files/skin_prep_dry_skin.png?width=180',
        ],
        variants: [
          {
            variant_id: '52402575442292',
            title: '1.69 fl. oz. (50ml)',
            image_url:
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg',
            price: { amount: 10, currency: 'USD' },
          },
          {
            variant_id: '52402575475060',
            title: '0.23 fl. oz. (7ml)',
            image_url:
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg',
            price: { amount: 2, currency: 'USD' },
          },
        ],
        price: { amount: 10, currency: 'USD' },
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    const mediaGallery = findModule(payload, 'media_gallery');
    const urls = Array.isArray(mediaGallery?.data?.items)
      ? mediaGallery.data.items.map((item) => item.url)
      : [];

    expect(urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg',
      'https://beautyofjoseon.com/cdn/shop/files/Untitled_design_95.jpg',
      'https://beautyofjoseon.com/cdn/shop/files/skin_prep_dry_skin.png',
    ]);
    expect(payload.product.image_urls).toEqual(urls);
    expect(payload.product.images).toEqual(urls);
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
    const overviewModule = findModule(payload, 'product_overview');

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
    expect(overviewModule?.data?.sections).toEqual([
      expect.objectContaining({
        heading: 'Description',
        content: 'A barrier-supporting cream designed for dry, reactive skin.',
      }),
    ]);
    expect(findModule(payload, 'product_details')).toBeFalsy();
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

  test('keeps structured PDP sections when raw captured description is narrative soup', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_boj_text_soup',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Daily Tinted Fluid Sunscreen DN350',
        category: 'Sunscreen',
        image_url: 'https://cdn.example.com/daily-tinted.jpg',
        price: { amount: 10, currency: 'USD' },
        pdp_description_raw: [
          'Rice-Infused Hydration',
          'This formula helps hydrate.',
          '',
          'Secret Sebum-Control Layer',
          'The fluid helps control sebum.',
          '',
          'How to Use',
          'Shake well and apply as the last skincare step.',
        ].join('\n'),
        pdp_details_sections: [
          { heading: 'Rice-Infused Hydration', body: 'This formula helps hydrate.', source_kind: 'custom_pdp' },
          { heading: 'Secret Sebum-Control Layer', body: 'The fluid helps control sebum.', source_kind: 'custom_pdp' },
          { heading: 'How to Use', body: 'Shake well and apply as the last skincare step.', source_kind: 'custom_pdp' },
          { heading: 'Clinical Results', body: 'User test results after two weeks.', source_kind: 'custom_pdp' },
        ],
        pdp_how_to_use_raw: 'Shake well and apply as the last skincare step.',
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(payload.product.description).toBe('This formula helps hydrate.');
    expect(findModule(payload, 'product_overview')?.data?.sections).toEqual([
      expect.objectContaining({
        heading: 'Description',
        content: 'This formula helps hydrate.',
      }),
    ]);
    expect(findModule(payload, 'supplemental_details')?.data?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'Secret Sebum-Control Layer',
          content: 'The fluid helps control sebum.',
        }),
        expect.objectContaining({
          heading: 'Category',
          content: 'Sunscreen',
        }),
      ]),
    );
    expect(findModule(payload, 'product_details')).toBeFalsy();
    expect(findModule(payload, 'product_facts')?.data?.sections).toEqual([
      expect.objectContaining({
        heading: 'Clinical Results',
        content: 'User test results after two weeks.',
      }),
    ]);
    expect(findModule(payload, 'how_to_use')?.data).toEqual(
      expect.objectContaining({
        raw_text: 'Shake well and apply as the last skincare step.',
      }),
    );
  });

  test('treats prefixed how-to headings as structured modules instead of supplemental details', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_boj_prefixed_howto',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Daily Tinted Fluid Sunscreen DN350',
        category: 'Sunscreen',
        image_url: 'https://cdn.example.com/daily-tinted-prefixed.jpg',
        price: { amount: 10, currency: 'USD' },
        pdp_description_raw: 'Meet the Tint + SPF You’ll Actually Wear\nA breathable tinted sunscreen.',
        pdp_details_sections: [
          {
            heading: 'Meet the Tint + SPF You’ll Actually Wear',
            body: 'A breathable tinted sunscreen.',
            source_kind: 'custom_pdp',
          },
          {
            heading: 'How to Use DTFS the Right Way',
            body: 'Shake well before use. Apply in layers and wait 5 minutes.',
            source_kind: 'custom_pdp',
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(findModule(payload, 'how_to_use')?.data).toEqual(
      expect.objectContaining({
        raw_text: 'Shake well before use. Apply in layers and wait 5 minutes.',
      }),
    );
    expect(findModule(payload, 'supplemental_details')?.data?.sections || []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'How to Use',
        }),
      ]),
    );
    expect(findModule(payload, 'supplemental_details')?.data?.sections || []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: 'How to Use DTFS the Right Way',
        }),
      ]),
    );
  });

  test('renders a clean captured external seed PDP description as overview details', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_boj_clean_description',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'Calming Barrier Serum',
        category: 'Serum',
        image_url: 'https://cdn.example.com/calming-serum.jpg',
        price: { amount: 12.75, currency: 'USD' },
        pdp_description_raw: [
          'Intense Hydration, Instant Calm',
          'When your complexion calls for extra support, a few drops of Calming Barrier Serum will bring it back in balance.',
        ].join('\n'),
        pdp_details_sections: [
          {
            heading: 'Intense Hydration, Instant Calm',
            body: 'When your complexion calls for extra support, a few drops of Calming Barrier Serum will bring it back in balance.',
            source_kind: 'custom_pdp',
          },
          {
            heading: 'How to Use',
            body: 'Pat gently after toner.',
            source_kind: 'custom_pdp',
          },
          {
            heading: 'Ingredients',
            body: 'Water, 1,2-Hexanediol, Glycerin',
            source_kind: 'custom_pdp',
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(findModule(payload, 'product_overview')?.data?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        heading: 'Description',
        content:
          'When your complexion calls for extra support, a few drops of Calming Barrier Serum will bring it back in balance.',
      }),
    ]));
    expect(findModule(payload, 'product_details')).toBeFalsy();
    expect(findModule(payload, 'product_facts')).toBeFalsy();
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
            question: 'NEED HELP? NEED HELP?',
            answer: 'TRACK MY ORDER SERVICES SHIPPING & RETURNS FAQS STORE LOCATOR CONTACT US',
            source_kind: 'merchant_faq',
            source_url: 'https://example.com/pages/faqs',
          },
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

  test('allows merchant PDP FAQ sections whose source title is FAQ', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'p_reviews_faq_title',
        merchant_id: 'external_seed',
        title: 'Daily Tinted Fluid Sunscreen',
        image_url: 'https://cdn.example.com/daily-tinted.jpg',
        price: { amount: 18, currency: 'USD' },
        pdp_faq_items: [
          {
            question: 'Is it suitable for daily use?',
            answer: 'Yes. Apply it as the last step of your morning skincare routine.',
            source_kind: 'merchant_faq',
            source_title: 'FAQ',
            source_url: 'https://merchant.example/products/daily-tinted-fluid-sunscreen',
          },
        ],
      },
      relatedProducts: [],
      entryPoint: 'agent',
    });

    expect(findModule(payload, 'reviews_preview')?.data?.questions).toEqual([
      expect.objectContaining({
        question: 'Is it suitable for daily use?',
        source: 'merchant_faq',
        source_label: 'Official FAQ',
      }),
    ]);
  });
});
