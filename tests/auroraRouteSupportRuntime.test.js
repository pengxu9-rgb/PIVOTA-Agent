const { createAuroraRouteSupportRuntime } = require('../src/auroraBff/routeSupportRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    normalizeProductIntelKbKey: jest.fn((raw) => `kb:${String(raw || '').trim()}`),
    sanitizeSuggestionForPublic: jest.fn((row) => (row && row.id ? { id: String(row.id) } : null)),
    normalizeBlockToken: jest.fn((value) => String(value || '').trim().toLowerCase() || null),
    getAuroraKbFailMode: jest.fn(() => 'open'),
    getAuroraKbV0: jest.fn(() => ({ ok: true })),
    requiredRouteContracts: [{ method: 'GET', path: '/v1/travel/plans' }],
    assertRequiredRouteContracts: jest.fn(() => ({
      ok: true,
      scope: 'travel_plans',
      required_routes: [{ method: 'GET', path: '/v1/travel/plans' }],
      missing_routes: [],
    })),
    requiredRouteScope: 'travel_plans',
    ...overrides,
  };

  return {
    deps,
    runtime: createAuroraRouteSupportRuntime(deps),
  };
}

describe('createAuroraRouteSupportRuntime', () => {
  test('builds prelabel kb read candidates with normalized primary and legacy fallbacks', () => {
    const { runtime } = buildRuntime();

    expect(runtime.buildPrelabelKbReadCandidates('anchor_1', 'CN')).toEqual([
      'kb:product:anchor_1',
      'kb:product:anchor_1|lang:CN',
      'kb:product:anchor_1|lang:EN',
    ]);
  });

  test('maps public suggestion rows with anchor, block, and candidate ids', () => {
    const { runtime, deps } = buildRuntime();

    expect(runtime.mapSuggestionForResponse({
      id: 'sug_1',
      anchor_product_id: 'anchor_1',
      candidate_product_id: 'cand_1',
      block: 'Competitors',
    })).toEqual({
      id: 'sug_1',
      anchor_product_id: 'anchor_1',
      candidate_product_id: 'cand_1',
      block: 'competitors',
    });

    expect(deps.sanitizeSuggestionForPublic).toHaveBeenCalled();
    expect(deps.normalizeBlockToken).toHaveBeenCalledWith('Competitors');
  });

  test('kb preflight warns instead of throwing in open mode', () => {
    const logger = { warn: jest.fn() };
    const { runtime } = buildRuntime({
      getAuroraKbFailMode: jest.fn(() => 'open'),
      getAuroraKbV0: jest.fn(() => ({ ok: false, reason: 'loader_unavailable' })),
    });

    expect(() => runtime.preflightAuroraKbV0ForStartup({ logger })).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('required route contract checks update health on success and failure', () => {
    const logger = { error: jest.fn() };
    const missingRoutes = [{ method: 'GET', path: '/v1/travel/plans' }];
    const { runtime } = buildRuntime({
      assertRequiredRouteContracts: jest
        .fn()
        .mockReturnValueOnce({
          ok: true,
          scope: 'travel_plans',
          required_routes: missingRoutes,
          missing_routes: [],
        })
        .mockImplementationOnce(() => {
          const err = new Error('missing routes');
          err.code = 'REQUIRED_ROUTE_CONTRACTS_MISSING';
          err.missing_routes = missingRoutes;
          throw err;
        }),
    });

    expect(runtime.checkRequiredRouteContracts({}, { logger })).toEqual({
      checked: true,
      ok: true,
      scope: 'travel_plans',
      required_routes: missingRoutes,
      missing_routes: [],
    });
    expect(runtime.getRequiredRouteContractsHealth()).toEqual({
      checked: true,
      ok: true,
      scope: 'travel_plans',
      required_routes: missingRoutes,
      missing_routes: [],
    });

    expect(() => runtime.checkRequiredRouteContracts({}, { logger })).toThrow('missing routes');
    expect(runtime.getRequiredRouteContractsHealth()).toEqual({
      checked: true,
      ok: false,
      scope: 'travel_plans',
      required_routes: missingRoutes,
      missing_routes: missingRoutes,
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
