const {
  PRELABEL_PROMPT_VERSION,
  buildPrelabelSystemPrompt,
  buildPrelabelUserPrompt,
} = require('../src/auroraBff/recoPrelabelPrompts');

describe('aurora reco prelabel prompt', () => {
  test('system prompt includes hard rules', () => {
    const prompt = buildPrelabelSystemPrompt();
    expect(PRELABEL_PROMPT_VERSION).toBe('prelabel_v1');
    expect(prompt.toLowerCase()).toMatch(/competitors.*cross-brand/);
    expect(prompt.toLowerCase()).toMatch(/on_page_related.*never competitors or dupes/);
    expect(prompt.toLowerCase()).toMatch(/dupes.*high similarity.*cheaper/);
    expect(prompt.toLowerCase()).toMatch(/if information is missing.*lower confidence.*flags/);
    expect(prompt.toLowerCase()).toMatch(/strict json only/);
  });

  test('user prompt embeds structured input', () => {
    const input = {
      anchor: { brand: 'A', category: 'serum' },
      candidate: { brand: 'B' },
      block_context: { block_type: 'competitors' },
      evidence: { reasons_user_visible: ['x'] },
    };
    const out = buildPrelabelUserPrompt(input);
    expect(typeof out).toBe('string');
    expect(out).toMatch(/prelabel_candidate_for_employee_review/);
    expect(out).toMatch(/output_schema/);
    expect(out).toMatch(/block_context/);
  });
});
