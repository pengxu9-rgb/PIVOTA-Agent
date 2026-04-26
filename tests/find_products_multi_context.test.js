const { buildFindProductsMultiContext } = require('../src/findProductsMulti/policy');
const { extractIntentRuleBased } = require('../src/findProductsMulti/intent');

describe('find_products_multi context building', () => {
  test('uses last user message as query when search.query is empty', async () => {
    const { intent, adjustedPayload, rawUserQuery } = await buildFindProductsMultiContext({
      payload: {
        search: { query: '' },
        user: { recent_queries: ['Labubu doll clothes'] },
        messages: [
          { role: 'assistant', content: 'Hi!' },
          {
            role: 'user',
            content:
              'Voy a ir de senderismo con mi perro este fin de semana. Va a hacer frío, por favor encuentra ropa adecuada para mi perro.',
          },
        ],
      },
      metadata: {},
    });

    expect(rawUserQuery).toContain('senderismo');
    expect(intent.language).toBe('es');
    expect(intent.target_object.type).toBe('pet');
    expect(String(adjustedPayload.search.query)).toContain('perro');
  });

  test('sexy outfit query expands to lingerie/dress (not outerwear)', async () => {
    const { intent, adjustedPayload } = await buildFindProductsMultiContext({
      payload: {
        search: { query: '当天晚上要给女朋友一个惊喜，准备一套性感的衣服送给她，推荐一些' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: '当天晚上要给女朋友一个惊喜，准备一套性感的衣服送给她，推荐一些' }],
      },
      metadata: {},
    });

    expect(intent.target_object.type).toBe('human');
    expect(intent.primary_domain).toBe('human_apparel');
    expect(intent.scenario.name).toBe('sexy_outfit');

    const q = String(adjustedPayload.search.query || '');
    expect(q.toLowerCase()).toContain('lingerie');
    expect(q.toLowerCase()).not.toContain('outerwear');
    expect(q.toLowerCase()).not.toContain('coat jacket outerwear');
  });

  test('toy request overrides prior beauty history (no accidental cosmetic tools)', async () => {
    const intent = extractIntentRuleBased(
      'Show me some pink toys',
      [],
      [{ role: 'user', content: 'makeup brush set for foundation and powder' }],
    );
    expect(intent.primary_domain).toBe('toy_accessory');
    expect(intent.target_object.type).toBe('toy');
  });

  test('toy follow-up keeps toy mission from recent queries', async () => {
    const intent = extractIntentRuleBased(
      'I want a pajama, the color is green',
      ['Show me some pink toys'],
      [],
    );
    expect(intent.primary_domain).toBe('toy_accessory');
    expect(intent.target_object.type).toBe('toy');
  });

  test('toy follow-up prefers message mission over older recent queries', async () => {
    const intent = extractIntentRuleBased(
      'I want a pajama, the color is green',
      ['makeup brush set for foundation and powder'],
      [
        { role: 'user', content: 'Show me some pink toys' },
        { role: 'assistant', content: 'Sure—here are some options.' },
        { role: 'user', content: 'I want a pajama, the color is green' },
      ],
    );
    expect(intent.primary_domain).toBe('toy_accessory');
    expect(intent.target_object.type).toBe('toy');
  });

  test('pet follow-up keeps pet mission from chat messages (breed-only follow-up)', async () => {
    const intent = extractIntentRuleBased(
      '边牧的颜色是黑白的，帮我找点颜色鲜艳的款式',
      [],
      [
        { role: 'user', content: '我想买一件狗的衣服，我家养了一只边牧' },
        { role: 'assistant', content: '我找到了几件更符合你需求的选择。' },
        { role: 'user', content: '边牧的颜色是黑白的，帮我找点颜色鲜艳的款式' },
      ],
    );
    expect(intent.primary_domain).toBe('sports_outdoor');
    expect(intent.target_object.type).toBe('pet');
    expect(intent.scenario.name).toContain('pet');
  });

  test('dog leash query expands to harness/leash keywords (not jacket-only)', async () => {
    const { intent, adjustedPayload } = await buildFindProductsMultiContext({
      payload: {
        search: { query: '有没有狗链推荐？' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: '有没有狗链推荐？' }],
      },
      metadata: {},
    });

    expect(intent.target_object.type).toBe('pet');
    expect(intent.category.required).toEqual(expect.arrayContaining(['pet_harness']));
    const q = String(adjustedPayload?.search?.query || '').toLowerCase();
    expect(q).toContain('dog leash');
    expect(q).toContain('harness');
    expect(q).not.toContain('dog jacket');
  });

  test('pet apparel query blocks aggressive rewrite when query class is category', async () => {
    const { adjustedPayload, expansion_meta } = await buildFindProductsMultiContext({
      payload: {
        search: { query: '给我推荐狗狗外套' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: '给我推荐狗狗外套' }],
      },
      metadata: { expansion_mode: 'aggressive' },
    });

    const q = String(adjustedPayload?.search?.query || '').toLowerCase();
    expect(q).toContain('dog apparel');
    expect(q).not.toContain('dog jacket');
    expect(expansion_meta).toEqual(
      expect.objectContaining({
        mode: 'conservative',
        applied: true,
        rewrite_gate: expect.objectContaining({
          requested_mode: 'aggressive',
          mode: 'conservative',
        }),
      }),
    );
    expect(['aggressive_flag_disabled', 'query_class_not_supported']).toContain(
      String(expansion_meta?.rewrite_gate?.blocked_reason || ''),
    );
  });

  test('adds query_class to intent output', () => {
    const intent = extractIntentRuleBased('我今晚有个约会，要化妆，要推荐点商品吧？', [], []);
    expect(intent.query_class).toBe('scenario');
  });

  test('scenario association plan is exposed in context metadata', async () => {
    const { expansion_meta } = await buildFindProductsMultiContext({
      payload: {
        search: { query: '出差要带什么护肤品' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: '出差要带什么护肤品' }],
      },
      metadata: { expansion_mode: 'aggressive' },
    });

    expect(expansion_meta.query_class).toBe('mission');
    expect(expansion_meta.association_plan).toEqual(
      expect.objectContaining({
        domain_key: expect.any(String),
        scenario_key: expect.any(String),
      }),
    );
  });

  test('beauty tools conservative expansion stays compact and tool-scoped', async () => {
    const { adjustedPayload, expansion_meta } = await buildFindProductsMultiContext({
      payload: {
        search: { query: '推荐化妆刷' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: '推荐化妆刷' }],
      },
      metadata: {},
    });

    const q = String(adjustedPayload?.search?.query || '').toLowerCase();
    expect(q).toContain('makeup brush');
    expect(q).not.toContain('cosmetic tools');
    expect(q).not.toContain('makeup sponge');
    expect(String(expansion_meta?.mode || '')).toBe('conservative');
    expect(q.length).toBeLessThanOrEqual(160);
  });

  test('eye shadow brush query routes to dedicated scenario (no full-face kit)', async () => {
    const intent = extractIntentRuleBased('帮我挑一个画眼影的刷子', [], []);
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('eye_shadow_brush');
  });

  test('eye shadow brush follow-up keeps mission from messages', async () => {
    const intent = extractIntentRuleBased('想要自然一点的晕染', [], [
      { role: 'user', content: '帮我挑一个画眼影的刷子' },
      { role: 'assistant', content: '好的，我先问你两个问题。' },
      { role: 'user', content: '想要自然一点的晕染' },
    ]);
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('eye_shadow_brush');
  });

  test('brand/product lookup does not inherit prior beauty-tools mission', async () => {
    const intent = extractIntentRuleBased('IPSA 流金水', [], [
      { role: 'user', content: 'makeup brush set for foundation and powder' },
      { role: 'assistant', content: 'Sure—here are options.' },
      { role: 'user', content: 'IPSA 流金水' },
    ]);
    expect(intent.scenario.name).not.toBe('beauty_tools');
    expect(intent.scenario.name).not.toBe('eye_shadow_brush');
  });

  test('brand query uses exploratory class and avoids generic makeup expansion', async () => {
    const { adjustedPayload, expansion_meta } = await buildFindProductsMultiContext({
      payload: {
        search: { query: 'kylie cosmetics' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'kylie cosmetics' }],
      },
      metadata: {},
    });

    const expanded = String(adjustedPayload?.search?.query || '').toLowerCase();
    expect(expansion_meta?.query_class).toBe('exploratory');
    expect(expansion_meta?.brand_query_detected).toBe(true);
    expect(expansion_meta?.brand_scope).toBe('broad');
    expect(expanded).toContain('kylie cosmetics');
    expect(expanded).not.toContain('foundation');
    expect(expanded).not.toContain('concealer');
    expect(expanded).not.toContain('mascara');
  });

  test('exact stable-alias product title uses lookup class instead of exploratory', async () => {
    const { adjustedPayload, expansion_meta, intent } = await buildFindProductsMultiContext({
      payload: {
        search: { query: 'IPSA Time Reset Aqua' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'IPSA Time Reset Aqua' }],
      },
      metadata: {},
    });

    expect(String(adjustedPayload?.search?.query || '')).toBe('IPSA Time Reset Aqua');
    expect(expansion_meta?.query_class).toBe('lookup');
    expect(intent?.query_class).toBe('exploratory');
    expect(expansion_meta?.brand_query_detected).toBe(false);
  });

  test('hyphenated beauty product titles stay on raw lookup text instead of skincare category expansion', async () => {
    const { adjustedPayload, expansion_meta, intent } = await buildFindProductsMultiContext({
      payload: {
        search: { query: 'Multi-Calm Cream Cleanser' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'Multi-Calm Cream Cleanser' }],
      },
      metadata: {},
    });

    expect(String(adjustedPayload?.search?.query || '')).toBe('Multi-Calm Cream Cleanser');
    expect(expansion_meta?.query_class).toBe('lookup');
    expect(String(expansion_meta?.expanded_query || '')).toBe('Multi-Calm Cream Cleanser');
    expect(intent?.primary_domain).toBe('beauty');
  });

  test('generic sunscreen query routes to beauty attribute instead of lookup', () => {
    const intent = extractIntentRuleBased('Face SPF50+ PA++++ sunscreen', [], []);
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.target_object.type).toBe('human');
    expect(intent.query_class).toBe('attribute');
  });

  test('generic moisturizer query stays in beauty and does not default to lookup', () => {
    const intent = extractIntentRuleBased('hydrating moisturizer', [], []);
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.target_object.type).toBe('human');
    expect(intent.query_class).toBe('attribute');
  });

  test('face sunscreen query is treated as beauty category search', () => {
    const intent = extractIntentRuleBased('Face sunscreen', [], []);
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.target_object.type).toBe('human');
    expect(intent.query_class).toBe('category');
  });

  test.each(['lip balm', 'hair oil', 'shampoo', 'lip treatment'])(
    'broad beauty head term %s stays on beauty category instead of exploratory clarify',
    (query) => {
      const intent = extractIntentRuleBased(query, [], []);
      expect(intent.primary_domain).toBe('beauty');
      expect(intent.target_object.type).toBe('human');
      expect(intent.query_class).toBe('category');
      expect(intent.ambiguity.needs_clarification).toBe(false);
    },
  );

  test.each(['lip balm', 'hair oil', 'shampoo', 'lip treatment'])(
    'context build keeps %s on raw beauty category query',
    async (query) => {
      const { adjustedPayload, expansion_meta, intent } = await buildFindProductsMultiContext({
        payload: {
          search: { query },
          user: { recent_queries: [] },
          messages: [{ role: 'user', content: query }],
        },
        metadata: { source: 'search' },
      });

      expect(String(adjustedPayload?.search?.query || '')).toBe(query);
      expect(intent?.primary_domain).toBe('beauty');
      expect(expansion_meta?.query_class).toBe('category');
      expect(Number(expansion_meta?.ambiguity_score_pre || 1)).toBeLessThan(0.4);
    },
  );

  test('face sunscreen expansion adds SPF-oriented skincare terms', async () => {
    const { adjustedPayload, expansion_meta } = await buildFindProductsMultiContext({
      payload: {
        search: { query: 'Face sunscreen' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'Face sunscreen' }],
      },
      metadata: {},
    });

    const expanded = String(adjustedPayload?.search?.query || '').toLowerCase();
    expect(expanded).toContain('face sunscreen');
    expect(expansion_meta.semantic_rewrite_result).toEqual(
      expect.objectContaining({
        normalized_query_pack: expect.arrayContaining([
          'face sunscreen',
          'broad spectrum sunscreen',
          'daily sunscreen',
        ]),
      }),
    );
    expect(expanded).not.toContain('brush');
  });

  test('aurora semantic contract locks backend semantic owner and avoids generic expansion drift', async () => {
    const { adjustedPayload, expansion_meta } = await buildFindProductsMultiContext({
      payload: {
        search: {
          query: 'best sunscreen for oily skin',
          semantic_contract: {
            version: 'beauty_semantic_contract_v1',
            owner: 'aurora_reco_planner',
            planner_mode: 'step_aware',
            request_class: 'sunscreen',
            target_step_family: 'sunscreen',
            primary_role_id: 'daily_sunscreen',
            support_role_ids: [],
            semantic_family: 'sunscreen',
            allowed_step_families: ['sunscreen'],
            blocked_step_families: [],
            ingredient_hypotheses: [],
            source_surface: 'aurora_beauty_strict',
          },
        },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'best sunscreen for oily skin' }],
      },
      metadata: {},
    });

    expect(adjustedPayload.search.semantic_contract).toEqual(
      expect.objectContaining({
        owner: 'aurora_reco_planner',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
      }),
    );
    expect(expansion_meta.semantic_owner_locked).toBe(true);
    expect(expansion_meta.semantic_rewrite_timeout_ms).toBe(0);
    expect(expansion_meta.semantic_rewrite_result).toEqual(
      expect.objectContaining({
        owner: 'shopping_agent_beauty_mainline',
        applied: true,
        mode: 'deterministic_contract',
        single_provider_locked: true,
        llm_enrichment_attempted: false,
        llm_enrichment_applied: false,
        llm_enrichment_status: 'skipped_strict_contract_owner',
        hard_filters: expect.objectContaining({
          target_step_family: 'sunscreen',
          allowed_step_families: ['sunscreen'],
        }),
      }),
    );
    const expanded = String(adjustedPayload?.search?.query || '').toLowerCase();
    expect(expanded).toBe('lightweight sunscreen oily skin');
    expect(expanded).not.toContain('brush');
  });

  test('strict semantic contract owner bypasses llm rewrite and uses deterministic query pack output', async () => {
    jest.resetModules();
    jest.doMock('../src/findProductsMulti/intentLlm', () => {
      const actual = jest.requireActual('../src/findProductsMulti/intentLlm');
      return {
        ...actual,
        extractIntentWithMeta: jest.fn(() => {
          throw new Error('full intent llm should not run for aurora strict contract owner');
        }),
        _debug: {
          resolveIntentLlmExecutionPlan: jest.fn(() => ({
            enableOwner: 'provider_auto_enable',
            providerOwner: 'provider_auto_select',
            fallbackOwner: null,
            providerChain: ['gemini'],
            primaryProvider: 'gemini',
            fallbackProvider: null,
            primaryModel: 'gemini-3-flash-preview',
            primaryModelOwner: 'default_semantic_rewrite_gemini_model',
            singleProviderLocked: true,
          })),
        },
      };
    });

    try {
      // eslint-disable-next-line global-require
      const { buildFindProductsMultiContext: buildStrictSemanticContext } = require('../src/findProductsMulti/policy');
      const out = await buildStrictSemanticContext({
        payload: {
          search: {
            query: 'best sunscreen for oily skin',
            semantic_contract: {
              version: 'beauty_semantic_contract_v1',
              owner: 'aurora_reco_planner',
              planner_mode: 'step_aware',
              request_class: 'sunscreen',
              target_step_family: 'sunscreen',
              primary_role_id: 'daily_sunscreen',
              support_role_ids: [],
              semantic_family: 'sunscreen',
              allowed_step_families: ['sunscreen'],
              blocked_step_families: ['treatment', 'moisturizer'],
              ingredient_hypotheses: [],
              source_surface: 'aurora_beauty_strict',
            },
          },
          user: { recent_queries: [] },
          messages: [{ role: 'user', content: 'best sunscreen for oily skin' }],
        },
        metadata: {},
      });

      expect(String(out.adjustedPayload?.search?.query || '').toLowerCase()).toBe('lightweight sunscreen oily skin');
      expect(out.expansion_meta.semantic_rewrite_result).toEqual(
        expect.objectContaining({
          owner: 'shopping_agent_beauty_mainline',
          mode: 'deterministic_contract',
          llm_enrichment_attempted: false,
          llm_enrichment_applied: false,
          llm_enrichment_status: 'skipped_strict_contract_owner',
          normalized_query_pack: [
            'lightweight sunscreen oily skin',
            'oil control sunscreen',
            'lightweight face sunscreen',
          ],
        }),
      );
    } finally {
      jest.dontMock('../src/findProductsMulti/intentLlm');
      jest.resetModules();
    }
  });

  test('strict sunscreen contract keeps explicit SPF query ahead of generic sunscreen fallbacks', async () => {
    const out = await buildFindProductsMultiContext({
      payload: {
        search: {
          query: 'face sunscreen spf50',
          semantic_contract: {
            version: 'beauty_semantic_contract_v1',
            owner: 'aurora_reco_planner',
            planner_mode: 'step_aware',
            request_class: 'sunscreen',
            target_step_family: 'sunscreen',
            primary_role_id: 'daily_sunscreen',
            support_role_ids: [],
            semantic_family: 'sunscreen',
            allowed_step_families: ['sunscreen'],
            blocked_step_families: ['treatment', 'moisturizer'],
            ingredient_hypotheses: [],
            source_surface: 'aurora_beauty_strict',
          },
        },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'face sunscreen spf50' }],
      },
      metadata: {},
    });

    expect(String(out.adjustedPayload?.search?.query || '').toLowerCase()).toBe('face sunscreen spf50');
    expect(out.expansion_meta.semantic_rewrite_result).toEqual(
      expect.objectContaining({
        normalized_query_pack: ['face sunscreen spf50', 'broad spectrum sunscreen', 'daily sunscreen'],
      }),
    );
  });

  test('beauty query without explicit semantic contract derives the same mainline contract for invoke-style payloads', async () => {
    const out = await buildFindProductsMultiContext({
      payload: {
        query: 'best sunscreen for oily skin',
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'best sunscreen for oily skin' }],
      },
      metadata: {},
    });

    expect(out.adjustedPayload.search).toEqual(
      expect.objectContaining({
        query: 'lightweight sunscreen oily skin',
        catalog_surface: 'beauty',
        commerce_surface: 'beauty',
        target_step_family: 'sunscreen',
        semantic_family: 'oil_control',
        concern_class: 'sunscreen',
        semantic_contract: expect.objectContaining({
          owner: 'shopping_agent_beauty_contract_builder',
          request_class: 'sunscreen',
          target_step_family: 'sunscreen',
          concern_class: 'sunscreen',
          source_surface: 'shopping_agent_public_beauty',
        }),
      }),
    );
    expect(out.expansion_meta.semantic_owner_locked).toBe(true);
    expect(out.expansion_meta.semantic_rewrite_result).toEqual(
      expect.objectContaining({
        owner: 'shopping_agent_beauty_mainline',
        mode: 'deterministic_contract',
        normalized_query_pack: [
          'lightweight sunscreen oily skin',
          'oil control sunscreen',
          'lightweight face sunscreen',
        ],
      }),
    );
  });

  test('strict shopping-agent beauty queries preserve raw query and agent_api surface', async () => {
    const out = await buildFindProductsMultiContext({
      payload: {
        search: {
          query: 'vitamin c serum under €30',
          limit: 10,
          in_stock_only: true,
        },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'vitamin c serum under €30' }],
      },
      metadata: {
        source: 'shopping_agent',
      },
    });

    expect(out.adjustedPayload.search).toEqual(
      expect.objectContaining({
        query: 'vitamin c serum under €30',
        catalog_surface: 'agent_api',
        commerce_surface: 'agent_api',
        target_step_family: 'serum',
        semantic_family: 'brightening',
      }),
    );
    expect(out.adjustedPayload.search.semantic_contract).toBeUndefined();
    expect(out.expansion_meta.semantic_contract).toBeNull();
    expect(out.expansion_meta.semantic_owner_locked).toBe(false);
  });

  test('oil-control treatment query derives ingredient-led treatment query pack before serum fallback', async () => {
    const out = await buildFindProductsMultiContext({
      payload: {
        query: 'oil control treatment',
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'oil control treatment' }],
      },
      metadata: {},
    });

    expect(out.adjustedPayload.search).toEqual(
      expect.objectContaining({
        query: 'oil control treatment',
        catalog_surface: 'beauty',
        commerce_surface: 'beauty',
        target_step_family: 'treatment',
        semantic_family: 'oil_control',
        concern_class: 'oil_control',
        semantic_contract: expect.objectContaining({
          owner: 'shopping_agent_beauty_contract_builder',
          request_class: 'generic_concern',
          target_step_family: 'treatment',
          concern_class: 'oil_control',
          ingredient_hypotheses: ['niacinamide', 'salicylic acid'],
        }),
      }),
    );
    expect(out.expansion_meta.semantic_owner_locked).toBe(true);
    expect(out.expansion_meta.semantic_rewrite_result).toEqual(
      expect.objectContaining({
        owner: 'shopping_agent_beauty_mainline',
        mode: 'deterministic_contract',
        normalized_query_pack: [
          'oil control treatment',
          'niacinamide treatment',
          'salicylic acid treatment',
        ],
      }),
    );
  });

  test('exact lookup semantic contract skips semantic rewrite budget entirely', async () => {
    jest.resetModules();
    jest.doMock('../src/findProductsMulti/intentLlm', () => {
      const actual = jest.requireActual('../src/findProductsMulti/intentLlm');
      return {
        ...actual,
        extractIntentWithMeta: jest.fn(() => {
          throw new Error('semantic rewrite should be skipped for exact lookup');
        }),
      };
    });

    try {
      // eslint-disable-next-line global-require
      const { buildFindProductsMultiContext: buildWithExactLookup } = require('../src/findProductsMulti/policy');
      const out = await buildWithExactLookup({
        payload: {
          search: {
            query: 'The Ordinary Niacinamide 10% + Zinc 1%',
            semantic_contract: {
              version: 'beauty_semantic_contract_v1',
              owner: 'aurora_reco_planner',
              planner_mode: 'exact_product',
              request_class: 'exact_lookup',
              target_step_family: null,
              primary_role_id: null,
              support_role_ids: [],
              semantic_family: null,
              allowed_step_families: [],
              blocked_step_families: [],
              ingredient_hypotheses: [],
              source_surface: 'aurora_beauty_strict',
            },
          },
          user: { recent_queries: [] },
          messages: [{ role: 'user', content: 'The Ordinary Niacinamide 10% + Zinc 1%' }],
        },
        metadata: {},
      });

      expect(out.expansion_meta.semantic_rewrite_timeout_ms).toBe(0);
      expect(out.expansion_meta.semantic_owner_locked).toBe(false);
      expect(out.expansion_meta.semantic_rewrite_result).toEqual(
        expect.objectContaining({
          applied: false,
          fallback_reason: 'semantic_rewrite_skipped_exact_lookup',
        }),
      );
    } finally {
      jest.dontMock('../src/findProductsMulti/intentLlm');
      jest.resetModules();
    }
  });

  test('public short beauty category query skips semantic rewrite budget entirely', async () => {
    jest.resetModules();
    jest.doMock('../src/findProductsMulti/intentLlm', () => {
      const actual = jest.requireActual('../src/findProductsMulti/intentLlm');
      return {
        ...actual,
        extractIntentWithMeta: jest.fn(() => {
          throw new Error('semantic rewrite should be skipped for public category search');
        }),
      };
    });

    try {
      // eslint-disable-next-line global-require
      const { buildFindProductsMultiContext: buildPublicCategoryContext } = require('../src/findProductsMulti/policy');
      const out = await buildPublicCategoryContext({
        payload: {
          search: {
            query: 'hair oil',
            limit: 6,
            in_stock_only: true,
          },
          user: { recent_queries: [] },
          messages: [{ role: 'user', content: 'hair oil' }],
        },
        metadata: {
          source: 'search',
        },
      });

      expect(out.expansion_meta.semantic_rewrite_timeout_ms).toBe(0);
      expect(out.expansion_meta.query_class).toBe('category');
      expect(out.expansion_meta.semantic_rewrite_result).toEqual(
        expect.objectContaining({
          applied: false,
          fallback_reason: 'semantic_rewrite_skipped_public_category_search',
        }),
      );
      expect(out.adjustedPayload.search).toEqual(
        expect.objectContaining({
          query: 'hair oil',
        }),
      );
    } finally {
      jest.dontMock('../src/findProductsMulti/intentLlm');
      jest.resetModules();
    }
  });

  test('framework generic semantic contract prioritizes role-aligned treatment query before raw concern text', async () => {
    const { adjustedPayload, expansion_meta } = await buildFindProductsMultiContext({
      payload: {
        search: {
          query: 'Recommend acne-control products with low irritation.',
          semantic_contract: {
            version: 'beauty_semantic_contract_v1',
            owner: 'aurora_reco_planner',
            planner_mode: 'framework_generic',
            request_class: 'generic_concern',
            target_step_family: 'treatment',
            primary_role_id: 'oil_control_treatment',
            support_role_ids: ['lightweight_moisturizer', 'daily_sunscreen'],
            semantic_family: 'oil_control',
            allowed_step_families: ['treatment', 'serum', 'moisturizer', 'sunscreen'],
            blocked_step_families: [],
            ingredient_hypotheses: ['salicylic acid'],
            source_surface: 'aurora_beauty_strict',
          },
        },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'Recommend acne-control products with low irritation.' }],
      },
      metadata: {},
    });

    expect(String(adjustedPayload?.search?.query || '').toLowerCase()).toBe('oil control treatment');
    expect(expansion_meta.semantic_rewrite_result).toEqual(
      expect.objectContaining({
        owner: 'shopping_agent_beauty_mainline',
        normalized_query_pack: [
          'oil control treatment',
          'salicylic acid treatment',
          'oil control serum',
        ],
      }),
    );
  });

  test('barrier moisturizer query derives family policy instead of generic moisturizer expansion', async () => {
    const { adjustedPayload, expansion_meta } = await buildFindProductsMultiContext({
      payload: {
        query: 'barrier repair moisturizer',
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'barrier repair moisturizer' }],
      },
      metadata: {},
    });

    expect(adjustedPayload.search).toEqual(
      expect.objectContaining({
        target_step_family: 'moisturizer',
        concern_class: 'barrier_repair',
        semantic_contract: expect.objectContaining({
          concern_class: 'barrier_repair',
        }),
      }),
    );
    expect(String(adjustedPayload?.search?.query || '').toLowerCase()).toBe(
      'barrier moisturizer ceramide moisturizer barrier repair moisturizer',
    );
    expect(expansion_meta.semantic_rewrite_result).toEqual(
      expect.objectContaining({
        normalized_query_pack: [
          'barrier moisturizer',
          'ceramide moisturizer',
          'barrier repair moisturizer',
        ],
      }),
    );
  });

  test('hydrating moisturizer expansion adds moisturizer-specific recall terms', async () => {
    const { adjustedPayload, expansion_meta } = await buildFindProductsMultiContext({
      payload: {
        search: { query: 'hydrating moisturizer' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'hydrating moisturizer' }],
      },
      metadata: {},
    });

    const expanded = String(adjustedPayload?.search?.query || '').toLowerCase();
    expect(expanded).toBe('hydrating moisturizer hyaluronic moisturizer face moisturizer');
    expect(expanded).not.toContain('foundation');
    expect(expansion_meta.semantic_rewrite_result).toEqual(
      expect.objectContaining({
        normalized_query_pack: [
          'hydrating moisturizer',
          'hyaluronic moisturizer',
          'face moisturizer',
        ],
      }),
    );
  });

  test('dry sensitive retinoid moisturizer asks include sensitive-skin recall terms in the owner query', async () => {
    const { adjustedPayload, expansion_meta } = await buildFindProductsMultiContext({
      payload: {
        search: { query: 'I have dry sensitive skin, use tretinoin at night, and want a moisturizer under $30.' },
        user: { recent_queries: [] },
        messages: [
          {
            role: 'user',
            content: 'I have dry sensitive skin, use tretinoin at night, and want a moisturizer under $30.',
          },
        ],
      },
      metadata: {},
    });

    expect(String(adjustedPayload?.search?.query || '').toLowerCase()).toBe(
      'barrier moisturizer sensitive skin moisturizer ceramide moisturizer',
    );
    expect(adjustedPayload.search).toEqual(
      expect.objectContaining({
        target_step_family: 'moisturizer',
        concern_class: 'barrier_repair',
      }),
    );
    expect(expansion_meta.semantic_rewrite_result).toEqual(
      expect.objectContaining({
        owner: 'shopping_agent_beauty_mainline',
        normalized_query_pack: [
          'barrier moisturizer',
          'sensitive skin moisturizer',
          'ceramide moisturizer',
        ],
      }),
    );
  });

  test('skin profile routine query stays in beauty semantic owner instead of apparel winter expansion', async () => {
    const { adjustedPayload, expansion_meta } = await buildFindProductsMultiContext({
      payload: {
        search: { query: 'Combination skin, clogged pores, Seattle winter, simple routine.' },
        user: { recent_queries: [] },
        messages: [
          {
            role: 'user',
            content: 'Combination skin, clogged pores, Seattle winter, simple routine.',
          },
        ],
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'beauty',
      },
    });

    const expanded = String(adjustedPayload?.search?.query || '').toLowerCase();
    expect(expanded).toBe('oil control treatment');
    expect(expanded).not.toMatch(/\b(coat|jacket|outerwear|down jacket)\b/);
    expect(adjustedPayload.search).toEqual(
      expect.objectContaining({
        catalog_surface: 'beauty',
        target_step_family: 'treatment',
        concern_class: 'oil_control',
      }),
    );
    expect(expansion_meta.semantic_rewrite_result).toEqual(
      expect.objectContaining({
        owner: 'shopping_agent_beauty_mainline',
        normalized_query_pack: [
          'oil control treatment',
          'niacinamide treatment',
          'salicylic acid treatment',
        ],
      }),
    );
  });

  test('perfume query uses fragrance semantic expansion without makeup drift', async () => {
    const { adjustedPayload, expansion_meta } = await buildFindProductsMultiContext({
      payload: {
        search: { query: 'perfume' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: 'perfume' }],
      },
      metadata: {},
    });

    const expanded = String(adjustedPayload?.search?.query || '').toLowerCase();
    expect(expansion_meta?.query_semantic_class).toBe('fragrance');
    expect(expanded).toContain('fragrance');
    expect(expanded).toContain('parfum');
    expect(expanded).toContain('cologne');
    expect(expanded).not.toContain('foundation');
    expect(expanded).not.toContain('concealer');
    expect(expanded).not.toContain('mascara');
  });

  test('broad beauty query auto-derives deterministic contract owner without hanging on llm rewrite timeouts', async () => {
    jest.resetModules();
    jest.doMock('../src/findProductsMulti/intentLlm', () => {
      const actual = jest.requireActual('../src/findProductsMulti/intentLlm');
      return {
        ...actual,
        extractIntentWithMeta: jest.fn(() => new Promise(() => {})),
      };
    });

    try {
      // eslint-disable-next-line global-require
      const { buildFindProductsMultiContext: buildWithTimeout } = require('../src/findProductsMulti/policy');
      const startedAt = Date.now();
      const out = await buildWithTimeout({
        payload: {
          search: { query: 'best sunscreen for oily skin' },
          user: { recent_queries: [] },
          messages: [{ role: 'user', content: 'best sunscreen for oily skin' }],
        },
        metadata: {},
      });

      expect(Date.now() - startedAt).toBeLessThan(6500);
      expect(out.expansion_meta.semantic_rewrite_timeout_ms).toBe(0);
      expect(out.expansion_meta.semantic_rewrite_result).toEqual(
        expect.objectContaining({
          owner: 'shopping_agent_beauty_mainline',
          mode: 'deterministic_contract',
          fallback_reason: null,
          llm_provider_chain: expect.any(Array),
          single_provider_locked: false,
          llm_enrichment_attempted: false,
          llm_enrichment_status: 'skipped_strict_contract_owner',
        }),
      );
    } finally {
      jest.dontMock('../src/findProductsMulti/intentLlm');
      jest.resetModules();
    }
  });

  test('semantic rewrite llm failure preserves planned model and normalized error metadata in semantic_rewrite_result', async () => {
    jest.resetModules();
    jest.doMock('../src/findProductsMulti/intentLlm', () => ({
      buildDeterministicIntentWithMeta: jest.fn((latestUserQuery) => ({
        intent: {
          language: 'en',
          primary_domain: 'beauty',
          target_object: { type: 'human', age_group: 'adult' },
          query_class: 'category',
          category: { required: [], optional: [] },
          scenario: { name: 'general', signals: [] },
          hard_constraints: { must_exclude_domains: [], must_exclude_keywords: [] },
          history_usage: { used: false, reason: 'mocked llm failure' },
          ambiguity: { needs_clarification: false, questions: [] },
          confidence: { overall: 0.42 },
        },
        meta: {
          applied: true,
          mode: 'deterministic_fallback',
          provider: 'rule_based',
          fallback_reason: 'llm_failed',
          llm_provider_chain: ['gemini'],
          llm_primary_provider: 'gemini',
          llm_model: 'gemini-3-flash-preview',
          llm_model_owner: 'default_semantic_rewrite_gemini_model',
          llm_error_class: 'provider_error',
          llm_error_stage: 'primary',
          llm_error_provider: 'gemini',
          llm_error_message: 'Request failed with status code 503',
          llm_finish_reason: 'MAX_TOKENS',
          llm_raw_preview: '{"lang',
          llm_candidate_count: 1,
          llm_upstream_status: 503,
          llm_upstream_error_code: 'UNAVAILABLE',
          llm_upstream_error_message: 'provider overloaded',
          single_provider_locked: true,
        },
      })),
      extractIntentWithMeta: jest.fn(async (latestUserQuery) => ({
        intent: {
          language: 'en',
          primary_domain: 'beauty',
          target_object: { type: 'human', age_group: 'adult' },
          query_class: 'category',
          category: { required: [], optional: [] },
          scenario: { name: 'general', signals: [] },
          hard_constraints: { must_exclude_domains: [], must_exclude_keywords: [] },
          history_usage: { used: false, reason: 'mocked llm failure' },
          ambiguity: { needs_clarification: false, questions: [] },
          confidence: { overall: 0.42 },
        },
        meta: {
          applied: true,
          mode: 'deterministic_fallback',
          provider: 'rule_based',
          fallback_reason: 'llm_failed',
          llm_provider_chain: ['gemini'],
          llm_primary_provider: 'gemini',
          llm_model: 'gemini-3-flash-preview',
          llm_model_owner: 'default_semantic_rewrite_gemini_model',
          llm_error_class: 'provider_error',
          llm_error_stage: 'primary',
          llm_error_provider: 'gemini',
          llm_error_message: 'Request failed with status code 503',
          llm_finish_reason: 'MAX_TOKENS',
          llm_raw_preview: '{"lang',
          llm_candidate_count: 1,
          llm_upstream_status: 503,
          llm_upstream_error_code: 'UNAVAILABLE',
          llm_upstream_error_message: 'provider overloaded',
          single_provider_locked: true,
        },
      })),
      _debug: {
        resolveIntentLlmExecutionPlan: jest.fn(() => ({
          enableOwner: 'provider_auto_enable',
          providerOwner: 'provider_auto_select',
          fallbackOwner: null,
          providerChain: ['gemini'],
          primaryProvider: 'gemini',
          fallbackProvider: null,
          primaryModel: 'gemini-3-flash-preview',
          primaryModelOwner: 'default_semantic_rewrite_gemini_model',
          singleProviderLocked: true,
        })),
      },
    }));

    try {
      // eslint-disable-next-line global-require
      const { buildFindProductsMultiContext: buildWithLlmFailure } = require('../src/findProductsMulti/policy');
      const out = await buildWithLlmFailure({
        payload: {
          search: {
            query: 'best sunscreen for oily skin',
            semantic_contract: {
              version: 'beauty_semantic_contract_v1',
              owner: 'aurora_reco_planner',
              planner_mode: 'step_aware',
              request_class: 'sunscreen',
              target_step_family: 'sunscreen',
              primary_role_id: 'daily_sunscreen',
              support_role_ids: [],
              semantic_family: 'sunscreen',
              allowed_step_families: ['sunscreen'],
              blocked_step_families: [],
              ingredient_hypotheses: [],
              source_surface: 'aurora_beauty_strict',
            },
          },
          user: { recent_queries: [] },
          messages: [{ role: 'user', content: 'best sunscreen for oily skin' }],
        },
        metadata: {},
      });

      expect(out.expansion_meta.semantic_rewrite_result).toEqual(
        expect.objectContaining({
          owner: 'shopping_agent_beauty_mainline',
          mode: 'deterministic_contract',
          llm_model: 'gemini-3-flash-preview',
          llm_model_owner: 'default_semantic_rewrite_gemini_model',
          llm_error_class: null,
          llm_error_stage: null,
          llm_error_provider: null,
          llm_error_message: null,
          llm_finish_reason: null,
          llm_raw_preview: null,
          llm_candidate_count: null,
          llm_upstream_status: null,
          llm_upstream_error_code: null,
          llm_upstream_error_message: null,
          llm_enrichment_attempted: false,
          llm_enrichment_applied: false,
          llm_enrichment_status: 'skipped_strict_contract_owner',
        }),
      );
    } finally {
      jest.dontMock('../src/findProductsMulti/intentLlm');
      jest.resetModules();
    }
  });

  test('context query expansion avoids brush terms for brand/product lookup follow-up', async () => {
    const { intent, adjustedPayload } = await buildFindProductsMultiContext({
      payload: {
        search: { query: 'IPSA 流金水' },
        user: { recent_queries: [] },
        messages: [
          { role: 'user', content: 'makeup brush set for foundation and powder' },
          { role: 'assistant', content: 'Sure—here are options.' },
          { role: 'user', content: 'IPSA 流金水' },
        ],
      },
      metadata: {},
    });

    expect(intent.scenario.name).not.toBe('beauty_tools');
    const expanded = String(adjustedPayload?.search?.query || '');
    expect(expanded.toLowerCase()).not.toContain('makeup brush');
    expect(expanded).not.toContain('化妆刷');
  });

  test('beauty_request product context becomes the exact-product retrieval query', async () => {
    const { adjustedPayload, expansion_meta } = await buildFindProductsMultiContext({
      payload: {
        search: {
          query: 'I use tretinoin. Is Ultra Repair Face Lotion a better next moisturizer than a peptide cream?',
          limit: 6,
          in_stock_only: true,
          catalog_surface: 'beauty',
        },
        context: {
          normalized_need: {
            beauty_request: {
              domain: 'beauty',
              user_goal: 'I use tretinoin. Is Ultra Repair Face Lotion a better next moisturizer than a peptide cream?',
              routine_context: { actives: ['tretinoin'] },
              product_context: { canonical_product_ref: 'ultra repair face lotion' },
              constraints: { budget_max: 30 },
            },
          },
        },
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'beauty',
      },
    });

    const query = String(adjustedPayload.search.query || '').toLowerCase();
    expect(query).toContain('ultra repair face lotion');
    expect(query).toContain('face moisturizer');
    expect(query).toContain('barrier moisturizer');
    expect(adjustedPayload.search.price_max).toBe(30);
    expect(expansion_meta.beauty_context_budget_max).toBe(30);
    expect(String(adjustedPayload.search.target_step_family || '')).toBe('moisturizer');
  });

  test('sleepwear query routes to human apparel (not pet)', async () => {
    const intent = extractIntentRuleBased('给我推荐一个睡觉很舒服，好看的睡衣', [], []);
    expect(intent.primary_domain).toBe('human_apparel');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('sleepwear');
  });

  test('negated pet mention does not force pet intent', async () => {
    const intent = extractIntentRuleBased('女士睡衣，不是小狗的', [], [
      { role: 'user', content: '我想买一件狗的衣服，我家养了一只边牧' },
      { role: 'assistant', content: '我找到了几件更符合你需求的选择。' },
      { role: 'user', content: '女士睡衣，不是小狗的' },
    ]);
    expect(intent.primary_domain).toBe('human_apparel');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('sleepwear');
  });

  test('sleepwear follow-up keeps sleepwear mission from messages', async () => {
    const intent = extractIntentRuleBased('我要一件春秋穿的', [], [
      { role: 'user', content: '给我推荐一个睡觉很舒服，好看的睡衣' },
      { role: 'assistant', content: '好的，我先给你一些建议。' },
      { role: 'user', content: '我要一件春秋穿的' },
    ]);
    expect(intent.primary_domain).toBe('human_apparel');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('sleepwear');
  });
});
