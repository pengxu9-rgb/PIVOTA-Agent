const {
  evaluateCase,
  isPdpNotServableResult,
  normalizeCase,
} = require('../../scripts/run_relationship_graph_launch_canary.cjs');

function passingResult(overrides = {}) {
  const base = {
    pdp: {
      ok: true,
      http_status: 200,
      relationship_graph: {
        edge_count: 3,
        served_count: 1,
      },
    },
    discovery: {
      ok: true,
      relationship_graph: {
        selected_count: 1,
      },
    },
    direct: {
      ok: true,
      product_count: 2,
      graph_product_count: 2,
      relationship_graph: {
        served_count: 2,
      },
    },
  };
  return {
    ...base,
    ...overrides,
  };
}

describe('relationship graph launch canary', () => {
  test('requires PDP by default', () => {
    const testCase = normalizeCase(
      {
        product: { product_id: 'ext_1' },
        expect: {
          graph_edges_min: 1,
          pdp_served_min: 1,
          discovery_selected_min: 1,
        },
      },
      0,
    );

    expect(testCase.expect.pdp_required).toBe(true);
    expect(evaluateCase(testCase, passingResult({
      pdp: {
        ok: false,
        http_status: 404,
        error: 'PRODUCT_NOT_SERVABLE',
        reason_code: 'PRODUCT_NOT_SERVABLE',
        relationship_graph: { edge_count: 0, served_count: 0 },
      },
    }))).toEqual(expect.arrayContaining(['pdp_http_failed']));
  });

  test('allows a declared PDP-ineligible anchor without weakening graph surfaces', () => {
    const testCase = normalizeCase(
      {
        product: { product_id: 'ext_2' },
        expect: {
          graph_edges_min: 3,
          pdp_served_min: 1,
          pdp_required: false,
          discovery_selected_min: 1,
        },
      },
      0,
    );

    const result = passingResult({
      pdp: {
        ok: false,
        http_status: 404,
        error: 'PRODUCT_NOT_SERVABLE',
        reason_code: 'PRODUCT_NOT_SERVABLE',
        relationship_graph: { edge_count: 0, served_count: 0 },
      },
    });

    expect(isPdpNotServableResult(result.pdp)).toBe(true);
    expect(evaluateCase(testCase, result)).toEqual([]);
    expect(evaluateCase(testCase, passingResult({
      ...result,
      discovery: {
        ok: true,
        relationship_graph: { selected_count: 0 },
      },
    }))).toEqual(['discovery_graph_selected_below_min']);
  });

  test('does not allow non-PDP_NOT_SERVABLE PDP failures for optional anchors', () => {
    const testCase = normalizeCase(
      {
        product: { product_id: 'ext_3' },
        expect: {
          pdp_required: false,
          discovery_selected_min: 1,
        },
      },
      0,
    );

    expect(evaluateCase(testCase, passingResult({
      pdp: {
        ok: false,
        http_status: 500,
        error: 'INTERNAL_SERVER_ERROR',
        relationship_graph: { edge_count: 0, served_count: 0 },
      },
    }))).toEqual(['pdp_http_failed']);
  });
});
