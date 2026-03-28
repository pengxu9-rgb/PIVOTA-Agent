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
        route_health: {
          fallback_triggered: true,
          fallback_reason: 'primary_irrelevant_no_fallback',
          primary_path_used: 'invoke_primary_fallback',
          primary_path_degraded: true,
        },
        gateway_governance: {
          mode: 'shadow',
          observed_action: 'block',
          would_enforce: true,
          query_governance: {
            reason_codes: ['layer_not_allowed'],
          },
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
          primary_path_used: 'governance_shadow_block',
        }),
        search_trace: expect.objectContaining({
          final_decision: 'governance_shadow_block',
          primary_path_used: 'governance_shadow_block',
        }),
        route_health: expect.objectContaining({
          fallback_triggered: false,
          fallback_reason: null,
          primary_path_used: 'governance_shadow_block',
          primary_path_degraded: false,
        }),
        governance_shadow_contract: expect.objectContaining({
          normalized: true,
          recovery_reason: 'layer_not_allowed_shadow_block',
          original_query_source: 'agent_products_error_fallback',
          original_final_decision: 'clarify',
          governance_reason_codes: ['layer_not_allowed'],
        }),
      }),
    );
    expect(normalized.reason_codes).toEqual(['layer_not_allowed']);
    expect(normalized.metadata.strict_empty).toBeUndefined();
    expect(normalized.metadata.strict_empty_reason).toBeUndefined();
    expect(normalized.clarification).toBeNull();
  });

  test('normalizes resolver fallback shadow block responses while preserving returned products', () => {
    const app = require('../src/server');
    const input = {
      products: [{ product_id: 'p1', title: 'IPSA Time Reset Aqua' }],
      metadata: {
        query_source: 'agent_products_resolver_fallback',
        proxy_search_fallback: {
          applied: true,
          reason: 'resolver_after_primary',
        },
        search_decision: {
          final_decision: 'resolver_returned',
          primary_path_used: 'resolver_fallback',
        },
        route_health: {
          fallback_triggered: true,
          fallback_reason: 'resolver_after_primary',
          primary_path_used: 'resolver_fallback',
          primary_path_degraded: true,
        },
        gateway_governance: {
          mode: 'shadow',
          observed_action: 'block',
          would_enforce: true,
          query_governance: {
            reason_codes: ['deep_pagination_blocked'],
          },
        },
      },
    };

    const normalized = app._debug.normalizeGovernanceShadowBlockContract(input);

    expect(normalized.products).toEqual(input.products);
    expect(normalized.reason_codes).toEqual(['deep_pagination_blocked']);
    expect(normalized.metadata).toEqual(
      expect.objectContaining({
        query_source: 'gateway_governance_shadow_block',
        proxy_search_fallback: expect.objectContaining({
          applied: false,
          reason: null,
        }),
        route_health: expect.objectContaining({
          fallback_triggered: false,
          fallback_reason: null,
          primary_path_used: 'governance_shadow_block',
          primary_path_degraded: false,
        }),
        governance_shadow_contract: expect.objectContaining({
          recovery_reason: 'deep_pagination_blocked_shadow_block',
          governance_reason_codes: ['deep_pagination_blocked'],
        }),
      }),
    );
  });

  test('normalizes shadow block after gateway audit metadata is merged in the response wrapper path', () => {
    const app = require('../src/server');
    const input = {
      products: [],
      clarification: {
        question: 'Do you have a brand preference?',
      },
      reason_codes: ['FILTERED_TO_EMPTY'],
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
        route_health: {
          fallback_triggered: true,
          fallback_reason: 'primary_irrelevant_no_fallback',
          primary_path_used: 'upstream_stage',
          primary_path_degraded: true,
        },
      },
    };
    const gatewayAudit = {
      mode: 'shadow',
      source: 'aurora-bff',
      entry_layer: 'orchestration',
      task_type: 'discovery',
      effective_action: 'allow',
      observed_phase: 'query_governance',
      observed_action: 'block',
      would_enforce: true,
      reason_codes: ['layer_not_allowed'],
      invocation: {
        surface: 'direct_api',
      },
      access: {},
      rate_limit: {
        allowed: true,
        action: 'allow',
        reason_codes: [],
        profile_id: 'public_api_agent',
      },
      query_governance: {
        allowed: false,
        action: 'block',
        reason_codes: ['layer_not_allowed'],
      },
    };

    const merged = app._debug.mergeInvokeGatewayAuditMetadata(input, gatewayAudit);
    const normalized = app._debug.normalizeGovernanceShadowBlockContract(merged);

    expect(normalized.reason_codes).toEqual(['layer_not_allowed']);
    expect(normalized.metadata).toEqual(
      expect.objectContaining({
        query_source: 'gateway_governance_shadow_block',
        governance_shadow_contract: expect.objectContaining({
          normalized: true,
          recovery_reason: 'layer_not_allowed_shadow_block',
          original_query_source: 'agent_products_error_fallback',
        }),
        route_health: expect.objectContaining({
          fallback_triggered: false,
          primary_path_degraded: false,
          primary_path_used: 'governance_shadow_block',
        }),
      }),
    );
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
