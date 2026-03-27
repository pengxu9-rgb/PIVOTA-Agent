const { createShoppingContext } = require('../src/modules/contracts/shoppingContext');
const { resolveSourceProfile } = require('../src/api/gateway/sourceProfiles');
const { prepareGatewayGovernanceEnvelope } = require('../src/api/gateway/layerDispatcher');

describe('Celestial gateway boundary guards', () => {
  test('ShoppingContext rejects invocation and access metadata', () => {
    expect(() =>
      createShoppingContext({
        source_profile: resolveSourceProfile('search'),
        task_type: 'exact_product',
        invocation_context: {
          request_id: 'inv_1',
        },
      }),
    ).toThrow(/SHOPPING_CONTEXT_INVALID/);

    expect(() =>
      createShoppingContext({
        source_profile: resolveSourceProfile('shopping_agent'),
        task_type: 'discovery',
        agent_identity: {
          principal_id: 'public:1',
        },
      }),
    ).toThrow(/SHOPPING_CONTEXT_INVALID/);
  });

  test('gateway governance envelope keeps protocol and access state outside business context', () => {
    const envelope = prepareGatewayGovernanceEnvelope({
      invocation_surface: 'mcp',
      source: 'shopping_agent',
      task_type: 'discovery',
      context: {
        vertical: 'beauty',
        category: 'skincare',
        raw_user_goal: 'find soothing serum',
      },
    });

    expect(envelope.invocation_context.invocation_profile.surface).toBe('mcp');
    expect(envelope.agent_identity.principal_type).toBe('mcp_agent');
    expect(envelope.query_governance_decision).toBeTruthy();
  });
});
