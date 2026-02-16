const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REPLY_QUALITY_RUBRIC,
  scoreReplyQuality,
} = require('../src/auroraBff/replyQualityScorer');

function makeEnvelope(overrides = {}) {
  return {
    assistant_message: { role: 'assistant', format: 'text', content: '先稳住屏障，再决定下一步。' },
    suggested_chips: [],
    cards: [],
    session_patch: {},
    ...overrides,
  };
}

function getCheck(result, id) {
  return (Array.isArray(result.breakdown) ? result.breakdown : []).find((item) => item && item.id === id);
}

test('reply quality scorer: rubric has expected hard-fail and threshold shape', () => {
  assert.equal(REPLY_QUALITY_RUBRIC.rubric_version, 'aurora.reply_quality.v1');
  assert.equal(Array.isArray(REPLY_QUALITY_RUBRIC.hard_fail.forbidden_medical_diagnosis_regex), true);
  assert.equal(Array.isArray(REPLY_QUALITY_RUBRIC.checks), true);
});

test('reply quality scorer: hard-fails medical diagnosis terms to zero', () => {
  const result = scoreReplyQuality(makeEnvelope({
    assistant_message: { role: 'assistant', format: 'text', content: '你有湿疹，我已经给你临床诊断。' },
  }));

  assert.equal(result.total_score, 0);
  assert.equal(result.hard_fail_reasons.includes('forbidden_medical_diagnosis_term'), true);
});

test('reply quality scorer: hard-fails absolute cure claims to zero', () => {
  const result = scoreReplyQuality(makeEnvelope({
    assistant_message: { role: 'assistant', format: 'text', content: 'This will definitely cure your skin in 3 days.' },
  }));

  assert.equal(result.total_score, 0);
  assert.equal(result.hard_fail_reasons.includes('forbidden_absolute_cure_claim'), true);
});

test('reply quality scorer: recommendations card requires RECO_* next_state', () => {
  const bad = scoreReplyQuality(makeEnvelope({
    assistant_message: { role: 'assistant', format: 'markdown', content: '- A\n- B\n- Next: continue' },
    cards: [{ card_id: 'reco1', type: 'recommendations', payload: { recommendations_count: 2 } }],
    session_patch: { next_state: 'IDLE_CHAT' },
  }));
  const badGate = getCheck(bad, 'recommendations_state_gate');
  assert.equal(Boolean(badGate && badGate.passed), false);

  const good = scoreReplyQuality(makeEnvelope({
    assistant_message: { role: 'assistant', format: 'markdown', content: '- A\n- B\n- Next: continue' },
    cards: [{ card_id: 'reco1', type: 'recommendations', payload: { recommendations_count: 2 } }],
    session_patch: { next_state: 'RECO_RESULTS' },
  }));
  const goodGate = getCheck(good, 'recommendations_state_gate');
  assert.equal(Boolean(goodGate && goodGate.passed), true);
});

test('reply quality scorer: pending clarification enforces chips budget and <=1 question', () => {
  const result = scoreReplyQuality(makeEnvelope({
    assistant_message: { role: 'assistant', format: 'text', content: '你是偏油还是偏干？还有你目标是啥？' },
    suggested_chips: [
      { chip_id: 'c1', label: '偏油', kind: 'quick_reply', data: { norm_id: 'skinType', value: 'oily' } },
      { chip_id: 'c2', label: '偏干', kind: 'quick_reply', data: { norm_id: 'skinType', value: 'dry' } },
      { chip_id: 'c3', label: '混合', kind: 'quick_reply', data: { norm_id: 'skinType', value: 'combination' } },
    ],
    session_patch: {
      state: {
        pending_clarification: {
          current: { id: 'skin_type', norm_id: 'skinType' },
        },
      },
    },
  }));

  const chipsCheck = getCheck(result, 'pending_clarification_chips_budget');
  const questionCheck = getCheck(result, 'pending_clarification_single_question');
  assert.equal(Boolean(chipsCheck && chipsCheck.passed), false);
  assert.equal(Boolean(questionCheck && questionCheck.passed), false);
});

test('reply quality scorer: markdown length and bullet caps are enforced', () => {
  const tooLongMarkdown = [
    '- one',
    '- two',
    '- three',
    '- four',
    '- five',
    '- six',
    '- seven',
  ].join('\n');
  const result = scoreReplyQuality(makeEnvelope({
    assistant_message: { role: 'assistant', format: 'markdown', content: tooLongMarkdown },
  }));
  const check = getCheck(result, 'message_length_budget');
  assert.equal(Boolean(check && check.passed), false);
});

test('reply quality scorer: offer=null forbids in-stock/buy-now assertions', () => {
  const bad = scoreReplyQuality(makeEnvelope({
    assistant_message: { role: 'assistant', format: 'text', content: '这款现在有货，可以立即购买。' },
    cards: [
      {
        card_id: 'offers1',
        type: 'offers_resolved',
        payload: {
          items: [{ offer: null }],
        },
      },
    ],
  }));
  const badCheck = getCheck(bad, 'offers_null_no_stock_assertion');
  assert.equal(Boolean(badCheck && badCheck.passed), false);

  const good = scoreReplyQuality(makeEnvelope({
    assistant_message: { role: 'assistant', format: 'text', content: '目前暂无购买入口，我可以先给替代方案。' },
    cards: [
      {
        card_id: 'offers1',
        type: 'offers_resolved',
        payload: {
          'items[0].offer': null,
        },
      },
    ],
  }));
  const goodCheck = getCheck(good, 'offers_null_no_stock_assertion');
  assert.equal(Boolean(goodCheck && goodCheck.passed), true);
});
