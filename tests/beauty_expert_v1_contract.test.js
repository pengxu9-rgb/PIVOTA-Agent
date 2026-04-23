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
});
