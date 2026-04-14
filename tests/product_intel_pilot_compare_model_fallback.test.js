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
      'gemini-3-flash-preview',
      'gemini-3.1-pro-preview',
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
              groundingMetadata: {
                webSearchQueries: ['Demo serum reviews'],
                groundingChunks: [{ web: { uri: 'https://example.com/demo-serum', title: 'Demo serum review' } }],
                groundingSupports: [{ groundingChunkIndices: [0] }],
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
    expect(postMock.mock.calls[1][1].tools).toEqual([{ google_search: {} }]);
    expect(result.output.gemini_grounding).toEqual(
      expect.objectContaining({
        has_grounding: true,
        web_search_queries: ['Demo serum reviews'],
      }),
    );
  });

  test('uses GPT-5.4 human-standard rewrite when flash and pro both fail quality gate', async () => {
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
        case_id: 'human-standard-rewrite-case',
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
    expect(result.model_used).toBe('gpt-5.4-human-standard-rewrite');
    expect(result.selection_strategy).toBe('gpt54_human_standard_rewrite');
    expect(result.attempted_models).toEqual(['gemini-3-flash-preview', 'gemini-3.1-pro-preview']);
    expect(result.quality_gate.overall_pass).toBe(true);
    expect(result.quality_gate.human_standard_rewrite).toBe(true);
  });

  test('human-standard rewrite fixes lip-product best_for category mismatch after Gemini fails quality', async () => {
    process.env.GEMINI_API_KEY = 'fake-key';
    const weakLipResponse = {
      data: {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"product_intel_core":{"what_it_is":{"headline":"Glossy lip oil","body":"A glossy lip oil positioned for softness, shine, and fuller-looking lips without a sticky finish."},"best_for":[{"tag":"oil_control","label":"Oily or combination skin"}],"why_it_stands_out":[{"headline":"Lip oil","body":"For all people."}],"watchouts":[],"routine_fit":{"step":"lip treatment","pairing_notes":["Use on lips."],"am_pm":["am","pm"]}}}',
                },
              ],
            },
          },
        ],
      },
    };

    jest.spyOn(axios, 'post').mockResolvedValue(weakLipResponse);

    const result = await runGeminiDraft(
      {
        case_id: 'lip-oil-human-rewrite',
        product: {
          title: 'Glaze Lip Oil',
          brand: 'INNBEAUTY PROJECT',
          category: 'Lip Oil',
          description: 'A glossy lip oil for shine, softness, and a plumper-looking lip finish.',
        },
      },
      {
        evidence_profile: 'seller_only',
        product_intel_core: {
          what_it_is: {
            headline: 'Glossy lip oil',
            body: 'A glossy lip oil for shine and soft-feeling lips.',
          },
          best_for: [{ tag: 'lip_shine', label: 'Lip shine' }],
          why_it_stands_out: [
            {
              headline: 'Lip shine',
              body: 'Targets shine and lip comfort.',
              evidence_strength: 'limited',
            },
          ],
          routine_fit: {
            step: 'lip treatment',
            am_pm: ['am', 'pm'],
            pairing_notes: ['Use on lips.'],
          },
          watchouts: [],
        },
        community_signals: { status: 'unavailable' },
      },
      'gemini-3-flash-preview',
    );

    expect(result.model_used).toBe('gpt-5.4-human-standard-rewrite');
    expect(result.output.product_intel_core.best_for.map((item) => item.label)).toEqual([
      'Glossy lip shine',
      'Soft-feeling lip comfort',
    ]);
    expect(result.quality_gate.fail_reasons).not.toContain('incompatible_best_for');
  });

  test('human-standard rewrite does not reuse awkward first-person cleanser seller copy', async () => {
    process.env.GEMINI_API_KEY = 'fake-key';
    const weakCleanserResponse = {
      data: {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"product_intel_core":{"what_it_is":{"headline":"Cleanser","body":"This cleanser has a dense foam bubble texture help to cleanse the skin refreshingly and cleanly by smoothly filling the skin."},"best_for":[{"tag":"daily","label":"Daily cleansing"}],"why_it_stands_out":[{"headline":"Gentle","body":"For all people."}],"watchouts":[],"routine_fit":{"step":"cleanser","pairing_notes":["Use before moisturizer."],"am_pm":["am","pm"]}}}',
                },
              ],
            },
          },
        ],
      },
    };

    jest.spyOn(axios, 'post').mockResolvedValue(weakCleanserResponse);

    const result = await runGeminiDraft(
      {
        case_id: 'cleanser-human-rewrite',
        product: {
          title: 'Pine Calming Cica Cleanser',
          brand: 'Round Lab',
          category: 'Cleanser',
          description:
            'This cleanser has a dense foam bubble texture help to cleanse the skin refreshingly and cleanly by smoothly filling the skin.',
        },
      },
      {
        evidence_profile: 'seller_only',
        product_intel_core: {
          what_it_is: {
            headline: 'Daily cleanser',
            body: 'A cleanser focused on removing daily buildup while keeping the routine gentle and practical.',
          },
          best_for: [{ tag: 'daily_cleansing', label: 'Daily cleansing' }],
          why_it_stands_out: [
            {
              headline: 'Cleansing comfort',
              body: 'Supports daily cleansing with a comfort-first profile.',
              evidence_strength: 'limited',
            },
          ],
          routine_fit: {
            step: 'cleanser',
            am_pm: ['am', 'pm'],
            pairing_notes: ['Use before treatment and moisturizer steps.'],
          },
          watchouts: [],
        },
        community_signals: {
          status: 'unavailable',
        },
      },
      'gemini-3-flash-preview',
    );

    expect(result.model_used).toBe('gpt-5.4-human-standard-rewrite');
    expect(result.output.product_intel_core.what_it_is.body).toBe(
      'A cleanser focused on removing daily buildup while keeping the routine gentle and practical.',
    );
    expect(result.output.product_intel_core.what_it_is.body).not.toMatch(/texture help|s lightly|\\bour\\b/i);
  });
});
