const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';

const {
  shouldDiagnosisGate,
  buildDiagnosisChips,
  recommendationsAllowed,
  stateChangeAllowed,
  stripRecommendationCards,
} = require('../src/auroraBff/gating');
const { simulateConflicts } = require('../src/auroraBff/routineRules');
const { auroraChat } = require('../src/auroraBff/auroraDecisionClient');

test('Phase0 gate: no recos when profile is missing', async () => {
  const gate = shouldDiagnosisGate({
    message: 'Please recommend a moisturizer',
    triggerSource: 'text_explicit',
    profile: null,
  });
  assert.equal(gate.gated, true);
  assert.ok(gate.missing.includes('skinType'));

  const chips = buildDiagnosisChips('EN', gate.missing);
  assert.ok(chips.some((c) => String(c.chip_id).startsWith('profile.skinType.')));
});

test('Recommendation gate: strips recommendation cards unless explicit', async () => {
  const filtered = stripRecommendationCards([
    { type: 'recommendations', payload: {} },
    { type: 'offers_resolved', payload: {} },
    { type: 'info', payload: { ok: true } },
  ]);
  assert.equal(filtered.some((c) => c.type === 'recommendations'), false);
  assert.equal(filtered.some((c) => c.type === 'offers_resolved'), false);
  assert.equal(filtered.some((c) => c.type === 'info'), true);
});

test('Routine simulate: detects retinoid x acids conflict', async () => {
  const sim = simulateConflicts({
    routine: { pm: [{ key_actives: ['retinol'] }] },
    testProduct: { key_actives: ['glycolic acid'] },
  });
  assert.equal(sim.safe, false);
  assert.equal(sim.conflicts.some((c) => c.rule_id === 'retinoid_x_acids'), true);
});

test('Aurora mock: returns recommendations card (for offline gating tests)', async () => {
  const resp = await auroraChat({ baseUrl: '', query: 'Hello' });
  assert.ok(resp);
  assert.equal(Array.isArray(resp.cards), true);
  assert.equal(resp.cards.some((c) => String(c.type).includes('recommend')), true);
});

test('Recommendation gate: does not unlock commerce for diagnosis chip', async () => {
  assert.equal(
    recommendationsAllowed({ triggerSource: 'chip', actionId: 'chip.start.diagnosis', message: 'Start skin diagnosis' }),
    false,
  );
  assert.equal(
    recommendationsAllowed({ triggerSource: 'chip', actionId: 'chip.start.routine', message: 'Build an AM/PM routine' }),
    true,
  );
  assert.equal(
    recommendationsAllowed({ triggerSource: 'text_explicit', actionId: null, message: 'Start skin diagnosis' }),
    false,
  );
  assert.equal(
    recommendationsAllowed({ triggerSource: 'text_explicit', actionId: null, message: 'Recommend a moisturizer' }),
    true,
  );
  assert.equal(stateChangeAllowed('text_explicit'), true);
});

test('/v1/chat: Start diagnosis chip enters diagnosis flow (no upstream loop)', async () => {
  const express = require('express');
  const request = require('supertest');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await request(app)
    .post('/v1/chat')
    .set('X-Aurora-UID', 'test_uid')
    .set('X-Trace-ID', 'test_trace')
    .set('X-Brief-ID', 'test_brief')
    .send({
      action: { action_id: 'chip.start.diagnosis', kind: 'chip', data: { reply_text: 'Start skin diagnosis' } },
      session: { state: 'idle' },
      language: 'EN',
    });

  assert.equal(resp.status, 200);
  assert.equal(typeof resp.body?.assistant_message?.content, 'string');
  assert.match(resp.body.assistant_message.content, /quick skin profile/i);
  assert.equal(Array.isArray(resp.body?.suggested_chips), true);
  assert.ok(resp.body.suggested_chips.some((c) => String(c.chip_id).startsWith('profile.skinType.')));
  assert.ok(resp.body.suggested_chips.every((c) => !String(c.chip_id).startsWith('chip.clarify.next.')));
});
