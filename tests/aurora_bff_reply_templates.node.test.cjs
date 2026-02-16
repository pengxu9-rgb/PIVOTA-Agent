const test = require('node:test');
const assert = require('node:assert/strict');

const { applyReplyTemplates } = require('../src/auroraBff/replyTemplates');

function makeEnvelope(overrides = {}) {
  return {
    request_id: 'req_tpl',
    trace_id: 'trace_tpl',
    assistant_message: null,
    suggested_chips: [],
    cards: [],
    session_patch: {},
    events: [],
    ...overrides,
  };
}

function questionMarkCount(text) {
  return (String(text || '').match(/[?？]/g) || []).length;
}

function bulletCount(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => /^\s*([-*]|\d+\.)\s+/.test(line.trim())).length;
}

test('replyTemplates: pending clarification skinType asks exactly one question and emits bounded chips', () => {
  const envelope = makeEnvelope({
    session_patch: {
      next_state: 'RECO_GATE',
      state: {
        pending_clarification: {
          v: 1,
          current: { id: 'skinType', norm_id: 'skinType' },
          queue: [],
          history: [],
        },
      },
    },
  });

  const out = applyReplyTemplates({ envelope, ctx: { lang: 'CN' } });
  const content = out && out.assistant_message ? out.assistant_message.content : '';
  const chips = Array.isArray(out && out.suggested_chips) ? out.suggested_chips : [];

  assert.equal(questionMarkCount(content), 1);
  assert.ok(chips.length >= 4 && chips.length <= 10);
  assert.equal(
    chips.some((chip) => chip && chip.kind === 'quick_reply' && chip.data && chip.data.norm_id === 'skinType'),
    true,
  );
  assert.equal(
    chips.some((chip) => chip && chip.data && String(chip.data.value || '').toLowerCase() === 'unknown'),
    true,
  );
});

test('replyTemplates: env_stress renders markdown with bullet budget', () => {
  const envelope = makeEnvelope({
    cards: [{ card_id: 'env_1', type: 'env_stress', payload: { ess: 61, tier: 'high' } }],
  });

  const out = applyReplyTemplates({ envelope, ctx: { lang: 'CN' } });
  const msg = out && out.assistant_message ? out.assistant_message : null;
  const content = msg ? msg.content : '';

  assert.equal(msg && msg.format, 'markdown');
  assert.ok(bulletCount(content) <= 6);
  assert.ok(String(content || '').length <= 520);
});

test('replyTemplates: recommendations enforce RECO_RESULTS with actionable next-step chips', () => {
  const envelope = makeEnvelope({
    cards: [
      {
        card_id: 'reco_1',
        type: 'recommendations',
        payload: {
          recommendations_count: 1,
          recommendations: [{ offer: { affiliate_url: 'https://example.com/buy' } }],
        },
      },
    ],
    session_patch: {
      next_state: 'S7_PRODUCT_RECO',
      profile: {
        skinType: 'oily',
        sensitivity: 'medium',
        barrierStatus: 'stable',
        goals: ['acne'],
      },
    },
  });

  const out = applyReplyTemplates({ envelope, ctx: { lang: 'CN' } });
  const msgContent = String(out && out.assistant_message ? out.assistant_message.content : '');
  const chips = Array.isArray(out && out.suggested_chips) ? out.suggested_chips : [];
  const actionChips = chips.filter((chip) => chip && chip.kind === 'action');

  assert.equal(out && out.session_patch && out.session_patch.next_state, 'RECO_RESULTS');
  assert.equal(/下一步|next/i.test(msgContent), true);
  assert.ok(actionChips.length >= 2);
});

test('replyTemplates: no-photo analysis includes explicit no-photo boundary text', () => {
  const envelope = makeEnvelope({
    cards: [
      {
        card_id: 'analysis_1',
        type: 'analysis_summary',
        payload: {
          used_photos: false,
          photos_provided: false,
          low_confidence: true,
        },
      },
    ],
  });

  const out = applyReplyTemplates({ envelope, ctx: { lang: 'CN' } });
  const content = String(out && out.assistant_message ? out.assistant_message.content : '');

  assert.equal(/没有可用照片|no usable photos/i.test(content), true);
});
