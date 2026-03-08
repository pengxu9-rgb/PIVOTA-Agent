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

test('replyTemplates: rich travel reply is preserved under env template and not clamped to legacy limits', () => {
  const richText = [
    'Home region: San Francisco -> Destination: Tokyo (2026-03-12 -> 2026-03-17)',
    '',
    'Daily forecast:',
    '- 2026-03-12 · 6C to 14C · Cloudy',
    '- 2026-03-13 · 5C to 13C · Rain',
    '',
    'Adjusted routine guidance:',
    ...Array.from({ length: 10 }).map(
      (_, idx) =>
        `- Step ${idx + 1}: keep hydration-first routine and avoid aggressive actives until skin is stable after travel transitions.`,
    ),
    '',
    'Flight day plan:',
    '- Before boarding: moisturizer + lip protection.',
    '- On flight: avoid strong acids and reapply lip balm.',
    '- First 48 hours: barrier mode before reintroducing actives.',
  ].join('\n');

  const envelope = makeEnvelope({
    assistant_message: { role: 'assistant', format: 'markdown', content: richText },
    cards: [{ card_id: 'env_2', type: 'env_stress', payload: { ess: 66, tier: 'high' } }],
  });

  const out = applyReplyTemplates({ envelope, ctx: { lang: 'EN' } });
  const msg = out && out.assistant_message ? out.assistant_message : null;
  const content = String(msg && msg.content ? msg.content : '');

  assert.equal(msg && msg.format, 'markdown');
  assert.match(content, /Daily forecast:/i);
  assert.match(content, /Flight day plan:/i);
  assert.ok(bulletCount(content) > 6);
  assert.ok(bulletCount(content) <= 40);
  assert.ok(content.length > 520);
  assert.ok(content.length <= 3200);
});

test('replyTemplates: rich travel reply uses expanded 3200-char and 40-bullet limits', () => {
  const richLongText = [
    'Home region: SF -> Destination: Tokyo',
    'Daily forecast:',
    ...Array.from({ length: 60 }).map(
      (_, idx) =>
        `- Checklist ${idx + 1}: keep hydration, barrier recovery, sunscreen reapply, and simplify active cadence to reduce irritation risk during travel.`,
    ),
    'Quick troubleshooting:',
    '- Tight/stinging: pause actives for 2-3 nights.',
  ].join('\n');

  const envelope = makeEnvelope({
    assistant_message: { role: 'assistant', format: 'markdown', content: richLongText },
    cards: [{ card_id: 'env_3', type: 'env_stress', payload: { ess: 70, tier: 'high' } }],
  });

  const out = applyReplyTemplates({ envelope, ctx: { lang: 'EN' } });
  const content = String(out?.assistant_message?.content || '');

  assert.ok(bulletCount(content) <= 40);
  assert.ok(content.length <= 3200);
  assert.match(content, /Daily forecast:/i);
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

test('replyTemplates: empty recommendations card does not select recommendations template', () => {
  const envelope = makeEnvelope({
    assistant_message: { role: 'assistant', format: 'text', content: 'Fallback guidance.' },
    cards: [
      {
        card_id: 'reco_empty',
        type: 'recommendations',
        payload: {
          recommendations: [],
          warnings: ['upstream empty'],
        },
      },
    ],
    session_patch: {
      next_state: 'S7_PRODUCT_RECO',
    },
  });

  const out = applyReplyTemplates({ envelope, ctx: { lang: 'EN' } });
  assert.equal(String(out?.assistant_message?.content || ''), 'Fallback guidance.');
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

test('replyTemplates: ingredient query-first cards keep default template and avoid diagnosis clarification injection', () => {
  const baseMessage = 'Ingredient path stays query-first.';
  const envelope = makeEnvelope({
    assistant_message: { role: 'assistant', format: 'text', content: baseMessage },
    cards: [{ card_id: 'ing_hub_1', type: 'ingredient_hub', payload: { mode: 'query_first' } }],
    session_patch: {
      meta: {
        ingredient_query_first_applied: true,
        ingredient_route_source: 'text',
      },
    },
  });

  const out = applyReplyTemplates({ envelope, ctx: { lang: 'EN' } });
  const content = String(out?.assistant_message?.content || '');
  const chips = Array.isArray(out?.suggested_chips) ? out.suggested_chips : [];
  const hasDiagnosisNormChip = chips.some(
    (chip) => chip && chip.data && String(chip.data.norm_id || '').toLowerCase() === 'skintype',
  );

  assert.equal(content, baseMessage);
  assert.equal(hasDiagnosisNormChip, false);
});

test('replyTemplates: diagnosis clarification is still applied only when diagnosis_gate exists', () => {
  const envelope = makeEnvelope({
    cards: [
      {
        card_id: 'diag_gate_1',
        type: 'diagnosis_gate',
        payload: { missing_fields: ['skinType'] },
      },
    ],
    session_patch: {
      meta: { ingredient_query_first_applied: true },
    },
  });

  const out = applyReplyTemplates({ envelope, ctx: { lang: 'EN' } });
  const content = String(out?.assistant_message?.content || '');
  const chips = Array.isArray(out?.suggested_chips) ? out.suggested_chips : [];
  const hasSkinTypeChip = chips.some(
    (chip) => chip && chip.data && String(chip.data.norm_id || '').toLowerCase() === 'skintype',
  );

  assert.equal(/[?？]/.test(content), true);
  assert.equal(hasSkinTypeChip, true);
});
