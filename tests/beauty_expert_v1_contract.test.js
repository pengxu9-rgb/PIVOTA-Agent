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

  test('guided beauty reco compare axes collapse long niacinamide reasons into a stable treatment label', () => {
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
        raw_user_goal: 'what should I use for my skin?',
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'beauty',
      },
      payload: {
        search: {
          query: 'what should I use for my skin?',
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
});
