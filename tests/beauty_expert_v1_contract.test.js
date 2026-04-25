const {
  buildBeautyExpertV1Response,
  attachBeautyExpertV1ToResponse,
} = require('../src/modules/orchestration/aurora_beauty/beautyExpertV1');
const {
  handleAuroraBeautyOrchestration,
} = require('../src/modules/orchestration/aurora_beauty');

describe('beauty_expert_v1 contract', () => {
  test('builds a normalized compare response from grounded beauty products', () => {
    const result = buildBeautyExpertV1Response({
      source: 'shopping_agent',
      entryLayer: 'orchestration',
      delegatedLayer: 'decisioning',
      taskType: 'discovery',
      context: {
        source_profile: {
          source: 'shopping_agent',
          default_entry_layer: 'decisioning',
        },
        vertical: 'beauty',
        category: 'skincare',
        raw_user_goal: 'I have oily skin, what sunscreen should I buy?',
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'beauty',
      },
      payload: {
        search: {
          query: 'I have oily skin, what sunscreen should I buy?',
        },
      },
      response: {
        products: [
          {
            id: 'sku_1',
            merchant_id: 'm_1',
            title: 'Fluid Sunscreen',
            why_this_one: 'Keeps the finish lighter and smoother under makeup.',
          },
          {
            id: 'sku_2',
            merchant_id: 'm_2',
            title: 'Matte Sunscreen',
            why_this_one: 'Leans more matte and shine-controlling if you want less slip.',
          },
        ],
        metadata: {
          mainline_status: 'grounded_success',
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
        },
      },
    });

    expect(result.contract_version).toBe('beauty_expert_v1');
    expect(result.mode).toBe('category_compare');
    expect(result.reco_bundle.lead_picks).toHaveLength(1);
    expect(result.reco_bundle.support_picks).toHaveLength(1);
    expect(result.compare_axes.length).toBeGreaterThan(0);
    expect(result.next_actions.map((action) => action.type)).toContain('compare_same_type');
  });

  test('keeps balanced lead tradeoffs out of the matte axis bucket', () => {
    const result = buildBeautyExpertV1Response({
      source: 'shopping_agent',
      entryLayer: 'orchestration',
      delegatedLayer: 'decisioning',
      taskType: 'discovery',
      context: {
        source_profile: {
          source: 'shopping_agent',
          default_entry_layer: 'decisioning',
        },
        vertical: 'beauty',
        category: 'skincare',
        raw_user_goal: 'I have oily skin, what sunscreen should I buy?',
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'beauty',
      },
      payload: {
        search: {
          query: 'I have oily skin, what sunscreen should I buy?',
        },
      },
      response: {
        products: [
          {
            id: 'sku_lead',
            merchant_id: 'm_1',
            title: 'Balanced Sunscreen',
            why_this_one:
              'Keeps the finish lighter and smoother under makeup when you do not want to go too dewy or too matte.',
          },
          {
            id: 'sku_matte',
            merchant_id: 'm_2',
            title: 'Matte Sunscreen',
            why_this_one: 'Leans more matte and shine-controlling if you want less slip.',
          },
          {
            id: 'sku_dewy',
            merchant_id: 'm_3',
            title: 'Dewy Sunscreen',
            why_this_one: 'Leans fresher and dewier if you want a bit more hydration.',
          },
        ],
        metadata: {
          mainline_status: 'grounded_success',
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
        },
      },
    });

    expect(result.compare_axes.map((axis) => axis.label)).toEqual([
      'lighter / smoother finish',
      'matte / shine control',
      'more hydration / dewier finish',
    ]);
  });

  test('explicit beauty compare keeps stable axes even when reasons are long-form', () => {
    const result = buildBeautyExpertV1Response({
      source: 'shopping_agent',
      entryLayer: 'orchestration',
      delegatedLayer: 'decisioning',
      taskType: 'discovery',
      context: {
        source_profile: {
          source: 'shopping_agent',
          default_entry_layer: 'decisioning',
        },
        vertical: 'beauty',
        category: 'skincare',
        raw_user_goal: 'I have oily skin. What serum should I buy?',
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'beauty',
      },
      payload: {
        search: {
          query: 'I have oily skin. What serum should I buy?',
        },
      },
      response: {
        products: [
          {
            id: 'sku_treatment',
            merchant_id: 'm_1',
            title: 'Niacinamide Serum',
            why_this_one:
              'This serum contains a high concentration of niacinamide (vitamin B3) and zinc PCA to support the skin barrier while helping balance oil.',
          },
          {
            id: 'sku_moisturizer',
            merchant_id: 'm_2',
            title: 'Barrier Lotion',
            why_this_one: 'Adds more hydration and barrier support in a lightweight daily lotion.',
          },
          {
            id: 'sku_spf',
            merchant_id: 'm_3',
            title: 'Sun Serum',
            why_this_one: 'Provides a serum-like sunscreen texture with SPF 50+ protection.',
          },
        ],
        metadata: {
          mainline_status: 'grounded_success',
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
        },
      },
    });

    expect(result.compare_axes.map((axis) => axis.label)).toEqual([
      'targeted treatment / balancing serum',
      'more hydration / dewier finish',
      'serum-like / thinner feel',
    ]);
  });

  test('dedupes deal/subscription variants and builds axes from product titles when reasons are missing', () => {
    const result = buildBeautyExpertV1Response({
      source: 'shopping_agent',
      entryLayer: 'orchestration',
      delegatedLayer: 'decisioning',
      taskType: 'discovery',
      context: {
        source_profile: {
          source: 'shopping_agent',
          default_entry_layer: 'decisioning',
        },
        vertical: 'beauty',
        category: 'skincare',
        raw_user_goal: 'I have oily skin, what sunscreen should I buy?',
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'beauty',
      },
      payload: {
        search: {
          query: 'I have oily skin, what sunscreen should I buy?',
        },
      },
      response: {
        products: [
          {
            product_id: 'ext_roundlab_mild',
            merchant_id: 'external_seed',
            title: 'Birch Mild-Up Sunscreen UVLock SPF 50+ Broad Spectrum',
            brand: 'Round Lab',
            price: 25,
            currency: 'USD',
          },
          {
            product_id: 'ext_roundlab_mild_deal',
            merchant_id: 'external_seed',
            title: '[DEAL] Birch Mild-Up Sunscreen UVLock SPF 50+ Broad Spectrum',
            brand: 'Round Lab',
            price: 22,
            currency: 'USD',
          },
          {
            product_id: 'ext_roundlab_moisturizing',
            merchant_id: 'external_seed',
            title: 'Birch Moisturizing Sunscreen UVLock SPF 45+ Broad Spectrum [Subscription]',
            brand: 'Round Lab',
            price: 26,
            currency: 'USD',
          },
          {
            product_id: 'ext_roundlab_moisturizing_clean',
            merchant_id: 'external_seed',
            title: 'Birch Moisturizing Sunscreen UVLock SPF 45+ Broad Spectrum',
            brand: 'Round Lab',
            price: 27,
            currency: 'USD',
          },
        ],
        metadata: {
          mainline_status: 'grounded_success',
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
        },
      },
    });

    expect([
      ...result.reco_bundle.lead_picks,
      ...result.reco_bundle.support_picks,
    ].map((product) => product.name)).toEqual([
      'Birch Mild-Up Sunscreen UVLock SPF 50+ Broad Spectrum',
      'Birch Moisturizing Sunscreen UVLock SPF 45+ Broad Spectrum',
    ]);
    expect(result.compare_axes.length).toBeGreaterThan(0);
  });

  test('replaces generic invoke reply with neutral beauty expert comparison copy', () => {
    const result = attachBeautyExpertV1ToResponse(
      {
        reply: 'Here are some more suitable picks based on your request.',
        products: [
          {
            product_id: 'sku_1',
            merchant_id: 'm_1',
            title: 'Fluid Sunscreen',
            brand: 'Demo',
            price: 18,
            currency: 'USD',
            why_this_one: 'Lighter sunscreen texture for oily skin under makeup.',
          },
          {
            product_id: 'sku_2',
            merchant_id: 'm_2',
            title: 'Matte Sunscreen',
            brand: 'Demo',
            price: 22,
            currency: 'USD',
            why_this_one: 'More matte finish if shine control is the priority.',
          },
        ],
        metadata: {
          mainline_status: 'grounded_success',
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
        },
      },
      {
        source: 'shopping_agent',
        entryLayer: 'orchestration',
        delegatedLayer: 'decisioning',
        taskType: 'discovery',
        context: {
          vertical: 'beauty',
          category: 'skincare',
          raw_user_goal: 'I have oily skin, what sunscreen should I buy?',
        },
        metadata: {
          source: 'shopping_agent',
          catalog_surface: 'beauty',
        },
        payload: {
          search: {
            query: 'I have oily skin, what sunscreen should I buy?',
          },
        },
      },
    );

    expect(result.reply).toContain('Fluid Sunscreen is the current lead because');
    expect(result.reply).toContain('Compared with it');
    expect(result.reply).not.toBe('Here are some more suitable picks based on your request.');
  });

  test('does not project long PDP descriptions into visible invoke copy or compare axes', () => {
    const result = attachBeautyExpertV1ToResponse(
      {
        reply: 'Here are some more suitable picks based on your request.',
        products: [
          {
            product_id: 'spf_1',
            merchant_id: 'm_1',
            title: 'Weightless Daily Sunscreen SPF 50',
            price: 22,
            currency: 'USD',
            description:
              'Full ingredient list and product details: water, glycerin, niacinamide, multiple copied storefront paragraphs, how to use directions, repeated marketing copy, clinical study references, and a long PDP block that should never become assistant text.',
          },
          {
            product_id: 'spf_2',
            merchant_id: 'm_2',
            title: 'Matte Daily Sunscreen SPF 50',
            price: 18,
            currency: 'USD',
            short_description:
              'This is a very long storefront description with product details, how to use directions, ingredient list, copied PDP language, and enough extra words to look like raw catalog copy rather than a reviewed reason.',
          },
        ],
        metadata: {
          mainline_status: 'grounded_success',
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
        },
      },
      {
        source: 'shopping_agent',
        entryLayer: 'orchestration',
        delegatedLayer: 'decisioning',
        taskType: 'discovery',
        context: {
          vertical: 'beauty',
          category: 'skincare',
          raw_user_goal: 'I have oily skin, what sunscreen should I buy?',
        },
        metadata: {
          source: 'shopping_agent',
          catalog_surface: 'beauty',
        },
        payload: {
          search: {
            query: 'I have oily skin, what sunscreen should I buy?',
          },
        },
      },
    );

    expect(result.reply).toContain(
      'Weightless Daily Sunscreen SPF 50 is the current lead because it matches the sunscreen role',
    );
    expect(result.reply).toContain('it is listed around USD 22');
    expect(result.reply).not.toMatch(/Full ingredient|product details|clinical study|how to use|copied PDP/i);
    expect(result.reply.length).toBeLessThan(450);
    expect(result.beauty_expert_v1.reco_bundle.lead_picks[0].why_this_one).toBeUndefined();
    expect(result.beauty_expert_v1.compare_axes.map((axis) => axis.label).join(' ')).not.toMatch(
      /Full ingredient|product details|clinical study|how to use|copied PDP/i,
    );
  });

  test('context-rich beauty follow-up with products exits guided mode even without repeating category words', () => {
    const result = buildBeautyExpertV1Response({
      source: 'shopping_agent',
      entryLayer: 'orchestration',
      delegatedLayer: 'decisioning',
      taskType: 'discovery',
      context: {
        source_profile: {
          source: 'shopping_agent',
          default_entry_layer: 'decisioning',
        },
        vertical: 'beauty',
        category: 'skincare',
        normalized_need: {
          beauty_request: {
            domain: 'beauty',
            user_goal: 'Combination skin, clogged pores, Seattle winter, simple routine.',
            skin_context: {
              skin_type: 'combination',
              concerns: ['clogged pores'],
            },
            scenario_context: {
              location: 'Seattle',
              season: 'winter',
            },
          },
        },
      },
      metadata: {
        source: 'shopping_agent',
        beauty_domain_hint: 'beauty',
      },
      payload: {
        search: {
          query: 'Combination skin, clogged pores, Seattle winter, simple routine.',
        },
      },
      response: {
        products: [
          {
            id: 'sku_1',
            merchant_id: 'm_1',
            title: 'Niacinamide Serum',
            why_this_one: 'Affordable oil-balancing treatment direction for clogged pores.',
          },
          {
            id: 'sku_2',
            merchant_id: 'm_2',
            title: 'Light Water Cream',
            why_this_one: 'Lightweight moisturizer support for a simple routine.',
          },
        ],
        metadata: {
          mainline_status: 'grounded_success',
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
        },
      },
    });

    expect(result.mode).toBe('category_compare');
    expect(result.reco_bundle.lead_picks).toHaveLength(1);
    expect(result.next_actions.map((action) => action.type)).toContain('compare_same_type');
  });

  test('plural category wording keeps creator follow-ups in category compare', () => {
    const result = buildBeautyExpertV1Response({
      source: 'creator_agent',
      entryLayer: 'orchestration',
      delegatedLayer: 'decisioning',
      taskType: 'discovery',
      context: {
        source_profile: {
          source: 'creator_agent',
          default_entry_layer: 'decisioning',
        },
        vertical: 'beauty',
        category: 'skincare',
        normalized_need: {
          beauty_request: {
            domain: 'beauty',
            user_goal: 'Recommend beginner-friendly moisturizers for dry sensitive users who use retinoids.',
            skin_context: {
              skin_type: 'dry sensitive',
            },
            routine_context: {
              audience_actives: ['retinoids'],
            },
          },
        },
      },
      metadata: {
        source: 'creator_agent',
        beauty_domain_hint: 'beauty',
      },
      payload: {
        search: {
          query: 'They are mostly beginners and some use retinoids.',
        },
      },
      response: {
        products: [
          {
            id: 'sku_1',
            merchant_id: 'm_1',
            title: 'Barrier Lotion',
            why_this_one: 'Barrier-supporting lotion direction for retinoid-stressed skin.',
          },
          {
            id: 'sku_2',
            merchant_id: 'm_2',
            title: 'Simple Daily Moisturizer',
            why_this_one: 'Lower-cost simple moisturizer for beginners.',
          },
        ],
        metadata: {
          mainline_status: 'grounded_success',
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
        },
      },
    });

    expect(result.mode).toBe('category_compare');
  });

  test('aurora orchestration emits beauty_expert_v1 and persists beauty_request into context', async () => {
    const result = await handleAuroraBeautyOrchestration({
      context: {
        source_profile: {
          source: 'creator_agent',
          default_entry_layer: 'decisioning',
        },
        vertical: 'beauty',
        category: 'skincare',
      },
      messages: [{ role: 'user', content: 'my audience has dry sensitive skin, what moisturizer should I recommend?' }],
    });

    expect(result.layer).toBe('orchestration');
    expect(result.beauty_expert_v1).toBeTruthy();
    expect(result.updated_context.normalized_need.beauty_request.domain).toBe('beauty');
    expect(result.next_actions.length).toBeGreaterThan(0);
  });

  test('under-specified beauty asks stay in guided_beauty_reco and suggest skin analysis', async () => {
    const result = await handleAuroraBeautyOrchestration({
      context: {
        source_profile: {
          source: 'shopping_agent',
          default_entry_layer: 'decisioning',
        },
        vertical: 'beauty',
        category: 'skincare',
      },
      messages: [{ role: 'user', content: 'what should I use for my skin?' }],
    });

    expect(result.beauty_expert_v1).toBeTruthy();
    expect(result.beauty_expert_v1.mode).toBe('guided_beauty_reco');
    expect(result.next_actions.map((action) => action.type)).toContain('consider_skin_analysis');
  });

  test('product_context anchored beauty asks resolve to exact_product_assist', () => {
    const result = buildBeautyExpertV1Response({
      source: 'shopping_agent',
      entryLayer: 'orchestration',
      delegatedLayer: 'execution_facing',
      taskType: 'discovery',
      context: {
        source_profile: {
          source: 'shopping_agent',
          default_entry_layer: 'decisioning',
        },
        vertical: 'beauty',
        category: 'skincare',
        normalized_need: {
          beauty_request: {
            domain: 'beauty',
            user_goal: 'Is Beauty of Joseon Relief Sun Aqua-Fresh good for oily skin under makeup?',
            product_context: {
              canonical_product_ref: 'boj_relief_sun_aqua_fresh',
              title: 'Beauty of Joseon Relief Sun Aqua-Fresh',
            },
          },
        },
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'beauty',
      },
      payload: {
        search: {
          query: 'Is Beauty of Joseon Relief Sun Aqua-Fresh good for oily skin under makeup?',
        },
      },
      response: {
        products: [
          {
            id: 'sku_1',
            merchant_id: 'm_1',
            title: 'Beauty of Joseon Relief Sun Aqua-Fresh',
            why_this_one: 'Keeps the finish lighter and smoother under makeup.',
          },
        ],
        metadata: {
          mainline_status: 'grounded_success',
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
        },
      },
    });

    expect(result.mode).toBe('exact_product_assist');
    expect(result.reco_bundle.lead_picks).toHaveLength(1);
    expect(result.next_actions.map((action) => action.type)).toContain('open_pdp');
  });

  test('exact_product_assist reorders the normalized lead pick to the anchored product', () => {
    const result = buildBeautyExpertV1Response({
      source: 'aurora-bff',
      entryLayer: 'orchestration',
      delegatedLayer: 'decisioning',
      taskType: 'discovery',
      context: {
        source_profile: {
          source: 'aurora-bff',
          default_entry_layer: 'orchestration',
        },
        vertical: 'beauty',
        category: 'skincare',
        normalized_need: {
          beauty_request: {
            domain: 'beauty',
            user_goal: 'I use tretinoin. Is Ultra Repair Face Lotion a better next moisturizer than a peptide cream?',
            routine_context: {
              actives: ['tretinoin'],
            },
            product_context: {
              canonical_product_ref: 'ultra repair face lotion',
            },
          },
        },
      },
      metadata: {
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      },
      payload: {
        search: {
          query: 'I use tretinoin. Is Ultra Repair Face Lotion a better next moisturizer than a peptide cream?',
        },
      },
      response: {
        cards: [
          {
            type: 'recommendations',
            sections: [
              {
                products: [
                  {
                    product_id: 'firming_cream',
                    merchant_id: 'm_1',
                    name: 'Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen',
                    why_this_one: 'A moisturizer for dryness or barrier support.',
                  },
                  {
                    product_id: 'face_lotion',
                    merchant_id: 'm_2',
                    name: 'Ultra Repair Face Lotion with Colloidal Oatmeal',
                    why_this_one: 'Adds more calming barrier-comfort cues for dry, tight, or easily irritated skin.',
                  },
                ],
              },
            ],
          },
        ],
        metadata: {
          mainline_status: 'grounded_success',
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
        },
      },
    });

    expect(result.mode).toBe('exact_product_assist');
    expect(result.reco_bundle.lead_picks[0]?.name).toBe('Ultra Repair Face Lotion with Colloidal Oatmeal');
    expect(result.reco_bundle.support_picks[0]?.name).toBe(
      'Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen',
    );
  });

  test('guided beauty reco with missing context suppresses opportunistic products and polluted compare axes', () => {
    const result = buildBeautyExpertV1Response({
      source: 'creator_agent',
      entryLayer: 'orchestration',
      delegatedLayer: 'decisioning',
      taskType: 'discovery',
      context: {
        source_profile: {
          source: 'creator_agent',
          default_entry_layer: 'decisioning',
        },
        vertical: 'beauty',
        category: 'skincare',
        raw_user_goal: 'What should I use for my skin?',
      },
      metadata: {
        source: 'creator_agent',
        catalog_surface: 'beauty',
      },
      payload: {
        search: {
          query: 'What should I use for my skin?',
        },
      },
      response: {
        products: [
          {
            id: 'sku_bad',
            merchant_id: 'm_bad',
            title: 'Some Serum',
            why_this_one:
              '<div><strong>Soft wash to smoky eye.</strong> Synthetic fibers with pouch and ingredients list copied from a fixture.</div>',
          },
          {
            id: 'sku_ok',
            merchant_id: 'm_ok',
            title: 'Barrier Lotion',
            why_this_one: 'Adds more hydration and barrier support in a lightweight daily lotion.',
          },
        ],
        metadata: {
          mainline_status: 'grounded_success',
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
        },
      },
    });

    expect(result.mode).toBe('guided_beauty_reco');
    expect(result.analysis_summary.missing_context.length).toBeGreaterThan(0);
    expect(result.reco_bundle.lead_picks).toHaveLength(0);
    expect(result.reco_bundle.support_picks).toHaveLength(0);
    expect(result.compare_axes).toHaveLength(0);
    expect(result.next_actions.map((action) => action.type)).toEqual(
      expect.arrayContaining(['consider_skin_analysis', 'ask_missing_constraint']),
    );
    expect(result.next_actions.map((action) => action.type)).not.toEqual(
      expect.arrayContaining(['compare_same_type', 'show_alternatives']),
    );
  });

  test('attachBeautyExpertV1ToResponse annotates chat/search envelopes without dropping existing fields', () => {
    const result = attachBeautyExpertV1ToResponse(
      {
        assistant_message: { role: 'assistant', content: 'Use the lighter option first.' },
        cards: [
          {
            type: 'recommendations',
            sections: [
              {
                products: [
                  {
                    product_id: 'sku_1',
                    merchant_id: 'm_1',
                    name: 'Daily Sunscreen',
                    why_this_one: 'Keeps the finish lighter and smoother under makeup.',
                  },
                ],
              },
            ],
          },
        ],
        meta: {},
      },
      {
        source: 'aurora-bff',
        entryLayer: 'orchestration',
        delegatedLayer: 'decisioning',
        projectionType: 'aurora_cards',
        context: {
          source_profile: { source: 'aurora-bff', default_entry_layer: 'orchestration' },
          vertical: 'beauty',
          category: 'skincare',
          raw_user_goal: 'what sunscreen should I use?',
        },
        metadata: { catalog_surface: 'beauty' },
        payload: { message: 'what sunscreen should I use?' },
        messages: [{ role: 'user', content: 'what sunscreen should I use?' }],
      },
    );

    expect(result.assistant_message.content).toBe('Use the lighter option first.');
    expect(result.beauty_expert_v1.ui_projections.aurora_cards).toHaveLength(1);
    expect(result.meta.beauty_capability_invoked).toBe(true);
  });

  test('attachBeautyExpertV1ToResponse projects exact-product lead order back into aurora recommendation cards', () => {
    const result = attachBeautyExpertV1ToResponse(
      {
        cards: [
          {
            type: 'recommendations',
            payload: {
              recommendations: [
                {
                  product_id: 'firming_cream',
                  merchant_id: 'm_1',
                  name: 'Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen',
                  why_this_one: 'A moisturizer for dryness or barrier support.',
                },
                {
                  product_id: 'face_lotion',
                  merchant_id: 'm_2',
                  name: 'Ultra Repair Face Lotion with Colloidal Oatmeal',
                  why_this_one: 'Adds more calming barrier-comfort cues for dry, tight, or easily irritated skin.',
                },
              ],
            },
            sections: [
              {
                products: [
                  {
                    product_id: 'firming_cream',
                    merchant_id: 'm_1',
                    name: 'Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen',
                    why_this_one: 'A moisturizer for dryness or barrier support.',
                  },
                  {
                    product_id: 'face_lotion',
                    merchant_id: 'm_2',
                    name: 'Ultra Repair Face Lotion with Colloidal Oatmeal',
                    why_this_one: 'Adds more calming barrier-comfort cues for dry, tight, or easily irritated skin.',
                  },
                ],
              },
            ],
          },
        ],
        meta: {},
      },
      {
        source: 'aurora-bff',
        entryLayer: 'orchestration',
        projectionType: 'aurora_cards',
        taskType: 'discovery',
        context: {
          source_profile: { source: 'aurora-bff', default_entry_layer: 'orchestration' },
          vertical: 'beauty',
          category: 'skincare',
          normalized_need: {
            beauty_request: {
              domain: 'beauty',
              user_goal: 'I use tretinoin. Is Ultra Repair Face Lotion a better next moisturizer than a peptide cream?',
              routine_context: {
                actives: ['tretinoin'],
              },
              product_context: {
                canonical_product_ref: 'ultra repair face lotion',
              },
            },
          },
        },
        metadata: { catalog_surface: 'beauty' },
        payload: { message: 'I use tretinoin. Is Ultra Repair Face Lotion a better next moisturizer than a peptide cream?' },
        messages: [{ role: 'user', content: 'I use tretinoin. Is Ultra Repair Face Lotion a better next moisturizer than a peptide cream?' }],
      },
    );

    expect(result.beauty_expert_v1.mode).toBe('exact_product_assist');
    expect(result.cards[0].sections[0].products[0]?.name).toBe('Ultra Repair Face Lotion with Colloidal Oatmeal');
    expect(result.cards[0].payload.recommendations[0]?.name).toBe('Ultra Repair Face Lotion with Colloidal Oatmeal');
    expect(result.beauty_expert_v1.ui_projections.aurora_cards[0].sections[0].products[0]?.name).toBe(
      'Ultra Repair Face Lotion with Colloidal Oatmeal',
    );
  });

  test('attachBeautyExpertV1ToResponse suppresses stale exact-product assistant copy after lead projection', () => {
    const result = attachBeautyExpertV1ToResponse(
      {
        assistant_text:
          'You might consider the Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen because it supports barrier routines. If you prefer a lighter feel, the Ultra Repair Face Lotion with Colloidal Oatmeal offers immediate hydration.',
        assistant_message: {
          role: 'assistant',
          content:
            'You might consider the Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen because it supports barrier routines. If you prefer a lighter feel, the Ultra Repair Face Lotion with Colloidal Oatmeal offers immediate hydration.',
          format: 'text',
        },
        cards: [
          {
            type: 'recommendations',
            sections: [
              {
                products: [
                  {
                    product_id: 'firming_cream',
                    merchant_id: 'm_1',
                    name: 'Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen',
                    why_this_one: 'A moisturizer for dryness or barrier support.',
                  },
                  {
                    product_id: 'face_lotion',
                    merchant_id: 'm_2',
                    name: 'Ultra Repair Face Lotion with Colloidal Oatmeal',
                    why_this_one: 'Adds more calming barrier-comfort cues for dry, tight, or easily irritated skin.',
                  },
                ],
              },
            ],
          },
        ],
        meta: {},
      },
      {
        source: 'aurora-bff',
        entryLayer: 'orchestration',
        projectionType: 'aurora_cards',
        taskType: 'discovery',
        context: {
          source_profile: { source: 'aurora-bff', default_entry_layer: 'orchestration' },
          vertical: 'beauty',
          category: 'skincare',
          normalized_need: {
            beauty_request: {
              domain: 'beauty',
              user_goal: 'I use tretinoin. Is Ultra Repair Face Lotion a better next moisturizer than a peptide cream?',
              routine_context: {
                actives: ['tretinoin'],
              },
              product_context: {
                canonical_product_ref: 'ultra repair face lotion',
              },
            },
          },
        },
        metadata: { catalog_surface: 'beauty' },
        payload: { message: 'I use tretinoin. Is Ultra Repair Face Lotion a better next moisturizer than a peptide cream?' },
        messages: [{ role: 'user', content: 'I use tretinoin. Is Ultra Repair Face Lotion a better next moisturizer than a peptide cream?' }],
      },
    );

    expect(result.cards[0].sections[0].products[0]?.name).toBe('Ultra Repair Face Lotion with Colloidal Oatmeal');
    expect(result.assistant_message).toBeNull();
    expect(result.assistant_text).toBe('');
    expect(result.meta.assistant_visible_suppressed_reason).toBe('exact_product_projection_assistant_mismatch');
  });
});
