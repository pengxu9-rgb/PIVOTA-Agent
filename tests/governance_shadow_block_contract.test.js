describe('governance shadow block contract', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      API_MODE: 'MOCK',
      INVOKE_AUTH_BYPASS_IN_TEST: '1',
      PIVOTA_GATEWAY_GOVERNANCE_SHADOW_MODE: '1',
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('normalizes governance shadow block soft fallback into non-degraded governed response', () => {
    const app = require('../src/server');
    const input = {
      products: [],
      clarification: {
        question: 'Do you have a brand preference?',
      },
      metadata: {
        query_source: 'agent_products_error_fallback',
        strict_empty: true,
        strict_empty_reason: 'primary_irrelevant_no_fallback',
        proxy_search_fallback: {
          applied: true,
          reason: 'primary_irrelevant_no_fallback',
        },
        search_decision: {
          final_decision: 'clarify',
          clarify_triggered: true,
        },
        gateway_governance: {
          mode: 'shadow',
          observed_action: 'block',
          would_enforce: true,
          reason_codes: ['layer_not_allowed'],
        },
      },
    };

    const normalized = app._debug.normalizeGovernanceShadowBlockContract(input);

    expect(normalized.metadata).toEqual(
      expect.objectContaining({
        query_source: 'gateway_governance_shadow_block',
        proxy_search_fallback: expect.objectContaining({
          applied: false,
          reason: null,
        }),
        search_decision: expect.objectContaining({
          final_decision: 'governance_shadow_block',
          clarify_triggered: false,
        }),
        governance_shadow_contract: expect.objectContaining({
          normalized: true,
          recovery_reason: 'layer_not_allowed_shadow_block',
          original_query_source: 'agent_products_error_fallback',
          original_final_decision: 'clarify',
        }),
      }),
    );
    expect(normalized.metadata.strict_empty).toBeUndefined();
    expect(normalized.metadata.strict_empty_reason).toBeUndefined();
    expect(normalized.clarification).toBeNull();
  });

  test('leaves non-governed or healthy responses unchanged', () => {
    const app = require('../src/server');
    const input = {
      products: [{ product_id: 'p1', title: 'Healthy Serum' }],
      metadata: {
        query_source: 'cache_cross_merchant_search',
        gateway_governance: {
          mode: 'shadow',
          observed_action: 'allow',
          would_enforce: false,
          reason_codes: [],
        },
      },
    };

    const normalized = app._debug.normalizeGovernanceShadowBlockContract(input);
    expect(normalized).toEqual(input);
  });
});
