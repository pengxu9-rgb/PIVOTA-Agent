const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PROD_CANARY_SELECTORS,
  PROD_CANARY_CASE_IDS,
  buildProdCanaryView,
  buildProdGateView,
  buildPromptLiveSmokeView,
  buildStagingAcceptanceMatrixView,
} = require('../scripts/lib/commerce_shared_acceptance_views');

describe('Commerce shared acceptance views', () => {
  test('projects shared corpus into legacy prod and staging fixture views', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-shared-views-'));
    const corpusPath = path.join(outDir, 'shared-corpus.json');

    fs.writeFileSync(
      corpusPath,
      JSON.stringify(
        {
          schema_version: 'celestial.commerce_core.acceptance_corpus.v1',
          cases: [
            {
              id: 'public_search_serum_default',
              family: 'public_search_contract',
              source: 'search',
              targets: {
                prod_gate: {
                  query: 'serum',
                  source: 'search',
                },
              },
            },
            {
              id: 'shopping_agent_clarify_date_makeup',
              family: 'scenario_clarify',
              source: 'shopping_agent',
              targets: {
                prod_gate: {
                  query: '有什么适合今晚约会的',
                  source: 'shopping_agent',
                },
              },
            },
            {
              id: 'shopping_agent_strict_niacinamide',
              family: 'exactish_lookup',
              source: 'shopping_agent',
              targets: {
                prod_gate: {
                  query: 'niacinamide serum',
                  source: 'shopping_agent',
                },
              },
            },
            {
              id: 'search_public_serum_default',
              family: 'broad_discovery',
              targets: {
                staging_matrix: {
                  kind: 'semantic',
                  request: {
                    operation: 'find_products_multi',
                  },
                },
              },
            },
            {
              id: 'prompt_clarify_date_makeup',
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
              id: 'public_direct_api_deep_pagination_blocked',
              family: 'governance_deep_pagination',
              targets: {
                staging_matrix: {
                  kind: 'governance',
                  request: {
                    operation: 'find_products_multi',
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

    expect(buildProdGateView(corpusPath)).toEqual([
      expect.objectContaining({
        id: 'public_search_serum_default',
        family: 'public_search_contract',
      }),
      expect.objectContaining({
        id: 'shopping_agent_clarify_date_makeup',
        family: 'scenario_clarify',
      }),
      expect.objectContaining({
        id: 'shopping_agent_strict_niacinamide',
        family: 'exactish_lookup',
      }),
    ]);

    expect(buildProdCanaryView(corpusPath).map((item) => item.id)).toEqual([
      'public_search_serum_default',
      'shopping_agent_strict_niacinamide',
      'shopping_agent_clarify_date_makeup',
    ]);
    expect(PROD_CANARY_SELECTORS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: 'exactish_lookup',
          source: 'shopping_agent',
        }),
      ]),
    );
    expect(PROD_CANARY_CASE_IDS).toContain('public_search_serum_default');
    expect(PROD_CANARY_CASE_IDS).toContain('shopping_agent_strict_niacinamide');
    expect(PROD_CANARY_CASE_IDS).toContain('shopping_agent_clarify_date_makeup');

    expect(buildStagingAcceptanceMatrixView(corpusPath)).toEqual({
      semantic_cases: [
        expect.objectContaining({
          id: 'search_public_serum_default',
          family: 'broad_discovery',
        }),
      ],
      governance_cases: [
        expect.objectContaining({
          id: 'public_direct_api_deep_pagination_blocked',
          family: 'governance_deep_pagination',
          kind: 'governance',
        }),
      ],
    });

    expect(buildPromptLiveSmokeView(corpusPath)).toEqual({
      prompt_cases: [
        expect.objectContaining({
          id: 'prompt_clarify_date_makeup',
          family: 'prompt_clarify',
          correctness: expect.objectContaining({
            expect_http_status: 200,
          }),
        }),
      ],
    });
  });
});
