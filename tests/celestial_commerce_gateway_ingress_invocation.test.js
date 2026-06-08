jest.mock('openai', () => function OpenAI() { return {}; }, { virtual: true });
jest.mock('../src/modules/decisioning/shopping_agent', () => ({
  handleShoppingAgentDecisioning: async () => ({
    layer: 'decisioning',
    status: 'no_match',
    updated_context: {
      context_id: 'mock_ctx',
      source_profile: null,
      task_type: 'discovery',
      vertical: 'beauty',
      category: 'skincare',
      raw_user_goal: null,
      normalized_need: {},
      conversation_state: {},
      decision_state: {},
      execution_state: {},
    },
    ranked_candidates: [],
    compare_matrix: [],
    delegation_plan: 'stay_in_layer',
  }),
}));

const {
  buildInvokeIngressGatewayInput,
  resolveInvokeRequestedLayerWithInput,
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

  test('maps checkout_handoff to execution-facing and requires explicit handoff scope', () => {
    const buildInput = (metadata = {}) => buildInvokeIngressGatewayInput({
      req: {
        path: '/agent/shop/v1/invoke',
        method: 'POST',
        headers: {},
        invokeAuth: {
          agent_id: 'agent_checkout_1',
          auth_mode: 'api_key',
          auth_source: 'x-agent-api-key',
          key_fingerprint: 'fp_checkout_1',
        },
      },
      routeContext: {
        client_channel: 'shop',
        orchestrator_path: 'external_invoke_route',
        invocation_surface: 'direct_api',
      },
      operation: 'checkout_handoff',
      payload: {
        handoff_descriptor: {
          status: 'eligible',
          kind: 'pivota_agent_checkout_handoff',
          merchant_id: 'merch_1',
          product_key: 'prod::merch_1::shopify::p1',
          sku_key: 'sku_1',
          pivota_signature_id: 'sig_1',
          commerce_path: 'pivota_direct_quote_first',
          source_deliverability_status: 'transactable',
        },
      },
      metadata: {
        source: 'shopping_agent',
        ...metadata,
      },
      request_id: 'req_checkout_1',
    });

    const blockedInput = buildInput();
    expect(blockedInput.requested_layer).toBe('execution_facing');
    expect(blockedInput.task_type).toBe('exact_product');
    expect(blockedInput.governance_hints.request_checkout_handoff).toBe(true);

    const blockedEnvelope = prepareGatewayGovernanceEnvelope(blockedInput);
    expect(blockedEnvelope.access_scope.allow_checkout_handoff).toBe(false);
    expect(blockedEnvelope.query_governance_decision.allowed).toBe(false);
    expect(blockedEnvelope.query_governance_decision.reason_codes).toContain(
      'checkout_handoff_not_allowed',
    );

    const allowedEnvelope = prepareGatewayGovernanceEnvelope(
      buildInput({ allow_checkout_handoff: true, partner_tier: 'flagship' }),
    );
    expect(allowedEnvelope.access_scope.allow_checkout_handoff).toBe(true);
    expect(allowedEnvelope.query_governance_decision.allowed).toBe(true);
  });

  test('routes shopping-agent beauty discovery through orchestration when auto-delegate is allowed', () => {
    const input = buildInvokeIngressGatewayInput({
      req: {
        path: '/agent/shop/v1/invoke',
        method: 'POST',
        headers: {},
        invokeAuth: {},
      },
      routeContext: {
        client_channel: 'shop',
        orchestrator_path: 'external_invoke_route',
      },
      operation: 'find_products_multi',
      payload: {
        search: {
          query: 'I have oily skin, what sunscreen should I buy?',
        },
      },
      metadata: {
        source: 'shopping_agent',
        allow_orchestration_delegate: true,
      },
      request_id: 'req_beauty_1',
    });

    expect(input.requested_layer).toBe('orchestration');
  });

  test('creator-agent beauty discovery also resolves to orchestration while creator remains a decisioning source by default', () => {
    expect(
      resolveInvokeRequestedLayerWithInput('find_products_multi', 'creator_agent', {
        payload: {
          search: {
            query: 'my audience has dry sensitive skin, what moisturizer should I recommend?',
          },
        },
        metadata: {
          allow_orchestration_delegate: true,
        },
      }),
    ).toBe('orchestration');

    expect(
      resolveInvokeRequestedLayerWithInput('find_products_multi', 'creator_agent', {
        payload: {
          search: {
            query: 'red shirt',
          },
        },
        metadata: {},
      }),
    ).toBe('decisioning');
  });
});
