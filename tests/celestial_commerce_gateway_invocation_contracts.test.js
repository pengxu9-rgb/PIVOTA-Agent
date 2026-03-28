const acpAdapter = require('../src/api/gateway/adapters/acpAdapter');
const ucpAdapter = require('../src/api/gateway/adapters/ucpAdapter');
const ap2Adapter = require('../src/api/gateway/adapters/ap2Adapter');
const directApiAdapter = require('../src/api/gateway/adapters/directApiAdapter');
const mcpAdapter = require('../src/api/gateway/adapters/mcpAdapter');
const { resolveInvocationSurface } = require('../src/api/gateway/invocation/resolveInvocationSurface');
const { buildGatewayInvocationProfile } = require('../src/api/gateway/invocation/buildInvocationProfile');
const { buildGatewayInvocationContext } = require('../src/api/gateway/invocation/buildInvocationContext');
const { normalizeInvocationRequest } = require('../src/api/gateway/invocation/normalizeInvocationRequest');
const { buildCommerceLayerDispatchPlan } = require('../src/api/gateway/layerDispatcher');

describe('Celestial gateway invocation contracts', () => {
  test('resolves invocation surfaces from explicit values and headers', () => {
    expect(resolveInvocationSurface({ invocation_surface: 'mcp' })).toBe('mcp');
    expect(resolveInvocationSurface({ invocationSurface: 'direct-api' })).toBe('direct_api');
    expect(resolveInvocationSurface({ headers: { 'x-pivota-invocation-surface': 'ACP' } })).toBe('acp');
  });

  test('builds invocation profiles and contexts without polluting business handoff', () => {
    const profile = buildGatewayInvocationProfile({
      invocation_surface: 'ucp',
      declared_capabilities: ['streaming', 'callbacks'],
    });
    expect(profile.surface).toBe('ucp');
    expect(profile.protocol_family).toBe('UCP');
    expect(profile.declared_capabilities).toEqual(['streaming', 'callbacks']);

    const context = buildGatewayInvocationContext({
      invocation_surface: 'ap2',
      operation: 'find_products_multi',
      callback: { url: 'https://callback.example.com' },
    });
    expect(context.invocation_profile.surface).toBe('ap2');
    expect(context.normalized_operation).toBe('find_products_multi');
    expect(context.callback.url).toBe('https://callback.example.com');
  });

  test('normalizes invocation request but keeps layer resolution source-driven', () => {
    const normalized = normalizeInvocationRequest({
      invocation_surface: 'mcp',
      source: 'search',
      task_type: 'exact_product',
      query: 'The Ordinary Niacinamide',
    });
    expect(normalized.invocation_surface).toBe('mcp');
    expect(normalized.source_profile.source).toBe('search');

    const plan = buildCommerceLayerDispatchPlan({
      invocation_surface: 'mcp',
      source: 'search',
      task_type: 'exact_product',
    });
    expect(plan.entry_layer).toBe('execution_facing');
  });

  test.each([
    ['acp', acpAdapter],
    ['ucp', ucpAdapter],
    ['ap2', ap2Adapter],
    ['direct_api', directApiAdapter],
    ['mcp', mcpAdapter],
  ])('%s adapter normalizes envelope at gateway layer', (surface, adapter) => {
    const normalized = adapter.normalizeEnvelope({
      source: 'search',
      task_type: 'exact_product',
      query: 'Vitamin C serum',
    });
    expect(normalized.invocation_surface).toBe(surface);
    expect(normalized.source).toBe('search');
    expect(normalized.task_type).toBe('exact_product');
  });
});
