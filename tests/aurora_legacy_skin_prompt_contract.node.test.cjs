const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSkinVisionPromptBundle,
  buildSkinReportPromptBundle,
  buildSkinDeepeningPromptBundle,
  SKIN_VISION_MAINLINE_PROMPT_VERSION,
  SKIN_REPORT_MAINLINE_PROMPT_VERSION,
  SKIN_DEEPENING_MAINLINE_PROMPT_VERSION,
} = require('../src/auroraBff/skinLlmPrompts');

test('legacy skin vision mainline prompt uses explicit hardened version and grounded extraction contract', () => {
  const bundle = buildSkinVisionPromptBundle({
    language: 'en-US',
    dto: {
      quality: { grade: 'pass', issues: [] },
      profile: { skinType: 'combination' },
    },
  });

  assert.equal(bundle.promptVersion, SKIN_VISION_MAINLINE_PROMPT_VERSION);
  assert.equal(bundle.promptVersion, 'skin_vision_v2_hardened');
  assert.match(bundle.systemInstruction, /Prompt version: skin_vision_v2_hardened/i);
  assert.match(bundle.systemInstruction, /single strict JSON object/i);
  assert.match(bundle.userPrompt, /\[SYSTEM_CONTRACT\]\[version=skin_vision_v2_hardened\]/i);
  assert.match(bundle.userPrompt, /output_contract: Return ONLY JSON/i);
  assert.match(bundle.userPrompt, /grounding_rule:/i);
  assert.match(bundle.userPrompt, /missing_data_policy:/i);
  assert.match(bundle.userPrompt, /skin_type_rule:/i);
});

test('legacy skin report mainline prompt uses explicit hardened version and structured contract', () => {
  const bundle = buildSkinReportPromptBundle({
    language: 'en-US',
    dto: {
      quality: { grade: 'pass', issues: [] },
      profile: { skinType: 'oily', sensitivity: 'high', barrierStatus: 'impaired', goals: ['redness'] },
    },
  });

  assert.equal(bundle.promptVersion, SKIN_REPORT_MAINLINE_PROMPT_VERSION);
  assert.equal(bundle.promptVersion, 'skin_report_v3_hardened');
  assert.match(bundle.systemInstruction, /Prompt version: skin_report_v3_hardened/i);
  assert.match(bundle.systemInstruction, /\[ROLE\]/);
  assert.match(bundle.systemInstruction, /single valid JSON object only/i);
  assert.match(bundle.userPrompt, /\[TASK\]/);
  assert.match(bundle.userPrompt, /\[OUTPUT_CONTRACT\]/);
  assert.match(bundle.userPrompt, /\[HARD_RULES\]/);
  assert.match(bundle.userPrompt, /Separation rule/i);
  assert.match(bundle.userPrompt, /Cue-linking rule/i);
  assert.match(bundle.userPrompt, /Safety rule/i);
  assert.match(bundle.userPrompt, /\[MISSING_DATA_POLICY\]/);
  assert.match(bundle.userPrompt, /\[FORBIDDEN_BEHAVIOR\]/);
  assert.match(bundle.userPrompt, /two_week_focus/i);
  assert.match(bundle.userPrompt, /next_step_options/i);
});

test('legacy skin report canonical v3 path remains unchanged when explicitly requested', () => {
  const bundle = buildSkinReportPromptBundle({
    language: 'zh-CN',
    promptVersion: 'skin_v3',
    dto: { quality: { grade: 'pass' } },
  });

  assert.equal(bundle.promptVersion, 'skin_report_v3_canonical');
  assert.match(bundle.systemInstruction, /Reason in English only/i);
});

test('legacy skin vision canonical v3 path remains unchanged when explicitly requested', () => {
  const bundle = buildSkinVisionPromptBundle({
    language: 'zh-CN',
    promptVersion: 'skin_v3',
    dto: { quality: { grade: 'pass' } },
  });

  assert.equal(bundle.promptVersion, 'skin_vision_v3_canonical');
  assert.match(bundle.systemInstruction, /Reason in English only/i);
});

test('legacy skin deepening mainline prompt uses explicit hardened version and phase-safe contract', () => {
  const bundle = buildSkinDeepeningPromptBundle({
    language: 'en-US',
    dto: {
      phase: 'reactions',
      profile: { skinType: 'combination', goals: ['texture'] },
      photo_choice: 'uploaded',
      products_submitted: true,
      routine_actives: ['retinoid', 'acids'],
      reactions: ['stinging', 'redness'],
    },
  });

  assert.equal(bundle.promptVersion, SKIN_DEEPENING_MAINLINE_PROMPT_VERSION);
  assert.equal(bundle.promptVersion, 'skin_deepening_v2_hardened');
  assert.match(bundle.systemInstruction, /Prompt version: skin_deepening_v2_hardened/i);
  assert.match(bundle.systemInstruction, /\[ROLE\]/);
  assert.match(bundle.systemInstruction, /single valid JSON object only/i);
  assert.match(bundle.userPrompt, /\[TASK\]/);
  assert.match(bundle.userPrompt, /\[OUTPUT_CONTRACT\]/);
  assert.match(bundle.userPrompt, /\[HARD_RULES\]/);
  assert.match(bundle.userPrompt, /Phase-fidelity rule/i);
  assert.match(bundle.userPrompt, /Safety rule/i);
  assert.match(bundle.userPrompt, /Current phase = reactions/i);
  assert.match(bundle.userPrompt, /\[MISSING_DATA_POLICY\]/);
  assert.match(bundle.userPrompt, /\[FORBIDDEN_BEHAVIOR\]/);
});

test('legacy skin deepening canonical v2 path remains unchanged when explicitly requested', () => {
  const bundle = buildSkinDeepeningPromptBundle({
    language: 'en-US',
    promptVersion: 'skin_deepening_v2_canonical',
    dto: { phase: 'photo_optin' },
  });

  assert.equal(bundle.promptVersion, 'skin_deepening_v2_canonical');
  assert.match(bundle.systemInstruction, /Reason in English only/i);
});
