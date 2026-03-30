const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadProdGateCases,
  loadStagingMatrixPayload,
  loadAuroraManualReviewCases,
  loadPromptLiveSmokeCases,
} = require('../scripts/lib/commerce_shared_acceptance_corpus');

describe('Commerce shared acceptance corpus', () => {
  test('projects shared corpus into prod, staging, and manual-review views', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-shared-corpus-'));
    const corpusPath = path.join(outDir, 'shared-corpus.json');

    fs.writeFileSync(
      corpusPath,
      JSON.stringify(
        {
          schema_version: 'celestial.commerce_core.acceptance_corpus.v1',
          cases: [
            {
              id: 'prod_case',
              family: 'merchant_query',
              query: 'IPSA products',
              source: 'shopping_agent',
              targets: {
                prod_gate: {
                  must_have_metadata: ['service_version.commit'],
                },
              },
            },
            {
              id: 'live_case',
              family: 'exact_product_lookup',
              query: 'IPSA Time Reset Aqua',
              source: 'shopping_agent',
              targets: {
                staging_matrix: {
                  title: 'exact lookup',
                  request: {
                    operation: 'find_products_multi',
                    payload: { search: { query: 'IPSA Time Reset Aqua' } },
                    metadata: { source: 'shopping_agent' },
                  },
                },
              },
            },
            {
              id: 'manual_case',
              family: 'aurora_guidance_only_cache_hit',
              query: 'hydrating serum',
              source: 'aurora-bff',
              targets: {
                staging_matrix: {
                  execution_mode: 'manual',
                  request: {
                    operation: 'find_products_multi',
                    payload: { search: { query: 'hydrating serum' } },
                    metadata: { source: 'aurora-bff' },
                  },
                },
              },
            },
            {
              id: 'governance_case',
              family: 'governance_orchestration_denied',
              targets: {
                staging_matrix: {
                  kind: 'governance',
                  title: 'governance case',
                  request: {
                    operation: 'find_products',
                    payload: { search: { query: 'serum' } },
                    metadata: { source: 'aurora-bff' },
                  },
                },
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    expect(loadProdGateCases(corpusPath)).toEqual([
      expect.objectContaining({
        id: 'prod_case',
        family: 'merchant_query',
        query: 'IPSA products',
        source: 'shopping_agent',
        must_have_metadata: expect.arrayContaining([
          'service_version.commit',
          'route_health.fallback_triggered',
          'search_decision.decision_locked',
        ]),
        allowed_query_sources: ['cache_cross_merchant_search'],
        must_equal_metadata: expect.objectContaining({
          'search_trace.final_decision': 'cache_returned',
          'search_decision.decision_authority': 'cache_cross_merchant_search',
          'search_decision.decision_locked': true,
          'route_health.fallback_triggered': false,
        }),
      }),
    ]);

    expect(loadStagingMatrixPayload(corpusPath)).toEqual({
      matrixPath: path.resolve(corpusPath),
      semantic_cases: [
        expect.objectContaining({
          id: 'live_case',
          family: 'exact_product_lookup',
          source: 'shopping_agent',
          ownership: {
            must_equal_paths: expect.objectContaining({
              'metadata.search_trace.query_class': 'lookup',
              'metadata.search_trace.final_decision': 'cache_returned',
              'metadata.search_decision.decision_authority': 'cache_cross_merchant_search',
              'metadata.search_decision.decision_locked': true,
              'metadata.route_health.fallback_triggered': false,
            }),
          },
          observability: {
            must_have_paths: expect.arrayContaining([
              'metadata.service_version.commit',
              'metadata.query_source',
              'metadata.search_trace.query_class',
              'metadata.search_decision.decision_authority',
              'metadata.search_decision.decision_locked',
              'metadata.route_health.fallback_triggered',
            ]),
          },
        }),
        expect.objectContaining({
          id: 'manual_case',
          family: 'aurora_guidance_cache_hit',
          family_aliases: expect.arrayContaining([
            'aurora_guidance_cache_hit',
            'aurora_guidance_only_cache_hit',
          ]),
          execution_mode: 'manual',
        }),
      ],
      governance_cases: [
        expect.objectContaining({
          id: 'governance_case',
          family: 'governance_orchestration_denied',
          kind: 'governance',
        }),
      ],
    });

    expect(loadAuroraManualReviewCases(corpusPath)).toEqual([
      expect.objectContaining({
        id: 'manual_case',
        family: 'aurora_guidance_cache_hit',
        family_aliases: expect.arrayContaining([
          'aurora_guidance_cache_hit',
          'aurora_guidance_only_cache_hit',
        ]),
        execution_mode: 'manual',
      }),
    ]);
  });

  test('projects shared prompt smoke cases with prompt defaults', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-shared-corpus-prompt-'));
    const corpusPath = path.join(outDir, 'shared-corpus-prompt.json');

    fs.writeFileSync(
      corpusPath,
      JSON.stringify(
        {
          schema_version: 'celestial.commerce_core.acceptance_corpus.v1',
          cases: [
            {
              id: 'prompt_case',
              family: 'prompt_clarify',
              source: 'aurora-bff',
              targets: {
                prompt_live_smoke: {
                  request: {
                    message: '有什么适合今晚约会的',
                  },
                },
              },
            },
            {
              id: 'resume_case',
              family: 'conversation_progress_resume',
              source: 'aurora-bff',
              targets: {
                prompt_live_smoke: {
                  request: {
                    message: '约会',
                    messages: [
                      { role: 'user', content: '帮我买一款 serum' },
                      { role: 'assistant', content: '你更偏哪种场景？' },
                    ],
                  },
                  observability: {
                    must_equal_paths: {
                      'meta.prompt_intent': 'follow_up_refinement',
                      'meta.conversation_progress': 'follow_up',
                    },
                  },
                },
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    expect(loadPromptLiveSmokeCases(corpusPath)).toEqual([
      expect.objectContaining({
        id: 'prompt_case',
        family: 'prompt_clarify',
        correctness: expect.objectContaining({
          expect_http_status: 200,
          min_assistant_message_length: 1,
        }),
        observability: expect.objectContaining({
          must_have_paths: expect.arrayContaining([
            'meta.prompt_intent',
            'meta.conversation_progress',
            'meta.early_decision',
            'meta.decision_owner',
          ]),
          must_equal_paths: expect.objectContaining({
            'meta.prompt_intent': 'shopping_request',
            'meta.conversation_progress': 'new_request',
            'meta.early_decision': 'delegate_to_decisioning',
            'meta.decision_owner': 'aurora_orchestration',
          }),
        }),
      }),
      expect.objectContaining({
        id: 'resume_case',
        family: 'conversation_progress_resume',
        observability: expect.objectContaining({
          must_equal_paths: expect.objectContaining({
            'meta.prompt_intent': 'follow_up_refinement',
            'meta.conversation_progress': 'follow_up',
            'meta.early_decision': 'resume_prior_goal',
            'meta.decision_owner': 'aurora_orchestration',
          }),
        }),
      }),
    ]);
  });

  test('applies exactish family defaults to minimal prod and staging cases', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-shared-corpus-defaults-'));
    const corpusPath = path.join(outDir, 'shared-corpus-defaults.json');

    fs.writeFileSync(
      corpusPath,
      JSON.stringify(
        {
          schema_version: 'celestial.commerce_core.acceptance_corpus.v1',
          cases: [
            {
              id: 'exactish_case',
              family: 'exactish_lookup',
              query: 'niacinamide serum',
              source: 'shopping_agent',
              targets: {
                prod_gate: {
                  must_return_one_of_titles: ['The Ordinary Niacinamide 10% + Zinc 1%'],
                },
                staging_matrix: {
                  request: {
                    operation: 'find_products_multi',
                    payload: { search: { query: 'niacinamide serum' } },
                    metadata: { source: 'shopping_agent' },
                  },
                },
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    expect(loadProdGateCases(corpusPath)).toEqual([
      expect.objectContaining({
        id: 'exactish_case',
        family: 'exactish_lookup',
        must_have_metadata: expect.arrayContaining([
          'contract_bridge.resolved_contract',
          'matched_ingredient_ids.0',
          'route_health.fallback_triggered',
          'search_decision.decision_locked',
        ]),
        must_equal_metadata: expect.objectContaining({
          'contract_bridge.resolved_contract': 'shop_invoke_strict',
          strict_constraint_query: true,
          strict_constraint_reason: 'ingredient',
          'route_health.fallback_triggered': false,
          'search_decision.decision_locked': true,
        }),
      }),
    ]);

    expect(loadStagingMatrixPayload(corpusPath).semantic_cases).toEqual([
      expect.objectContaining({
        id: 'exactish_case',
        family: 'exactish_lookup',
        ownership: expect.objectContaining({
          must_equal_paths: expect.objectContaining({
            'metadata.contract_bridge.resolved_contract': 'shop_invoke_strict',
            'metadata.strict_constraint_query': true,
            'metadata.strict_constraint_reason': 'ingredient',
            'metadata.route_health.fallback_triggered': false,
            'metadata.search_decision.decision_locked': true,
          }),
          must_have_paths: ['metadata.matched_ingredient_ids.0'],
        }),
        observability: expect.objectContaining({
          must_have_paths: expect.arrayContaining([
            'metadata.service_version.commit',
            'metadata.search_trace.final_decision',
            'metadata.route_health.fallback_triggered',
            'metadata.search_decision.decision_locked',
          ]),
        }),
      }),
    ]);
  });

  test('applies strict ingredient defaults to minimal prod cases', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-shared-corpus-strict-'));
    const corpusPath = path.join(outDir, 'shared-corpus-strict.json');

    fs.writeFileSync(
      corpusPath,
      JSON.stringify(
        {
          schema_version: 'celestial.commerce_core.acceptance_corpus.v1',
          cases: [
            {
              id: 'strict_case',
              family: 'strict_ingredient',
              query: 'niacinamide serum',
              source: 'shopping_agent',
              targets: {
                prod_gate: {
                  must_return_one_of_titles: ['The Ordinary Niacinamide 10% + Zinc 1%'],
                },
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    expect(loadProdGateCases(corpusPath)).toEqual([
      expect.objectContaining({
        id: 'strict_case',
        family: 'strict_ingredient',
        expected_contract_path: 'shop_invoke_strict',
        must_have_metadata: expect.arrayContaining([
          'contract_bridge.resolved_contract',
          'matched_ingredient_ids.0',
        ]),
        must_equal_metadata: expect.objectContaining({
          'contract_bridge.resolved_contract': 'shop_invoke_strict',
          strict_constraint_query: true,
          strict_constraint_reason: 'ingredient',
        }),
      }),
    ]);
  });

  test('applies strict ingredient budget defaults to minimal prod and staging cases', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-shared-corpus-budget-'));
    const corpusPath = path.join(outDir, 'shared-corpus-budget.json');

    fs.writeFileSync(
      corpusPath,
      JSON.stringify(
        {
          schema_version: 'celestial.commerce_core.acceptance_corpus.v1',
          cases: [
            {
              id: 'budget_case',
              family: 'strict_ingredient_budget',
              query: 'vitamin c serum under €30',
              source: 'search',
              targets: {
                prod_gate: {
                  must_have_metadata: ['budget_fx_applied', 'budget_fx_rate', 'budget_fx_source'],
                  must_equal_metadata: {
                    budget_fx_applied: true,
                    budget_fx_candidate_currency: 'USD',
                    budget_fx_unresolved: false,
                  },
                  must_return_one_of_titles: ['Vitamin-C Serum'],
                },
                staging_matrix: {
                  request: {
                    operation: 'find_products_multi',
                    payload: { search: { query: 'vitamin c serum under €30' } },
                    metadata: { source: 'search' },
                  },
                  observability: {
                    must_have_paths: [
                      'metadata.budget_fx_applied',
                      'metadata.budget_fx_rate',
                      'metadata.budget_fx_source',
                    ],
                  },
                  ownership: {
                    must_equal_paths: {
                      'metadata.budget_fx_applied': true,
                      'metadata.budget_fx_candidate_currency': 'USD',
                      'metadata.budget_fx_unresolved': false,
                    },
                  },
                },
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    expect(loadProdGateCases(corpusPath)).toEqual([
      expect.objectContaining({
        id: 'budget_case',
        family: 'strict_ingredient_budget',
        expected_contract_path: 'shop_invoke_strict',
        must_have_metadata: expect.arrayContaining([
          'contract_bridge.resolved_contract',
          'matched_ingredient_ids.0',
          'budget_fx_applied',
          'budget_fx_rate',
          'budget_fx_source',
          'route_health.fallback_triggered',
          'search_decision.decision_locked',
        ]),
        must_equal_metadata: expect.objectContaining({
          'contract_bridge.resolved_contract': 'shop_invoke_strict',
          strict_constraint_query: true,
          strict_constraint_reason: 'multi_constraint',
          budget_fx_applied: true,
          budget_fx_candidate_currency: 'USD',
          budget_fx_unresolved: false,
          'route_health.fallback_triggered': false,
          'search_decision.decision_locked': true,
        }),
      }),
    ]);

    expect(loadStagingMatrixPayload(corpusPath).semantic_cases).toEqual([
      expect.objectContaining({
        id: 'budget_case',
        family: 'strict_ingredient_budget',
        ownership: expect.objectContaining({
          must_equal_paths: expect.objectContaining({
            'metadata.contract_bridge.resolved_contract': 'shop_invoke_strict',
            'metadata.strict_constraint_query': true,
            'metadata.strict_constraint_reason': 'multi_constraint',
            'metadata.budget_fx_applied': true,
            'metadata.budget_fx_candidate_currency': 'USD',
            'metadata.budget_fx_unresolved': false,
            'metadata.route_health.fallback_triggered': false,
            'metadata.search_decision.decision_locked': true,
          }),
          must_have_paths: ['metadata.matched_ingredient_ids.0'],
        }),
        observability: expect.objectContaining({
          must_have_paths: expect.arrayContaining([
            'metadata.service_version.commit',
            'metadata.search_trace.final_decision',
            'metadata.budget_fx_applied',
            'metadata.budget_fx_rate',
            'metadata.budget_fx_source',
            'metadata.route_health.fallback_triggered',
            'metadata.search_decision.decision_locked',
          ]),
        }),
      }),
    ]);
  });

  test('applies scenario clarify defaults to minimal prod and staging cases', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-shared-corpus-clarify-'));
    const corpusPath = path.join(outDir, 'shared-corpus-clarify.json');

    fs.writeFileSync(
      corpusPath,
      JSON.stringify(
        {
          schema_version: 'celestial.commerce_core.acceptance_corpus.v1',
          cases: [
            {
              id: 'clarify_case',
              family: 'scenario_clarify',
              query: '有什么适合今晚约会的',
              source: 'shopping_agent',
              targets: {
                prod_gate: {
                  must_have_reason_codes: ['AMBIGUITY_CLARIFY'],
                },
                staging_matrix: {
                  request: {
                    operation: 'find_products_multi',
                    payload: { search: { query: '有什么适合今晚约会的' } },
                    metadata: { source: 'shopping_agent' },
                  },
                  correctness: {
                    must_have_reason_codes: ['AMBIGUITY_CLARIFY'],
                  },
                },
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    expect(loadProdGateCases(corpusPath)).toEqual([
      expect.objectContaining({
        id: 'clarify_case',
        family: 'scenario_clarify',
        allowed_query_sources: ['agent_products_search'],
        must_equal_metadata: expect.objectContaining({
          'search_trace.final_decision': 'clarify',
          'search_decision.decision_authority': 'agent_products_search',
          'search_decision.decision_locked': true,
          'route_health.fallback_triggered': false,
        }),
        must_have_clarification: true,
        must_have_reason_codes: ['AMBIGUITY_CLARIFY'],
      }),
    ]);

    expect(loadStagingMatrixPayload(corpusPath).semantic_cases).toEqual([
      expect.objectContaining({
        id: 'clarify_case',
        family: 'scenario_clarify',
        ownership: expect.objectContaining({
          must_equal_paths: expect.objectContaining({
            'metadata.search_trace.final_decision': 'clarify',
            'metadata.search_decision.decision_authority': 'agent_products_search',
            'metadata.search_decision.decision_locked': true,
            'metadata.route_health.fallback_triggered': false,
          }),
        }),
        observability: expect.objectContaining({
          must_have_paths: expect.arrayContaining([
            'metadata.service_version.commit',
            'metadata.search_trace.final_decision',
            'metadata.search_decision.decision_authority',
            'metadata.search_decision.decision_locked',
            'metadata.route_health.fallback_triggered',
          ]),
        }),
        correctness: expect.objectContaining({
          must_have_clarification: true,
          must_have_reason_codes: ['AMBIGUITY_CLARIFY'],
        }),
      }),
    ]);
  });

  test('actual shared corpus expands canonical main-path coverage across search, shopping_agent, and aurora-bff surfaces', () => {
    const corpusPath = path.join(
      __dirname,
      '..',
      'scripts',
      'fixtures',
      'celestial_commerce_core_shared_acceptance_corpus.json',
    );

    const prodIds = new Set(loadProdGateCases(corpusPath).map((item) => item.id));
    const stagingIds = new Set(
      loadStagingMatrixPayload(corpusPath).semantic_cases.map((item) => item.id),
    );

    expect(Array.from(prodIds)).toEqual(
      expect.arrayContaining([
        'shopping_agent_exact_ipsa_time_reset_aqua',
        'search_exact_ipsa_time_reset_aqua',
        'aurora_bff_exact_ipsa_time_reset_aqua',
        'shopping_agent_merchant_query_ipsa_products',
        'aurora_bff_merchant_query_ipsa_products',
        'search_merchant_query_winona_products',
        'shopping_agent_strict_vitamin_c_serum',
        'aurora_bff_strict_vitamin_c_serum',
        'search_strict_vitamin_c_serum_budget_eur',
        'search_strict_vitamin_c_serum_budget_usd',
      ]),
    );

    expect(Array.from(stagingIds)).toEqual(
      expect.arrayContaining([
        'search_clarify_date_makeup_locale_zh',
        'search_exact_ipsa_time_reset_aqua',
        'search_exact_ipsa_time_reset_aqua_locale_zh',
        'search_exactish_niacinamide_locale_en',
        'search_merchant_query_winona_products',
        'search_merchant_query_winona_products_locale_en',
        'search_public_serum_default_locale_zh',
        'shopping_agent_strict_vitamin_c_serum',
        'search_strict_vitamin_c_serum_budget_eur',
        'search_strict_vitamin_c_serum_budget_usd',
        'search_strict_vitamin_c_serum_budget_usd_locale_en',
      ]),
    );
  });

  test('actual shared corpus expands bilingual prompt coverage across fresh and resume orchestration turns', () => {
    const corpusPath = path.join(
      __dirname,
      '..',
      'scripts',
      'fixtures',
      'celestial_commerce_core_shared_acceptance_corpus.json',
    );

    const promptCases = loadPromptLiveSmokeCases(corpusPath);
    const promptIds = new Set(promptCases.map((item) => item.id));
    const englishPrompt = promptCases.find((item) => item.id === 'prompt_clarify_date_night_en');
    const englishResume = promptCases.find(
      (item) => item.id === 'conversation_progress_resume_date_night_en',
    );

    expect(Array.from(promptIds)).toEqual(
      expect.arrayContaining([
        'prompt_clarify_date_makeup',
        'prompt_clarify_date_makeup_locale_zh',
        'prompt_clarify_date_night_en',
        'conversation_progress_resume_date_selection',
        'conversation_progress_resume_date_night_en',
        'followup_refinement_lightweight',
        'followup_refinement_lightweight_locale_zh',
      ]),
    );
    expect(englishPrompt?.request?.headers).toEqual(
      expect.objectContaining({
        'X-Lang': 'EN',
      }),
    );
    expect(englishResume?.request?.headers).toEqual(
      expect.objectContaining({
        'X-Lang': 'EN',
      }),
    );
    expect(
      promptCases.find((item) => item.id === 'followup_refinement_lightweight_locale_zh')?.request
        ?.headers,
    ).toEqual(
      expect.objectContaining({
        'X-Lang': 'CN',
      }),
    );
    expect(
      promptCases.find((item) => item.id === 'prompt_clarify_date_makeup_locale_zh')?.request
        ?.headers,
    ).toEqual(
      expect.objectContaining({
        'X-Lang': 'CN',
      }),
    );
  });

  test('actual shared corpus expands locale-aware commerce query staging coverage without changing prod authority rules', () => {
    const corpusPath = path.join(
      __dirname,
      '..',
      'scripts',
      'fixtures',
      'celestial_commerce_core_shared_acceptance_corpus.json',
    );

    const stagingCases = loadStagingMatrixPayload(corpusPath).semantic_cases;
    const prodIds = new Set(loadProdGateCases(corpusPath).map((item) => item.id));
    const zhClarify = stagingCases.find((item) => item.id === 'search_clarify_date_makeup_locale_zh');
    const zhBroad = stagingCases.find((item) => item.id === 'search_public_serum_default_locale_zh');
    const zhExact = stagingCases.find((item) => item.id === 'search_exact_ipsa_time_reset_aqua_locale_zh');
    const enExactish = stagingCases.find((item) => item.id === 'search_exactish_niacinamide_locale_en');
    const enMerchant = stagingCases.find(
      (item) => item.id === 'search_merchant_query_winona_products_locale_en',
    );
    const enBudget = stagingCases.find(
      (item) => item.id === 'search_strict_vitamin_c_serum_budget_usd_locale_en',
    );

    expect(zhExact).toEqual(
      expect.objectContaining({
        family: 'exact_product_lookup',
        headers: expect.objectContaining({
          'X-Lang': 'CN',
        }),
      }),
    );
    expect(zhExact?.request?.metadata).toEqual(
      expect.objectContaining({
        source: 'search',
        locale: 'zh-CN',
      }),
    );
    expect(zhBroad).toEqual(
      expect.objectContaining({
        family: 'broad_discovery',
        headers: expect.objectContaining({
          'X-Lang': 'CN',
        }),
      }),
    );
    expect(zhBroad?.request?.metadata).toEqual(
      expect.objectContaining({
        source: 'search',
        locale: 'zh-CN',
      }),
    );
    expect(zhClarify).toEqual(
      expect.objectContaining({
        family: 'scenario_clarify',
        headers: expect.objectContaining({
          'X-Lang': 'CN',
        }),
      }),
    );
    expect(zhClarify?.request?.metadata).toEqual(
      expect.objectContaining({
        source: 'search',
        locale: 'zh-CN',
      }),
    );
    expect(enExactish).toEqual(
      expect.objectContaining({
        family: 'exactish_lookup',
        headers: expect.objectContaining({
          'X-Lang': 'EN',
        }),
      }),
    );
    expect(enExactish?.request?.metadata).toEqual(
      expect.objectContaining({
        source: 'search',
        locale: 'en-US',
      }),
    );
    expect(enMerchant).toEqual(
      expect.objectContaining({
        family: 'merchant_query',
        headers: expect.objectContaining({
          'X-Lang': 'EN',
        }),
      }),
    );
    expect(enMerchant?.request?.metadata).toEqual(
      expect.objectContaining({
        source: 'search',
        locale: 'en-US',
      }),
    );
    expect(enBudget).toEqual(
      expect.objectContaining({
        family: 'strict_ingredient_budget',
        headers: expect.objectContaining({
          'X-Lang': 'EN',
        }),
      }),
    );
    expect(enBudget?.request?.metadata).toEqual(
      expect.objectContaining({
        source: 'search',
        locale: 'en-US',
      }),
    );
    expect(prodIds.has('search_exactish_niacinamide_locale_en')).toBe(false);
    expect(prodIds.has('search_strict_vitamin_c_serum_budget_usd_locale_en')).toBe(false);
    expect(prodIds.has('search_public_serum_default_locale_zh')).toBe(false);
    expect(prodIds.has('search_clarify_date_makeup_locale_zh')).toBe(false);
  });
});
