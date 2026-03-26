const {
  createProductIntelUpstreamRuntime,
} = require('../src/auroraBff/productIntelUpstreamRuntime');

describe('createProductIntelUpstreamRuntime', () => {
  test('detects nested commerce-like fields in structured payloads', () => {
    const runtime = createProductIntelUpstreamRuntime();

    expect(
      runtime.structuredContainsCommerceLikeFields({
        analysis: {
          recommendation: {
            purchase_route: 'internal_checkout',
          },
        },
      }),
    ).toBe(true);
    expect(runtime.structuredContainsCommerceLikeFields({ analysis: { verdict: 'good' } })).toBe(false);
  });

  test('prefers structured payload and otherwise falls back to keyed answer json', () => {
    const extractJsonObjectByKeys = jest.fn(() => ({ product: { name: 'Answer Parse' } }));
    const extractJsonObject = jest.fn(() => ({ product: { name: 'Generic Parse' } }));
    const runtime = createProductIntelUpstreamRuntime({
      extractJsonObject,
      extractJsonObjectByKeys,
    });

    expect(
      runtime.getUpstreamStructuredOrJson({
        structured: { product: { name: 'Structured Parse' } },
        answer: '{"product":{"name":"ignored"}}',
      }),
    ).toEqual({ product: { name: 'Structured Parse' } });

    expect(
      runtime.getUpstreamStructuredOrJson(
        { answer: '{"product":{"name":"Answer Parse"}}' },
        { answerRequiredKeys: runtime.PRODUCT_PARSE_ANSWER_JSON_KEYS },
      ),
    ).toEqual({ product: { name: 'Answer Parse' } });
    expect(extractJsonObjectByKeys).toHaveBeenCalled();
    expect(extractJsonObject).not.toHaveBeenCalled();
  });

  test('normalizes direct and mapped product-analysis payloads', () => {
    const mapAuroraProductAnalysis = jest.fn((value) => value.analysis);
    const normalizeProductAnalysis = jest.fn((value) => ({
      payload: value,
      field_missing: [],
    }));
    const runtime = createProductIntelUpstreamRuntime({
      mapAuroraProductAnalysis,
      normalizeProductAnalysis,
      extractJsonObjectByKeys: jest.fn(() => ({
        assessment: { verdict: 'good' },
        evidence: {},
        missing_info: [],
      })),
    });

    const direct = runtime.normalizeProductAnalysisFromUpstream({
      structured: {
        product_analysis: {
          assessment: { verdict: 'good' },
          evidence: {},
          missing_info: [],
        },
      },
    });
    const mapped = runtime.normalizeProductAnalysisFromUpstream({
      structured: {
        analysis: {
          assessment: { verdict: 'mapped' },
          evidence: {},
          missing_info: [],
        },
      },
    });

    expect(direct.payload.assessment.verdict).toBe('good');
    expect(mapped.payload.assessment.verdict).toBe('mapped');
    expect(mapAuroraProductAnalysis).toHaveBeenCalled();
    expect(normalizeProductAnalysis).toHaveBeenCalledTimes(2);
  });
});
