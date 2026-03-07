'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCurrentRoutineToV2,
  normalizeStep,
  SCHEMA_VERSION,
} = require('../src/auroraBff/routineSchemaV2');

// ---------------------------------------------------------------------------
// normalizeStep
// ---------------------------------------------------------------------------

test('normalizeStep: valid entry', () => {
  const result = normalizeStep({ step: 'Cleanser', product: 'CeraVe' });
  assert.deepEqual(result, { step: 'cleanser', product: 'CeraVe' });
});

test('normalizeStep: preserves product_id and sku_id', () => {
  const result = normalizeStep({ step: 'spf', product: 'SPF 50', product_id: 'P1', sku_id: 'S1' });
  assert.deepEqual(result, { step: 'spf', product: 'SPF 50', product_id: 'P1', sku_id: 'S1' });
});

test('normalizeStep: null for missing step', () => {
  assert.equal(normalizeStep({ step: '', product: 'X' }), null);
});

test('normalizeStep: null for missing product', () => {
  assert.equal(normalizeStep({ step: 'cleanser', product: '' }), null);
});

test('normalizeStep: null for non-object', () => {
  assert.equal(normalizeStep(null), null);
  assert.equal(normalizeStep('string'), null);
  assert.equal(normalizeStep(42), null);
});

// ---------------------------------------------------------------------------
// normalizeCurrentRoutineToV2 — null / undefined
// ---------------------------------------------------------------------------

test('normalizeCurrentRoutineToV2: null → null', () => {
  assert.equal(normalizeCurrentRoutineToV2(null), null);
});

test('normalizeCurrentRoutineToV2: undefined → null', () => {
  assert.equal(normalizeCurrentRoutineToV2(undefined), null);
});

// ---------------------------------------------------------------------------
// normalizeCurrentRoutineToV2 — legacy string enums
// ---------------------------------------------------------------------------

test('normalizeCurrentRoutineToV2: "none" → null', () => {
  assert.equal(normalizeCurrentRoutineToV2('none'), null);
});

test('normalizeCurrentRoutineToV2: "basic" → null', () => {
  assert.equal(normalizeCurrentRoutineToV2('basic'), null);
});

test('normalizeCurrentRoutineToV2: "full" → null', () => {
  assert.equal(normalizeCurrentRoutineToV2('full'), null);
});

test('normalizeCurrentRoutineToV2: empty string → null', () => {
  assert.equal(normalizeCurrentRoutineToV2(''), null);
});

test('normalizeCurrentRoutineToV2: "FULL" (case insensitive) → null', () => {
  assert.equal(normalizeCurrentRoutineToV2('FULL'), null);
});

// ---------------------------------------------------------------------------
// normalizeCurrentRoutineToV2 — JSON string of an object
// ---------------------------------------------------------------------------

test('normalizeCurrentRoutineToV2: JSON string of v1 object → v2', () => {
  const json = JSON.stringify({
    schema_version: 'aurora.routine_intake.v1',
    am: [{ step: 'cleanser', product: 'X' }],
    pm: [],
  });
  const result = normalizeCurrentRoutineToV2(json);
  assert.equal(result.schema_version, SCHEMA_VERSION);
  assert.equal(result.am.length, 1);
  assert.equal(result.am[0].product, 'X');
});

test('normalizeCurrentRoutineToV2: non-JSON string → null', () => {
  assert.equal(normalizeCurrentRoutineToV2('some random text'), null);
});

// ---------------------------------------------------------------------------
// normalizeCurrentRoutineToV2 — bare object (no schema_version)
// ---------------------------------------------------------------------------

test('normalizeCurrentRoutineToV2: bare { am, pm } → adds schema_version v2', () => {
  const result = normalizeCurrentRoutineToV2({
    am: [{ step: 'cleanser', product: 'CeraVe' }],
    pm: [{ step: 'treatment', product: 'Retinol' }],
  });
  assert.equal(result.schema_version, SCHEMA_VERSION);
  assert.equal(result.am.length, 1);
  assert.equal(result.pm.length, 1);
});

test('normalizeCurrentRoutineToV2: bare empty { am: [], pm: [] } → null', () => {
  assert.equal(normalizeCurrentRoutineToV2({ am: [], pm: [] }), null);
});

// ---------------------------------------------------------------------------
// normalizeCurrentRoutineToV2 — v1 object
// ---------------------------------------------------------------------------

test('normalizeCurrentRoutineToV2: v1 schema → upgraded to v2', () => {
  const result = normalizeCurrentRoutineToV2({
    schema_version: 'aurora.routine_intake.v1',
    am: [{ step: 'Cleanser', product: 'La Roche-Posay' }],
    pm: [{ step: 'Treatment', product: 'Tretinoin 0.05%' }],
  });
  assert.equal(result.schema_version, SCHEMA_VERSION);
  assert.equal(result.am[0].step, 'cleanser');
  assert.equal(result.pm[0].step, 'treatment');
});

