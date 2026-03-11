const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED = 'true';

const { __internal, mountAuroraBffRoutes } = require('../src/auroraBff/routes');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });
  return app;
}

test('normalizeRoutineInputWithPmShortcut copies AM steps into PM when pm_same_as_am is true', () => {
  const input = {
    am: [
      { step: 'cleanser', product: 'Biotherm Force Cleanser' },
      { step: 'moisturizer', product: 'Biotherm Aquasource Hydra Barrier Cream' },
    ],
    pm_same_as_am: true,
  };

  const normalized = __internal.normalizeRoutineInputWithPmShortcut(input);

  assert.ok(normalized && typeof normalized === 'object');
  assert.deepEqual(normalized.pm, input.am);
  assert.deepEqual(normalized.pm_steps, input.am);
});

test('normalizeRoutineInputWithPmShortcut does not override explicit PM steps', () => {
  const input = {
    am: [{ step: 'cleanser', product: 'Biotherm Force Cleanser' }],
    pm: [{ step: 'treatment', product: 'Azelaic Acid 10%' }],
    pm_same_as_am: true,
  };

  const normalized = __internal.normalizeRoutineInputWithPmShortcut(input);

  assert.ok(normalized && typeof normalized === 'object');
  assert.deepEqual(normalized.pm, input.pm);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'pm_steps'), false);
});

test('normalizeRoutineInputWithPmShortcut supports string payload with pm="same_as_am"', () => {
  const input = JSON.stringify({
    am: [{ step: 'cleanser', product: 'Biotherm Force Cleanser' }],
    pm: 'same_as_am',
  });

  const normalized = __internal.normalizeRoutineInputWithPmShortcut(input);

  assert.ok(normalized && typeof normalized === 'object');
  assert.ok(Array.isArray(normalized.pm));
  assert.equal(normalized.pm.length, 1);
  assert.equal(normalized.pm[0].product, 'Biotherm Force Cleanser');
});

test('/v1/routine/simulate copies AM into PM before simulation and heatmap generation', async () => {
  const response = await supertest(createApp())
    .post('/v1/routine/simulate')
    .set('X-Aurora-UID', 'uid_routine_same_as_am')
    .set('X-Trace-ID', 'trace_routine_same_as_am')
    .set('X-Brief-ID', 'brief_routine_same_as_am')
    .set('X-Lang', 'EN')
    .send({
      routine: {
        am: [{ key_actives: ['retinol'], step: 'Treatment' }],
        pm: 'same_as_am',
      },
      test_product: { key_actives: ['glycolic acid'], name: 'Test Acid' },
    })
    .expect(200);

  const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
  const simulation = cards.find((card) => card && card.type === 'routine_simulation');
  const heatmap = cards.find((card) => card && card.type === 'conflict_heatmap');

  assert.ok(simulation);
  assert.equal(simulation?.payload?.analysis_ready, true);
  assert.ok(heatmap);
  assert.equal(heatmap?.payload?.axes?.rows?.items?.length, 3);
  assert.equal(heatmap.payload.axes.rows.items[0]?.label_i18n?.en, 'AM Treatment');
  assert.equal(heatmap.payload.axes.rows.items[1]?.label_i18n?.en, 'PM Treatment');
  assert.equal(heatmap.payload.axes.rows.items[2]?.label_i18n?.en, 'TEST Test Acid');
});
