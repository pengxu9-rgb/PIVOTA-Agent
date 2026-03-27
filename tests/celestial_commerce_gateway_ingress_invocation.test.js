const {
  buildInvokeIngressGatewayInput,
} = require('../src/api/gateway/invocation/buildInvokeIngressGatewayInput');
const { prepareGatewayGovernanceEnvelope } = require('../src/api/gateway/layerDispatcher');
const { buildGatewayShadowAudit } = require('../src/api/gateway/access/buildGatewayShadowAudit');

describe('Celestial gateway invoke ingress modeling', () => {
  test('maps exact-resolution invoke operations to execution-facing governance input', () => {
    const input = buildInvokeIngressGatewayInput({
      req: {
        path: '/agent/shop/v1/invoke',
        method: 'POST',
        headers: {
          'x-pivota-invocation-surface': 'direct_api',
          'x-pivota-protocol-version': '2026-03-26',
        },
        invokeAuth: {
          agent_id: 'agent_exact_1',
          auth_mode: 'api_key',
          auth_source: 'x-agent-api-key',
          key_fingerprint: 'fp_exact_1',
        },
      },
      routeContext: {
        client_channel: 'shop',
        orchestrator_path: 'external_invoke_route',
        invocation_surface: 'direct_api',
      },
      operation: 'get_pdp_v2',
      payload: {
        product: {
          merchant_id: 'merchant_demo',
          product_id: 'BOTTLE_001',
        },
      },
      metadata: {
        source: 'shopping_agent',
        requested_result_depth: 'deep_resolution',
      },
      request_id: 'req_exact_1',
    });

    expect(input.requested_layer).toBe('execution_facing');
    expect(input.task_type).toBe('exact_product');
    expect(input.invocation_surface).toBe('direct_api');

    const envelope = prepareGatewayGovernanceEnvelope(input);
    const audit = buildGatewayShadowAudit(envelope, { shadow_mode: true });

    expect(envelope.entry_layer).toBe('execution_facing');
    expect(envelope.agent_identity.principal_type).toBe('public_agent');
    expect(audit.mode).toBe('shadow');
    expect(audit.query_governance.action).toBe('downgrade');
    expect(audit.query_governance.effective_result_depth).toBe('bounded_results');
    expect(audit.observed_action).toBe('downgrade');
    expect(audit.would_enforce).toBe(true);
  });

  test('implicit authenticated aurora invoke keeps orchestration access on the standard invoke rail', () => {
    const input = buildInvokeIngressGatewayInput({
      req: {
        path: '/agent/shop/v1/invoke',
        method: 'POST',
        headers: {},
        invokeAuth: {
          agent_id: 'agent_aurora_1',
          auth_mode: 'api_key',
          auth_source: 'authorization_bearer',
          introspect_auth_source: 'api_keys',
          key_fingerprint: 'fp_aurora_1',
        },
      },
      routeContext: {
        client_channel: 'shop',
        orchestrator_path: 'external_invoke_route',
        invocation_surface: 'direct_api',
      },
      operation: 'find_products_multi',
      payload: {
        search: {
          query: 'serum',
          limit: 6,
        },
      },
      metadata: {
        source: 'aurora-bff',
      },
      request_id: 'req_aurora_1',
    });

    const envelope = prepareGatewayGovernanceEnvelope(input);
    const audit = buildGatewayShadowAudit(envelope, { shadow_mode: true });

    expect(input.invocation_surface).toBe('direct_api');
    expect(input.raw_auth_claims?.invocation_surface_declared).toBeUndefined();
    expect(envelope.entry_layer).toBe('orchestration');
    expect(envelope.agent_identity.principal_type).toBe('public_agent');
    expect(envelope.access_scope.allowed_layers).toEqual(expect.arrayContaining(['orchestration']));
    expect(envelope.access_scope.allowed_sources).toEqual(expect.arrayContaining(['aurora-bff']));
    expect(envelope.query_governance_decision.allowed).toBe(true);
    expect(audit.observed_action).toBe('allow');
    expect(audit.would_enforce).toBe(false);
  });

  test('explicit public direct_api aurora probe remains shadow-blocked at orchestration entry', () => {
    const input = buildInvokeIngressGatewayInput({
      req: {
        path: '/agent/shop/v1/invoke',
        method: 'POST',
        headers: {
          'x-pivota-invocation-surface': 'direct_api',
        },
        invokeAuth: {
          agent_id: 'agent_aurora_2',
          auth_mode: 'api_key',
          auth_source: 'authorization_bearer',
          introspect_auth_source: 'api_keys',
          key_fingerprint: 'fp_aurora_2',
        },
      },
      routeContext: {
        client_channel: 'shop',
        orchestrator_path: 'external_invoke_route',
        invocation_surface: 'direct_api',
      },
      operation: 'find_products_multi',
      payload: {
        search: {
          query: 'repair serum',
          limit: 5,
        },
      },
      metadata: {
        source: 'aurora-bff',
      },
      request_id: 'req_aurora_2',
    });

    const envelope = prepareGatewayGovernanceEnvelope(input);
    const audit = buildGatewayShadowAudit(envelope, { shadow_mode: true });

    expect(input.raw_auth_claims?.invocation_surface_declared).toBe(true);
    expect(envelope.entry_layer).toBe('orchestration');
    expect(envelope.agent_identity.principal_type).toBe('public_agent');
    expect(envelope.query_governance_decision.allowed).toBe(false);
    expect(envelope.query_governance_decision.reason_codes).toContain('layer_not_allowed');
    expect(audit.observed_action).toBe('block');
    expect(audit.would_enforce).toBe(true);
  });
});
