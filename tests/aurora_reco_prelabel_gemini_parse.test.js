const { __internal } = require('../src/auroraBff/recoPrelabelGemini');

describe('aurora reco prelabel gemini response extraction', () => {
  test('prefers response.text() function when available', async () => {
    const text = await __internal.extractTextFromGeminiResponse({
      text: async () =>
        JSON.stringify({
          suggested_label: 'relevant',
          wrong_block_target: null,
          confidence: 0.8,
          rationale_user_visible: 'Signals are consistent.',
          flags: [],
        }),
      candidates: [
        {
          content: { parts: [{ text: 'fallback' }] },
        },
      ],
    });
    expect(text).toMatch(/suggested_label/);
    expect(text).not.toBe('fallback');
  });

  test('returns parsed object payload when SDK provides parsed response', async () => {
    const text = await __internal.extractTextFromGeminiResponse({
      parsed: {
        suggested_label: 'not_relevant',
        wrong_block_target: null,
        confidence: 0.2,
        rationale_user_visible: 'Insufficient evidence.',
        flags: ['needs_category_check'],
      },
    });
    expect(text).toMatch(/not_relevant/);
    expect(text).toMatch(/needs_category_check/);
  });
});

