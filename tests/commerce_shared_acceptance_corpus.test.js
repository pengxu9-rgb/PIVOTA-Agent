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
        must_have_metadata: ['service_version.commit'],
        allowed_query_sources: ['cache_cross_merchant_search'],
        must_equal_metadata: {
          'search_trace.final_decision': 'cache_returned',
        },
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
            must_equal_paths: {
              'metadata.search_trace.query_class': 'lookup',
              'metadata.search_trace.final_decision': 'cache_returned',
            },
          },
          observability: {
            must_have_paths: [
              'metadata.service_version.commit',
              'metadata.query_source',
              'metadata.search_trace.query_class',
            ],
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
                      'meta.prompt_intent': 'scenario_selection',
                      'meta.conversation_progress': 'scenario_selected',
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
            'meta.prompt_intent': 'scenario_selection',
            'meta.conversation_progress': 'scenario_selected',
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
        ]),
        must_equal_metadata: expect.objectContaining({
          'contract_bridge.resolved_contract': 'shop_invoke_strict',
          strict_constraint_query: true,
          strict_constraint_reason: 'ingredient',
        }),
      }),
    ]);

    expect(loadStagingMatrixPayload(corpusPath).semantic_cases).toEqual([
      expect.objectContaining({
        id: 'exactish_case',
        family: 'exactish_lookup',
        ownership: expect.objectContaining({
          must_equal_paths: {
            'metadata.contract_bridge.resolved_contract': 'shop_invoke_strict',
            'metadata.strict_constraint_query': true,
            'metadata.strict_constraint_reason': 'ingredient',
          },
          must_have_paths: ['metadata.matched_ingredient_ids.0'],
        }),
        observability: expect.objectContaining({
          must_have_paths: [
            'metadata.service_version.commit',
            'metadata.search_trace.final_decision',
          ],
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
          must_equal_paths: {
            'metadata.search_trace.final_decision': 'clarify',
          },
        }),
        observability: expect.objectContaining({
          must_have_paths: [
            'metadata.service_version.commit',
            'metadata.search_trace.final_decision',
          ],
        }),
        correctness: expect.objectContaining({
          must_have_clarification: true,
          must_have_reason_codes: ['AMBIGUITY_CLARIFY'],
        }),
      }),
    ]);
  });
});
