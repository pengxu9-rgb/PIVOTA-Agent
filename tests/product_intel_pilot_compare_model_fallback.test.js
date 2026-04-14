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
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
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
                      '{"product_intel_core":{"what_it_is":{"headline":"Test","body":"Fallback produced"}}}',
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
    expect(result.attempted_models).toEqual(['gemini-1.5-flash', 'gemini-3.1-pro-preview']);
  });
});
