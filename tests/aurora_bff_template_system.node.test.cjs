const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FIELD_MISSING_REASON_ENUM,
  selectTemplate,
  renderAssistantMessage,
  adaptChips,
  validateTemplateOutput,
} = require('../src/auroraBff/templateSystem');

test('templateSystem: selectTemplate chooses recommendations_output.standard in RECO_RESULTS', () => {
  const decision = selectTemplate({
    cards: [{ type: 'recommendations', payload: { recommendations_count: 2 } }],
    session_patch: { next_state: 'RECO_RESULTS' },
  });

  assert.equal(decision.module, 'recommendations_output');
  assert.equal(decision.variant, 'standard');
});

test('templateSystem: selectTemplate chooses diagnosis_clarification when pending_clarification exists', () => {
  const decision = selectTemplate({
    cards: [],
    session_patch: {
      state: {
        pending_clarification: {
          current: { id: 'skinType', norm_id: 'skinType' },
        },
      },
    },
  });

  assert.equal(decision.module, 'diagnosis_clarification');
  assert.equal(decision.current_norm_id, 'skinType');
});

test('templateSystem: renderAssistantMessage replaces generic message with template output', () => {
  const decision = {
    module: 'diagnosis_clarification',
    variant: 'standard',
    message_format: 'text',
    current_norm_id: 'skinType',
  };

  const rendered = renderAssistantMessage(decision, {
    language: 'CN',
    assistant_message: {
      role: 'assistant',
      format: 'text',
      content: '我已经把核心结果整理成结构化卡片（见下方）。',
    },
  });

  assert.equal(rendered.applied, true);
  assert.match(rendered.content, /先确认 1 个问题/);
});

test('templateSystem: renderAssistantMessage keeps specific existing content', () => {
  const decision = {
    module: 'product_evaluation',
    variant: 'standard',
    message_format: 'text',
  };

  const rendered = renderAssistantMessage(decision, {
    language: 'EN',
    assistant_message: {
      role: 'assistant',
      format: 'text',
      content: 'This product looks suitable for your stated goal. Want a conservative intro schedule?',
    },
  });

  assert.equal(rendered.applied, false);
  assert.equal(rendered.reason, 'keep_existing');
  assert.match(rendered.content, /conservative intro schedule/i);
});

test('templateSystem: adaptChips prioritizes current clarification and enforces <=10', () => {
  const existing = [];
  for (let i = 0; i < 14; i += 1) {
    existing.push({
      chip_id: `chip.${i}`,
      label: `Chip ${i}`,
      kind: 'quick_reply',
      data: { norm_id: i % 2 === 0 ? 'skinType' : 'goals', value: `v${i}` },
    });
  }

  const out = adaptChips({ existingChips: existing, currentNormId: 'skinType', maxChips: 10 });
  assert.equal(out.truncated, true);
  assert.equal(out.chips.length, 10);
  assert.equal(out.chips[0].data.norm_id, 'skinType');
});

test('templateSystem: validateTemplateOutput catches state mismatch and unknown field_missing reason', () => {
  const report = validateTemplateOutput({
    assistant_message: { role: 'assistant', format: 'text', content: 'This is a static explanation without directive.' },
    suggested_chips: [],
    cards: [
      {
        card_id: 'reco_1',
        type: 'recommendations',
        payload: { recommendations_count: 1, recommendations: [{}] },
        field_missing: [{ field: 'payload.foo', reason: 'unknown_reason' }],
      },
    ],
    session_patch: { next_state: 'IDLE_CHAT' },
  });

  assert.equal(report.ok, false);
  assert.equal(report.violations.some((v) => v.rule === 'recommendations_state_mismatch'), true);
  assert.equal(report.violations.some((v) => v.rule === 'field_missing_reason_unknown'), true);
  assert.equal(report.violations.some((v) => v.rule === 'missing_action'), true);
});

test('templateSystem: reason enum contains required reasons', () => {
  assert.equal(FIELD_MISSING_REASON_ENUM.includes('catalog_not_available'), true);
  assert.equal(FIELD_MISSING_REASON_ENUM.includes('feature_flag_disabled'), true);
  assert.equal(FIELD_MISSING_REASON_ENUM.includes('upstream_timeout'), true);
});
