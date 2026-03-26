const {
  extractCreatorId,
  getDefaultCreatorId,
  normalizeInvokeMetadata,
  initializeInvokeRequestContext,
} = require('../../src/commerce/invokeRequestContext');

describe('invokeRequestContext', () => {
  test('extractCreatorId reads creator id from payload or metadata', () => {
    expect(extractCreatorId({ creator_id: 'creator_1' })).toBe('creator_1');
    expect(extractCreatorId({ metadata: { creator_id: 'creator_2' } })).toBe('creator_2');
    expect(extractCreatorId({ search: { creator_id: 'creator_3' } })).toBe('creator_3');
    expect(extractCreatorId(null)).toBeNull();
  });

  test('normalizeInvokeMetadata defaults creator id for creator ui sources', () => {
    const metadata = normalizeInvokeMetadata(
      { source: 'creator-agent-ui' },
      {},
      {
        creatorConfigs: [{ creatorId: 'creator_default' }],
        isCreatorUiSource: jest.fn(() => true),
      },
    );

    expect(metadata).toEqual({
      source: 'creator-agent-ui',
      creator_id: 'creator_default',
      creatorId: 'creator_default',
    });
  });

  test('getDefaultCreatorId prefers environment before creator configs', () => {
    const original = process.env.DEFAULT_CREATOR_ID;
    process.env.DEFAULT_CREATOR_ID = 'creator_env';
    expect(getDefaultCreatorId([{ creatorId: 'creator_config' }])).toBe('creator_env');
    process.env.DEFAULT_CREATOR_ID = original;
  });

  test('initializeInvokeRequestContext returns invalid request envelope for schema failures', async () => {
    const logger = { warn: jest.fn() };
    const result = await initializeInvokeRequestContext({
      reqBody: {},
      gatewayRequestId: 'req_1',
      invokeStartedAtMs: 100,
      invokeRequestSchema: {
        safeParse: () => ({
          success: false,
          error: { format: () => ({ operation: ['Required'] }) },
        }),
      },
      operationEnum: { options: ['preview_quote'] },
      creatorConfigs: [],
      isCreatorUiSource: jest.fn(() => false),
      buildFindProductsMultiContext: jest.fn(),
      defaultFindProductsMultiExpansionMode: 'conservative',
      searchCacheValidate: true,
      searchForceControlledRecallForScenario: false,
      searchCacheMinAnchor: 2,
      searchCacheMaxDomainEntropy: 0.5,
      searchCacheMinCount: 2,
      searchCacheMaxCrossDomainRatio: 0.5,
      searchUpstreamQuotaClarifyEnabled: true,
      searchUpstreamQuotaClarifyQueryClasses: ['lookup'],
      logger,
    });

    expect(result).toEqual({
      handled: true,
      statusCode: 400,
      body: {
        error: 'INVALID_REQUEST',
        details: { operation: ['Required'] },
      },
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  test('initializeInvokeRequestContext builds effective find_products_multi context and trace state', async () => {
    const buildFindProductsMultiContext = jest.fn(async () => ({
      adjustedPayload: { search: { query: 'ipsa toner expanded' } },
      intent: { query_class: 'lookup' },
      expansion_meta: {
        mode: 'conservative',
        ambiguity_score_pre: 0.2,
        query_class: 'lookup',
        rewrite_gate: { applied: true },
        association_plan: { source: 'catalog' },
        flags_snapshot: { custom: true },
      },
      rawUserQuery: 'ipsa toner',
    }));
    const result = await initializeInvokeRequestContext({
      reqBody: {
        operation: 'find_products_multi',
        payload: {
          search: { query: 'ipsa toner' },
          metadata: { source: 'shopping_agent' },
        },
        metadata: { source: 'shopping_agent' },
      },
      gatewayRequestId: 'req_1',
      invokeStartedAtMs: 100,
      invokeRequestSchema: {
        safeParse: (body) => ({ success: true, data: body }),
      },
      operationEnum: { options: ['find_products_multi'] },
      creatorConfigs: [{ creatorId: 'creator_default' }],
      isCreatorUiSource: jest.fn(() => false),
      buildFindProductsMultiContext,
      defaultFindProductsMultiExpansionMode: 'conservative',
      searchCacheValidate: true,
      searchForceControlledRecallForScenario: false,
      searchCacheMinAnchor: 2,
      searchCacheMaxDomainEntropy: 0.5,
      searchCacheMinCount: 2,
      searchCacheMaxCrossDomainRatio: 0.5,
      searchUpstreamQuotaClarifyEnabled: true,
      searchUpstreamQuotaClarifyQueryClasses: ['lookup'],
      logger: { warn: jest.fn() },
    });

    expect(buildFindProductsMultiContext).toHaveBeenCalled();
    expect(result.handled).toBe(false);
    expect(result.effectivePayload).toEqual({ search: { query: 'ipsa toner expanded' } });
    expect(result.rawUserQuery).toBe('ipsa toner');
    expect(result.traceQueryClass).toBe('lookup');
    expect(result.traceRewriteGate).toEqual({ applied: true });
    expect(result.traceAssociationPlan).toEqual({ source: 'catalog' });
    expect(result.traceFlagsSnapshot).toEqual(
      expect.objectContaining({
        custom: true,
        search_cache_validate: true,
      }),
    );
    result.addFpmGateTrace({ gateId: 'resolver_first', applied: true, costMsEstimate: 25 });
    expect(result.fpmGateTrace).toEqual([
      expect.objectContaining({
        gate_id: 'resolver_first',
        applied: true,
        cost_ms_estimate: 25,
      }),
    ]);
    expect(result.debugRuntimePatch).toEqual(
      expect.objectContaining({
        operation: 'find_products_multi',
        rawUserQuery: 'ipsa toner',
        expansionMode: 'conservative',
      }),
    );
  });
});
