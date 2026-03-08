const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

const {
  buildDiagnosisPrompt,
  DIAGNOSIS_GATE_PROMPT_VERSION,
} = require('../src/auroraBff/gating');

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('legacy diagnosis gate prompt uses explicit deterministic version and asks only the current missing field', () => {
  const text = buildDiagnosisPrompt('EN', ['skinType', 'goals']);

  assert.equal(DIAGNOSIS_GATE_PROMPT_VERSION, 'diagnosis_gate_prompt_v2');
  assert.match(text, /Before I continue, I need one quick skin-profile detail so I don't guess\./i);
  assert.match(text, /which skin type fits you best\?/i);
  assert.doesNotMatch(text, /top skin goal right now/i);
});

test('legacy diagnosis gate prompt falls back to the generic localized prefix when field metadata is missing', () => {
  const text = buildDiagnosisPrompt('CN', ['unknown_field']);

  assert.equal(text.trim(), '在我继续之前，我先确认一个肤况信息，避免瞎猜。');
});

test('legacy fit-check anchor gate prompt uses explicit deterministic version and concrete anchor requirements', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const prompt = __internal.buildFitCheckAnchorPrompt('EN');

    assert.equal(__internal.FIT_CHECK_ANCHOR_PROMPT_VERSION, 'fit_check_anchor_gate_v2');
    assert.equal(prompt.promptVersion, __internal.FIT_CHECK_ANCHOR_PROMPT_VERSION);
    assert.match(prompt.prompt, /I can evaluate it, but I need one clear anchor first/i);
    assert.match(prompt.prompt, /product link, full product name, or ingredient list \(INCI\)/i);
    assert.deepEqual(
      prompt.chips.map((chip) => chip.chip_id),
      [
        'chip.fitcheck.send_product_name',
        'chip.fitcheck.send_link',
        'chip.fitcheck.send_ingredients',
      ],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('legacy fit-check anchor gate keeps localized chips and does not drift into pseudo-analysis copy', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const prompt = __internal.buildFitCheckAnchorPrompt('CN');

    assert.equal(prompt.promptVersion, 'fit_check_anchor_gate_v2');
    assert.match(prompt.prompt, /明确锚点/);
    assert.match(prompt.prompt, /产品链接、完整产品名，或成分表（INCI）/);
    assert.equal(prompt.chips[0].label, '发送产品名');
    assert.equal(prompt.chips[1].data.reply_text, '发送链接');
    assert.doesNotMatch(prompt.prompt, /适合|结论|推荐/);
  } finally {
    delete require.cache[moduleId];
  }
});
