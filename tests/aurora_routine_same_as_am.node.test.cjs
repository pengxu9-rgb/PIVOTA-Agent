const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

const { __internal } = require('../src/auroraBff/routes');

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
