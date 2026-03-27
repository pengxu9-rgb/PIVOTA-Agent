const baseline = require('../scripts/fixtures/celestial_commerce_gateway_governance_baseline.json');
const {
  prepareGatewayGovernanceEnvelope,
  dispatchCommerceLayer,
} = require('../src/api/gateway/layerDispatcher');

describe('Celestial gateway access governance', () => {
  test.each(baseline)('$id builds the expected governance envelope', (spec) => {
    const envelope = prepareGatewayGovernanceEnvelope(spec);
    expect(envelope.entry_layer).toBe(spec.expected_entry_layer);
    expect(envelope.invocation_context.invocation_profile.surface).toBe(spec.invocation_surface);

    if (spec.expected_action === 'allow') {
      expect(envelope.rate_limit_decision.allowed).toBe(true);
      expect(envelope.query_governance_decision.allowed).toBe(true);
    } else {
      expect(envelope.query_governance_decision.action).toBe(spec.expected_action);
      expect(envelope.query_governance_decision.reason_codes).toContain(spec.expected_reason_code);
    }
  });

  test.each(baseline)('$id dispatch outcome matches governance decision', async (spec) => {
    const result = await dispatchCommerceLayer({
      ...spec,
      context: {
        vertical: 'beauty',
        category: 'skincare',
        raw_user_goal: spec.id,
      },
      messages:
        spec.expected_entry_layer === 'orchestration'
          ? [{ role: 'user', content: 'help me shop' }]
          : [],
    });

    if (spec.expected_action === 'allow') {
      expect(result.layer).toBe(spec.expected_entry_layer);
      expect(result.gateway_governance.action).toBe(spec.expected_action);
    } else {
      expect(result.status).toBe('blocked');
      expect(result.action).toBe(spec.expected_action);
      expect(result.reason_codes).toContain(spec.expected_reason_code);
    }
  });

  test('public api exact resolution downgrades requested deep result depth', async () => {
    const result = await dispatchCommerceLayer({
      invocation_surface: 'direct_api',
      source: 'search',
      task_type: 'exact_product',
      requested_result_depth: 'deep_resolution',
      context: {
        vertical: 'beauty',
        category: 'skincare',
        raw_user_goal: 'resolve exact product',
      },
    });
    expect(result.layer).toBe('execution_facing');
    expect(result.gateway_governance.action).toBe('downgrade');
    expect(result.gateway_governance.effective_result_depth).toBe('bounded_results');
  });

  test('rate limit profile throttles requests before business dispatch', async () => {
    const result = await dispatchCommerceLayer({
      invocation_surface: 'direct_api',
      source: 'search',
      task_type: 'exact_product',
      usage_snapshot: {
        requests_in_last_minute: 25,
      },
      context: {
        vertical: 'beauty',
        category: 'skincare',
      },
    });
    expect(result.status).toBe('blocked');
    expect(result.phase).toBe('rate_limit');
    expect(result.reason_codes).toContain('rpm_exceeded');
  });
});
