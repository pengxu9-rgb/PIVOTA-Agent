'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRoutineStateValue,
  normalizeRoutineStateFromProfile,
} = require('../src/auroraBff/routineState');

test('normalizeRoutineStateValue: keeps plain-text routine as text candidate', () => {
  const state = normalizeRoutineStateValue('AM gentle cleanser + SPF; PM retinol + moisturizer');
  assert.equal(state.has_current_routine, true);
  assert.equal(state.source_shape, 'plain_text');
  assert.equal(typeof state.current_routine_text, 'string');
  assert.equal(state.current_routine_struct, null);
  assert.deepEqual(state.missing_routine_fields, ['currentRoutine.am', 'currentRoutine.pm']);
});

test('normalizeRoutineStateValue: normalizes AM/PM object into v2 struct', () => {
  const state = normalizeRoutineStateValue({
    am: { cleanser: 'Gentle cleanser', spf: 'SPF 50' },
    pm: { cleanser: 'Gentle cleanser', treatment: 'Retinol serum' },
  });
  assert.equal(state.has_current_routine, true);
  assert.equal(state.source_shape, 'am_pm_object');
  assert.equal(state.current_routine_struct?.schema_version, 'aurora.routine_intake.v2');
  assert.equal(Array.isArray(state.current_routine_struct?.am), true);
  assert.equal(Array.isArray(state.current_routine_struct?.pm), true);
  assert.deepEqual(state.missing_routine_fields, []);
});

test('normalizeRoutineStateValue: normalizes array routine into v2 struct', () => {
  const state = normalizeRoutineStateValue([
    { slot: 'am', step: 'cleanser', product: 'Gentle cleanser' },
    { slot: 'pm', step: 'treatment', product: 'Retinol serum' },
  ]);
  assert.equal(state.has_current_routine, true);
  assert.equal(state.source_shape, 'array');
  assert.equal(state.current_routine_struct?.schema_version, 'aurora.routine_intake.v2');
  assert.equal(state.current_routine_struct?.am?.[0]?.product, 'Gentle cleanser');
  assert.equal(state.current_routine_struct?.pm?.[0]?.product, 'Retinol serum');
});

test('normalizeRoutineStateFromProfile: accepts current_routine legacy alias', () => {
  const state = normalizeRoutineStateFromProfile({
    current_routine: JSON.stringify({
      am: [{ step: 'cleanser', product: 'Gentle cleanser' }],
      pm: [{ step: 'moisturizer', product: 'Barrier cream' }],
    }),
  });
  assert.equal(state.has_current_routine, true);
  assert.equal(state.source_shape, 'json_object_string');
  assert.equal(state.current_routine_struct?.schema_version, 'aurora.routine_intake.v2');
});
