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

  test('records governance shadow block as observer-only and preserves the locked response contract', () => {
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
        query_source: 'agent_products_error_fallback',
        search_decision: expect.objectContaining({
          final_decision: 'clarify',
          decision_authority: 'agent_products_error_fallback',
        }),
        route_health: expect.objectContaining({
          fallback_triggered: true,
          fallback_reason: 'primary_irrelevant_no_fallback',
          primary_path_used: 'invoke_primary_fallback',
          primary_path_degraded: true,
          observer_nodes: expect.arrayContaining(['governance_shadow_block_observed']),
        }),
        governance_shadow_contract: expect.objectContaining({
          normalized: false,
          observer_only: true,
          recovery_reason: 'layer_not_allowed_shadow_block',
          original_query_source: 'agent_products_error_fallback',
          original_final_decision: 'clarify',
          governance_reason_codes: ['layer_not_allowed'],
        }),
      }),
    );
    expect(normalized.reason_codes).toEqual(expect.arrayContaining(['layer_not_allowed']));
    expect(normalized.metadata.strict_empty).toBe(true);
    expect(normalized.metadata.strict_empty_reason).toBe('primary_irrelevant_no_fallback');
    expect(normalized.clarification).toEqual(input.clarification);
  });

  test('records governance shadow block on resolver fallback responses without rewriting authority', () => {
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
    expect(normalized.reason_codes).toEqual(expect.arrayContaining(['deep_pagination_blocked']));
    expect(normalized.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_resolver_fallback',
        search_decision: expect.objectContaining({
          final_decision: 'resolver_returned',
          decision_authority: 'agent_products_resolver_fallback',
        }),
        route_health: expect.objectContaining({
          fallback_triggered: true,
          fallback_reason: 'resolver_after_primary',
          primary_path_used: 'resolver_fallback',
          primary_path_degraded: true,
          observer_nodes: expect.arrayContaining(['governance_shadow_block_observed']),
        }),
        governance_shadow_contract: expect.objectContaining({
          normalized: false,
          observer_only: true,
          recovery_reason: 'deep_pagination_blocked_shadow_block',
          governance_reason_codes: ['deep_pagination_blocked'],
        }),
      }),
    );
  });

  test('preserves response authority after gateway audit metadata is merged in shadow mode', () => {
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

    expect(normalized.reason_codes).toEqual(
      expect.arrayContaining(['FILTERED_TO_EMPTY', 'layer_not_allowed']),
    );
    expect(normalized.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_error_fallback',
        governance_shadow_contract: expect.objectContaining({
          normalized: false,
          observer_only: true,
          recovery_reason: 'layer_not_allowed_shadow_block',
          original_query_source: 'agent_products_error_fallback',
        }),
        route_health: expect.objectContaining({
          fallback_triggered: true,
          primary_path_degraded: true,
          primary_path_used: 'upstream_stage',
          observer_nodes: expect.arrayContaining(['governance_shadow_block_observed']),
        }),
      }),
    );
    expect(normalized.clarification).toEqual(input.clarification);
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
