const { createRecoPrelabelSupportRuntime } = require('../src/auroraBff/recoPrelabelSupportRuntime');

describe('createRecoPrelabelSupportRuntime', () => {
  function buildRuntime(overrides = {}) {
    return createRecoPrelabelSupportRuntime({
      applyProductAnalysisGapContract: jest.fn((payload) => ({
        ...payload,
        gap_contracted: true,
      })),
      isPlainObject: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
      ...overrides,
    });
  }

  test('sanitizes public suggestion rows and clamps confidence', () => {
    const runtime = buildRuntime();

    expect(
      runtime.sanitizeSuggestionForPublic({
        id: ' sug_1 ',
        suggested_label: ' relevant ',
        wrong_block_target: ' dupes ',
        confidence: 1.7,
        rationale_user_visible: ' good match ',
        flags: [' keep ', '', null, ' second '],
        model_name: ' gemini ',
        prompt_version: ' prelabel_v1 ',
        updated_at: '2026-03-25T00:00:00.000Z',
        input_hash: 'should_not_leak',
      }),
    ).toEqual({
      id: 'sug_1',
      suggested_label: 'relevant',
      wrong_block_target: 'dupes',
      confidence: 1,
      rationale_user_visible: 'good match',
      flags: ['keep', 'second'],
      model_name: 'gemini',
      prompt_version: 'prelabel_v1',
      updated_at: '2026-03-25T00:00:00.000Z',
    });
  });

  test('attaches sanitized suggestions by block and candidate id', () => {
    const runtime = buildRuntime();

    const out = runtime.attachPrelabelSuggestionsToPayload(
      {
        competitors: {
          candidates: [{ product_id: 'comp_1', name: 'Competitor 1' }],
        },
        dupes: { candidates: [] },
        related_products: { candidates: [] },
      },
      [
        {
          id: 'sug_1',
          block: 'Competitors',
          candidate_product_id: 'COMP_1',
          suggested_label: 'relevant',
          confidence: 0.74,
          rationale_user_visible: 'Matches category and ingredient profile.',
          flags: ['needs_price_check'],
          model_name: 'gemini-2.0-flash',
          prompt_version: 'prelabel_v1',
          input_hash: 'should_not_leak',
        },
      ],
    );

    expect(out.competitors.candidates[0].llm_suggestion).toEqual(
      expect.objectContaining({
        id: 'sug_1',
        suggested_label: 'relevant',
        confidence: 0.74,
        rationale_user_visible: 'Matches category and ingredient profile.',
      }),
    );
    expect(out.competitors.candidates[0].llm_suggestion.input_hash).toBeUndefined();
  });

  test('sanitizes product analysis payload for prelabel consumers', () => {
    const applyProductAnalysisGapContract = jest.fn((payload) => ({
      ...payload,
      gap_contracted: true,
    }));
    const runtime = buildRuntime({ applyProductAnalysisGapContract });

    const out = runtime.sanitizeProductAnalysisPayloadForPrelabel({
      input_hash: 'remove_me',
      internal_debug_codes: ['dbg'],
      suggestion_debug: { internal: true },
      competitors: {
        candidates: [
          {
            product_id: 'comp_1',
            ref_id: 'internal_ref',
            internal_reason_codes: ['why'],
            llm_raw_response: 'internal',
            suggestion_debug: { internal: true },
          },
        ],
      },
    });

    expect(applyProductAnalysisGapContract).toHaveBeenCalled();
    expect(out.gap_contracted).toBe(true);
    expect(out.input_hash).toBeUndefined();
    expect(out.internal_debug_codes).toBeUndefined();
    expect(out.suggestion_debug).toBeUndefined();
    expect(out.competitors.candidates[0]).toEqual({
      product_id: 'comp_1',
    });
  });

  test('parses bool/int query values and normalizes block token', () => {
    const runtime = buildRuntime();

    expect(runtime.parseBoolQueryValue('YES', false)).toBe(true);
    expect(runtime.parseBoolQueryValue('off', true)).toBe(false);
    expect(runtime.parseIntQueryValue('42.8', 10, 1, 40)).toBe(40);
    expect(runtime.parseIntQueryValue('bad', 10, 1, 40)).toBe(10);
    expect(runtime.normalizeBlockToken(' Related_Products ')).toBe('related_products');
    expect(runtime.normalizeBlockToken('unknown')).toBe('');
  });
});
