const axios = require('axios');

const { parseArgs, parseGeminiModelList, runGeminiDraft } = require('../scripts/product_intel_pilot_compare');

describe('product_intel_pilot_compare gemini fallback', () => {
  const originalGeminiApiKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (axios.post.mockRestore) {
      axios.post.mockRestore();
    }
    if (originalGeminiApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalGeminiApiKey;
    }
  });

  test('parses requested model list before fallback defaults', () => {
    expect(parseGeminiModelList('models/gemini-3-pro-preview,gemini-2.5-flash')).toEqual([
      'gemini-3-pro-preview',
      'gemini-2.5-flash',
      'gemini-3-flash-preview',
      'gemini-3.1-pro-preview',
      'gemini-2.0-flash',
    ]);
  });

  test('defaults compare model to flash when env not set', () => {
    const previousEnv = process.env.PRODUCT_INTEL_PILOT_GEMINI_MODEL;
    try {
      delete process.env.PRODUCT_INTEL_PILOT_GEMINI_MODEL;
      const args = parseArgs(['node', 'script']);

      if (previousEnv === undefined) {
        expect(args.model).toBe('gemini-3-flash-preview');
      } else {
        expect(args.model).toBe(previousEnv);
      }
    } finally {
      if (previousEnv === undefined) {
        delete process.env.PRODUCT_INTEL_PILOT_GEMINI_MODEL;
      } else {
        process.env.PRODUCT_INTEL_PILOT_GEMINI_MODEL = previousEnv;
      }
    }
  });

  test('falls back to defaults when primary model is unavailable', async () => {
    process.env.GEMINI_API_KEY = 'fake-key';
    const postMock = jest
      .spyOn(axios, 'post')
      .mockRejectedValueOnce({
        response: {
          status: 404,
          data: {
            error: {
              message: 'models/gemini-1.5-flash is not found',
            },
          },
        },
      })
      .mockResolvedValue({
        data: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text:
                      '{"product_intel_core":{"what_it_is":{"headline":"Cleanser for Sensitive Skin","body":"This lightweight cleanser deeply removes makeup, balances oil, and keeps the skin feeling comfortable for all-day wear with a soft finish."},"best_for":[{"tag":"daily","label":"Daily Use"}],"why_it_stands_out":[{"headline":"Gentle Formula","body":"Cleanses gently while helping maintain skin comfort and hydration."}],"routine_fit":{"step":"cleanser","am_pm":["am","pm"]},"watchouts":[{"type":"irritation","label":"Use gently and avoid over-rubbing.","severity":"low"}],"texture_finish":{"texture":"gel","finish":"light","sensory_notes":["smooth"]}}}',
                  },
                ],
              },
            },
          ],
        },
      });

    const result = await runGeminiDraft(
      {
        product: {
          title: 'Demo serum',
          brand: 'Demo',
        },
      },
      {
        product_intel_core: {
          what_it_is: {
            headline: 'Baseline headline',
            body: 'Baseline body',
          },
          routine_fit: {},
        },
      },
      'gemini-1.5-flash',
    );

    expect(postMock).toHaveBeenCalledTimes(2);
    expect(result.skipped).toBe(false);
    expect(result.model_used).toBe('gemini-3.1-pro-preview');
    expect(result.model_candidates).toContain('gemini-3.1-pro-preview');
    expect(result.attempted_models).toEqual(['gemini-3-flash-preview', 'gemini-3.1-pro-preview']);
  });

  test('uses simulated human rewrite when flash and pro both fail quality gate', async () => {
    process.env.GEMINI_API_KEY = 'fake-key';
    const strongBaseline = {
      evidence_profile: 'seller_only',
      product_intel_core: {
        what_it_is: {
          headline: 'Hydrating Cleanser',
          body: 'A gentle daily cleanser designed to remove excess sebum while keeping skin calm and comfortable.',
        },
        best_for: [
          { tag: 'daily', label: 'Daily Use' },
          { tag: 'combo', label: 'Combination Skin' },
        ],
        why_it_stands_out: [
          {
            headline: 'Hydration',
            body: 'It balances oil control with moisture and helps support skin barrier health over time.',
            evidence_strength: 'moderate',
          },
        ],
        routine_fit: {
          step: 'cleanser',
          am_pm: ['am', 'pm'],
          pairing_notes: ['clean and tone'],
        },
        watchouts: [
          { type: 'irritation', label: 'If irritation appears, stop using and rotate products.', severity: 'low' },
        ],
      },
      texture_finish: {
        texture: 'gel-cream',
        finish: 'light matte',
        sensory_notes: ['light', 'non-sticky'],
      },
      community_signals: {
        status: 'unavailable',
      },
    };
    const weakGeminiResponse = {
      data: {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"product_intel_core":{"what_it_is":{"headline":"bad","body":"too short"},"best_for":[{"tag":"daily","label":"Daily Use"}],"why_it_stands_out":[{"headline":"People","body":"for all people"}],"watchouts":[{"type":"watchout","label":"Use with care"}],"routine_fit":{"step":"cleanser","pairing_notes":["gentle"],"am_pm":["pm"]}}}',
                },
              ],
            },
          },
        ],
      },
    };

    const postMock = jest
      .spyOn(axios, 'post')
      .mockResolvedValue(weakGeminiResponse)
      .mockResolvedValue(weakGeminiResponse);

    const result = await runGeminiDraft(
      {
        case_id: 'simulated-rewrite-case',
        product: {
          title: 'Demo serum',
          brand: 'Demo',
        },
      },
      strongBaseline,
      'gemini-3-flash-preview',
    );

    expect(postMock).toHaveBeenCalledTimes(2);
    expect(result.skipped).toBe(false);
    expect(result.model_used).toBe('simulated_human_rewrite');
    expect(result.selection_strategy).toBe('gemini_simulated_rewrite');
    expect(result.attempted_models).toEqual(['gemini-3-flash-preview', 'gemini-3.1-pro-preview']);
    expect(result.quality_gate.overall_pass).toBe(true);
  });
});