test('normalizeCurrentRoutineToV2: v1 with notes → preserved in v2', () => {
  const result = normalizeCurrentRoutineToV2({
    schema_version: 'aurora.routine_intake.v1',
    am: [{ step: 'spf', product: 'Anessa' }],
    pm: [],
    notes: 'Sheet mask on weekends',
  });
  assert.equal(result.schema_version, SCHEMA_VERSION);
  assert.equal(result.notes, 'Sheet mask on weekends');
});

// ---------------------------------------------------------------------------
// normalizeCurrentRoutineToV2 — already v2
// ---------------------------------------------------------------------------

test('normalizeCurrentRoutineToV2: v2 → returned as-is (with step normalization)', () => {
  const input = {
    schema_version: 'aurora.routine_intake.v2',
    am: [{ step: 'cleanser', product: 'CeraVe', product_id: 'P1' }],
    pm: [],
    notes: 'Added retinol',
  };
  const result = normalizeCurrentRoutineToV2(input);
  assert.equal(result.schema_version, SCHEMA_VERSION);
  assert.equal(result.am[0].product_id, 'P1');
  assert.equal(result.notes, 'Added retinol');
});

test('normalizeCurrentRoutineToV2: v2 empty am/pm with notes → kept', () => {
  const result = normalizeCurrentRoutineToV2({
    schema_version: 'aurora.routine_intake.v2',
    am: [],
    pm: [],
    notes: 'Only masks',
  });
  assert.notEqual(result, null);
  assert.equal(result.notes, 'Only masks');
});

test('normalizeCurrentRoutineToV2: v2 all empty → null', () => {
  assert.equal(
    normalizeCurrentRoutineToV2({
      schema_version: 'aurora.routine_intake.v2',
      am: [],
      pm: [],
      notes: '',
    }),
    null,
  );
});

// ---------------------------------------------------------------------------
// normalizeCurrentRoutineToV2 — edge cases
// ---------------------------------------------------------------------------

test('normalizeCurrentRoutineToV2: array → null', () => {
  assert.equal(normalizeCurrentRoutineToV2([1, 2, 3]), null);
});

test('normalizeCurrentRoutineToV2: number → null', () => {
  assert.equal(normalizeCurrentRoutineToV2(42), null);
});

test('normalizeCurrentRoutineToV2: boolean → null', () => {
  assert.equal(normalizeCurrentRoutineToV2(true), null);
});

test('normalizeCurrentRoutineToV2: object with no am/pm → null', () => {
  assert.equal(normalizeCurrentRoutineToV2({ foo: 'bar' }), null);
});

test('normalizeCurrentRoutineToV2: filters invalid step entries from am/pm', () => {
  const result = normalizeCurrentRoutineToV2({
    am: [
      { step: 'cleanser', product: 'CeraVe' },
      null,
      'invalid',
      { step: '', product: 'X' },
      { step: 'spf', product: 'SPF 50' },
    ],
    pm: [],
  });
  assert.equal(result.am.length, 2);
  assert.equal(result.am[0].product, 'CeraVe');
  assert.equal(result.am[1].product, 'SPF 50');
});

test('normalizeCurrentRoutineToV2: object-map am/pm { step: product } → converted to array', () => {
  const result = normalizeCurrentRoutineToV2({
    am: { cleanser: 'CeraVe', spf: 'SPF 50', serum: 'Vitamin C' },
    pm: { cleanser: 'CeraVe', treatment: 'Retinol' },
  });
  assert.equal(result.schema_version, SCHEMA_VERSION);
  assert.equal(result.am.length, 3);
  assert.equal(result.pm.length, 2);
  assert.ok(result.am.some((s) => s.step === 'cleanser' && s.product === 'CeraVe'));
  assert.ok(result.am.some((s) => s.step === 'spf' && s.product === 'SPF 50'));
  assert.ok(result.pm.some((s) => s.step === 'treatment' && s.product === 'Retinol'));
});

test('normalizeCurrentRoutineToV2: mixed object-map with empty values → filters empties', () => {
  const result = normalizeCurrentRoutineToV2({
    am: { cleanser: 'CeraVe', spf: '' },
    pm: {},
  });
  assert.equal(result.am.length, 1);
  assert.equal(result.am[0].product, 'CeraVe');
});

test('normalizeCurrentRoutineToV2: whitespace-only notes → treated as empty', () => {
  const result = normalizeCurrentRoutineToV2({
    am: [{ step: 'c', product: 'X' }],
    pm: [],
    notes: '   ',
  });
  assert.equal(result.schema_version, SCHEMA_VERSION);
  assert.equal(result.notes, undefined);
});
