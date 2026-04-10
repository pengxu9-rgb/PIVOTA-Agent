const {
  buildInvokeIngressGatewayInput,
} = require('../src/api/gateway/invocation/buildInvokeIngressGatewayInput');
const { prepareGatewayGovernanceEnvelope } = require('../src/api/gateway/layerDispatcher');
const { buildGatewayShadowAudit } = require('../src/api/gateway/access/buildGatewayShadowAudit');

describe('Celestial gateway invoke ingress modeling', () => {
  test('maps exact-resolution invoke operations to execution-facing governance input', () => {
    const buildInput = (operation) => buildInvokeIngressGatewayInput({
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
      operation,
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
    const input = buildInput('get_pdp_v2');

    expect(input.requested_layer).toBe('execution_facing');
    expect(input.task_type).toBe('exact_product');
    expect(input.invocation_surface).toBe('direct_api');

    for (const operation of [
      'get_product_intel_v1',
      'get_product_feedback_v1',
      'get_product_recommendation_intents_v1',
    ]) {
      expect(buildInput(operation)).toEqual(
        expect.objectContaining({
          requested_layer: 'execution_facing',
          task_type: 'exact_product',
        }),
      );
    }

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
});
